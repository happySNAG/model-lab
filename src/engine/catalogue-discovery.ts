// Benchmark engine · CATALOGUE DISCOVERY for the two Claude routes and the Codex CLI (ccd1): what each
// provider's own listing names, recorded as LISTED and UNPROVEN, and — for the one that has no listing —
// the fact that it has none, recorded as a value.
//
// THREE PROVIDERS, THREE DIFFERENT ANSWERS, and none of them is allowed to look like another.
//
//   codexCLI      `codex debug models` renders the client's model catalogue as JSON. It is read with the
//                 existing `parseCodexCatalogue` and every row is recorded with source `catalogue`. A
//                 catalogue is what the CLIENT knows about, not what the ACCOUNT may invoke: the service
//                 refuses identifiers that are in it. So a row is discovered and nothing more.
//   claudeCLI     `claude` documents no model-listing command in any form. That is recorded as the
//                 outcome `cannotList`, with the reason, and the CLI is NOT RUN to find that out again.
//                 An empty listing would say "this account has no models", which is false; `cannotList`
//                 says "this tool cannot tell you", which is true.
//   anthropicAPI  `/v1/models`, answered with the account's own key, is an account-scoped listing — better
//                 evidence than a client catalogue and still not a reply from a model. It is consulted
//                 ONLY when `credentials.ts` already reports a configured credential. This module never
//                 adds, stores, prints or changes one: it asks `credentialStatus` whether one is present
//                 and records only WHERE it was found. A missing credential is the outcome `notConsulted`,
//                 and the listing is never called.
//
// DISCOVERED, REACHABLE AND QUALIFIED ARE THREE FIELDS ON EVERY ROW, and none is derived from another.
//
//   discovered    a listing named it. Always `listed` on a row here; the source says which listing.
//   reachable     whether a request to it came back naming it. A listing never establishes this, so it
//                 is `unproven` unless a smoke result is supplied for that exact route key.
//   qualified     whether benchmark evidence says it can do the work (`route-qualification.ts`, cqp1).
//                 `notEvaluated` unless a qualification verdict is supplied for that exact route key.
//
// A supplied smoke result never moves `qualified`, and a supplied verdict never moves `reachable`. Nothing
// is read from a model's name: not availability, not capability, not price.
//
// OFFLINE BY CONSTRUCTION in its core. `discoverCatalogues` takes its two readers as arguments and runs
// nothing itself; `defaultCatalogueReaders` builds the real ones (one CLI subcommand, one HTTP listing)
// for a caller that has been authorised to use them. Local Ollama discovery is not here and is unchanged.

import { findExecutable, runCLI, CLIResult } from './cli-process';
import { parseCodexCatalogue } from './codex-cli';
import { CredentialLookupOptions, CredentialSource, credentialStatus } from './credentials';
import { DiscoveryProbe, RouteObservation } from './discovery-refresh';
import { DESIRED_CANDIDATE_LADDER, ProviderStatus, discoverMeteredProvider } from './discovery';
import { anthropicBaseURL } from './host-factory';
import { Known, known, unknown } from './model-description';
import { ProviderID } from './provider';
import {
  DEFAULT_PROVIDER_ALLOWLIST, ProviderAllowlist, isProviderAllowed, providerAllowlistRefusal,
} from './provider-allowlist';
import { redactSecrets } from './redaction';
import { CapabilityVerdict } from './route-qualification';

export const CATALOGUE_DISCOVERY_SCHEMA = 'ccd1' as const;

/** The providers this module discovers. Ollama has its own discovery and is deliberately absent. */
export const CATALOGUE_PROVIDERS = ['anthropicAPI', 'claudeCLI', 'codexCLI'] as const satisfies readonly ProviderID[];
export type CatalogueProvider = typeof CATALOGUE_PROVIDERS[number];

/** The subcommand that renders Codex's catalogue. Read-only; reaches no model. */
export const CODEX_CATALOGUE_ARGUMENTS = ['debug', 'models'] as const;

/**
 * Which kind of listing named a row.
 *
 * `catalogue` is client-side: what the tool knows about. `accountListing` is answered by the provider for
 * this account's credential: what it advertises to that account. Neither is a reply from a model.
 */
export type ListingSource = 'catalogue' | 'accountListing';

export const CLAUDE_CLI_CANNOT_LIST_MODELS =
  '`claude` documents no model-listing command in any form, so which models this subscription may call cannot be '
  + 'listed. This is a property of the tool, not an empty listing: it does not mean the account has no models. '
  + 'The CLI was not run to establish this again. A model reaches this route only by being named and then answering '
  + 'an identity smoke test.';

export const CODEX_CATALOGUE_IS_NOT_ENTITLEMENT =
  '`codex debug models` is the client\'s catalogue, not this account\'s entitlement: the service refuses identifiers '
  + 'that appear in it. Every row is DISCOVERED and UNPROVEN, and `codex exec` never names the model that answered, '
  + 'so even a successful smoke leaves identity unverifiable.';

export const ACCOUNT_LISTING_IS_NOT_EXECUTION =
  'The Anthropic API listed the identifiers it advertises to the configured credential. That is not a reply from a '
  + 'model: an advertised identifier can still be refused at call time for tier, region, retirement or moderation. '
  + 'Every row is DISCOVERED and UNPROVEN.';

export const LISTING_DOES_NOT_REACH = 'a listing named this route; no request to it has come back naming it';
export const LISTING_DOES_NOT_QUALIFY = 'discovery never qualifies a route; no qualification verdict was supplied for it';

/** Whether a request to this route came back naming it. Only a smoke result moves it off `unproven`. */
export type ReachableState =
  | { state: 'unproven'; reason: string }
  | { state: 'proven' | 'refused'; source: string; observedAt?: string };

/** Whether benchmark evidence says this route can do the work. Only a qualification verdict moves it. */
export type QualifiedState =
  | { state: 'notEvaluated'; reason: string }
  | { state: CapabilityVerdict; source: string; observedAt?: string };

export interface CatalogueDiscoveryRow {
  routeKey: string;
  provider: CatalogueProvider;
  modelID: string;
  /** The name the listing published. Absent when it published none; never made up from the id. */
  displayName: Known<string>;
  source: ListingSource;
  discovered: { state: 'listed'; source: ListingSource; observedAt: string; detail: string };
  reachable: ReachableState;
  qualified: QualifiedState;
  /** The effort levels the listing declares, as the listing's claim. Unknown when it declares none. */
  declaredEfforts: Known<string[]>;
}

/** What happened when one provider was asked, or why it was not. */
export type ProviderCatalogueOutcome =
  | {
    provider: CatalogueProvider; state: 'listed'; source: ListingSource; probe: 'invoked'; observedAt: string;
    detail: string; routeKeys: string[];
    /** Entries the listing carried that are not candidates (Codex `visibility: hide`), each with why. */
    omitted: { modelID: string; reason: string }[];
    /** Where the credential that answered was found. Present for anthropicAPI only. Never a value. */
    credentialSource?: Exclude<CredentialSource, 'absent'>;
  }
  /** The provider's tool has no listing at all. claudeCLI. Nothing was run. */
  | { provider: CatalogueProvider; state: 'cannotList'; probe: 'offline'; detail: string }
  /** Not asked: no configured credential, or not on the provider allowlist. Nothing was sent. */
  | { provider: CatalogueProvider; state: 'notConsulted'; probe: 'offline'; detail: string; refusedByAllowlist?: string }
  /** Asked, and no usable listing came back. Recorded, never thrown. */
  | { provider: CatalogueProvider; state: 'notAnswered'; probe: 'invoked'; detail: string };

export interface CatalogueDiscoveryReport {
  schema: typeof CATALOGUE_DISCOVERY_SCHEMA;
  takenAt: string;
  providerAllowlist: string;
  /** One outcome per provider, sorted by provider. */
  providers: ProviderCatalogueOutcome[];
  /** Every listed row, sorted by route key. */
  rows: CatalogueDiscoveryRow[];
}

/** What a reader returns: the listing's text, or why there is none. */
export type CatalogueRead = { ok: true; text: string } | { ok: false; detail: string };

export interface CatalogueReaders {
  /** Returns the stdout of `codex debug models`. */
  readCodexCatalogue: () => Promise<CatalogueRead>;
  /**
   * Returns the anthropicAPI listing as discovery's own `ProviderStatus` (`discoverMeteredProvider`).
   * Called only after `credentialStatus` reported a configured credential.
   */
  listAnthropicModels: () => Promise<ProviderStatus>;
}

export interface CatalogueDiscoveryOptions {
  now: Date;
  readers: CatalogueReaders;
  /** Passed to `credentialStatus` unchanged. Injected in tests; nothing here writes through it. */
  credentials?: CredentialLookupOptions;
  allowlist?: ProviderAllowlist;
  /** Which providers to ask. All three by default. */
  providers?: readonly CatalogueProvider[];
  /** A recorded smoke result for an exact route key, when one exists. Never inferred. */
  reachability?: (routeKey: string) => Exclude<ReachableState, { state: 'unproven' }> | undefined;
  /** A recorded qualification verdict for an exact route key, when one exists. Never inferred. */
  qualification?: (routeKey: string) => Exclude<QualifiedState, { state: 'notEvaluated' }> | undefined;
}

function iso(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function row(options: CatalogueDiscoveryOptions, entry: {
  provider: CatalogueProvider; modelID: string; displayName?: string; source: ListingSource; observedAt: string;
  detail: string; efforts?: string[]; effortSource: string;
}): CatalogueDiscoveryRow {
  const routeKey = `${entry.provider}:${entry.modelID}`;
  return {
    routeKey,
    provider: entry.provider,
    modelID: entry.modelID,
    displayName: entry.displayName !== undefined && entry.displayName.length > 0
      ? known(entry.displayName, entry.source, entry.observedAt)
      : unknown('the listing published no display name for this identifier'),
    source: entry.source,
    discovered: { state: 'listed', source: entry.source, observedAt: entry.observedAt, detail: entry.detail },
    reachable: options.reachability?.(routeKey) ?? { state: 'unproven', reason: LISTING_DOES_NOT_REACH },
    qualified: options.qualification?.(routeKey) ?? { state: 'notEvaluated', reason: LISTING_DOES_NOT_QUALIFY },
    declaredEfforts: entry.efforts !== undefined && entry.efforts.length > 0
      ? known(entry.efforts, entry.effortSource, entry.observedAt)
      : unknown(`${entry.effortSource} declared no effort levels for this identifier`),
  };
}

async function discoverCodex(options: CatalogueDiscoveryOptions, observedAt: string):
  Promise<{ outcome: ProviderCatalogueOutcome; rows: CatalogueDiscoveryRow[] }> {
  let read: CatalogueRead;
  try {
    read = await options.readers.readCodexCatalogue();
  } catch (error) {
    read = { ok: false, detail: `the reader threw: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!read.ok) {
    return { outcome: { provider: 'codexCLI', state: 'notAnswered', probe: 'invoked',
      detail: `\`codex ${CODEX_CATALOGUE_ARGUMENTS.join(' ')}\` did not answer: ${redactSecrets(read.detail)}` }, rows: [] };
  }
  const entries = parseCodexCatalogue(read.text);
  if (entries.length === 0) {
    // A catalogue that does not parse, or parses to nothing, yields no rows: a partly-understood listing
    // is how a name nobody offered becomes a candidate.
    return { outcome: { provider: 'codexCLI', state: 'notAnswered', probe: 'invoked',
      detail: `\`codex ${CODEX_CATALOGUE_ARGUMENTS.join(' ')}\` answered, but its output carried no readable catalogue entry` }, rows: [] };
  }
  const omitted: { modelID: string; reason: string }[] = [];
  const rows: CatalogueDiscoveryRow[] = [];
  for (const entry of entries) {
    if (entry.visibility === 'hide') {
      omitted.push({ modelID: entry.modelID, reason: 'the catalogue marks it `visibility: hide`: an internal entry, not a candidate' });
      continue;
    }
    rows.push(row(options, {
      // `parseCodexCatalogue` falls back to the slug when no `display_name` was published; a slug is a name.
      provider: 'codexCLI', modelID: entry.modelID, source: 'catalogue', observedAt,
      displayName: entry.displayName !== entry.modelID ? entry.displayName : undefined,
      detail: `named by \`codex ${CODEX_CATALOGUE_ARGUMENTS.join(' ')}\` at ${observedAt}. ${CODEX_CATALOGUE_IS_NOT_ENTITLEMENT}`,
      efforts: entry.supportedEfforts, effortSource: 'the Codex catalogue',
    }));
  }
  return {
    outcome: {
      provider: 'codexCLI', state: 'listed', source: 'catalogue', probe: 'invoked', observedAt,
      detail: `the Codex catalogue named ${rows.length} candidate identifier(s) at ${observedAt}. ${CODEX_CATALOGUE_IS_NOT_ENTITLEMENT}`,
      routeKeys: rows.map((entry) => entry.routeKey).sort(compareText),
      omitted: omitted.sort((a, b) => compareText(a.modelID, b.modelID)),
    },
    rows,
  };
}

function ladderDisplayName(modelID: string): string | undefined {
  return DESIRED_CANDIDATE_LADDER.find((entry) => entry.provider === 'anthropicAPI' && entry.modelID === modelID)?.displayName;
}

async function discoverAnthropic(options: CatalogueDiscoveryOptions, observedAt: string):
  Promise<{ outcome: ProviderCatalogueOutcome; rows: CatalogueDiscoveryRow[] }> {
  // THE CREDENTIAL IS ASKED ABOUT, NOT TAKEN. `credentialStatus` reports presence and where; its value
  // never leaves `credentials.ts` through this module, and nothing here writes one.
  const credential = credentialStatus('anthropicAPI', options.credentials ?? {});
  if (!credential.present || credential.source === 'absent') {
    return { outcome: { provider: 'anthropicAPI', state: 'notConsulted', probe: 'offline',
      detail: `not consulted: no credential is configured for the Anthropic API (${credential.environmentVariable} is not `
        + `set and the Keychain service '${credential.keychainService}' holds nothing). Nothing was sent, and nothing `
        + 'about the credential was changed.' }, rows: [] };
  }
  let status: ProviderStatus;
  try {
    status = await options.readers.listAnthropicModels();
  } catch (error) {
    return { outcome: { provider: 'anthropicAPI', state: 'notAnswered', probe: 'invoked',
      detail: `the listing threw: ${redactSecrets(error instanceof Error ? error.message : String(error))}` }, rows: [] };
  }
  if (status.reachability !== 'ready') {
    return { outcome: { provider: 'anthropicAPI', state: 'notAnswered', probe: 'invoked',
      detail: `the Anthropic API listing did not answer (${status.reachability}): ${redactSecrets(status.detail)}` }, rows: [] };
  }
  // `parseModelListing` also emits a `refused` row for each ladder identifier the listing did NOT name.
  // That is a statement about the plan, not a listed model, so it is not a row here.
  const listed = status.models.filter((model) => model.availability !== 'refused');
  const rows = listed.map((model) => row(options, {
    provider: 'anthropicAPI', modelID: model.modelID,
    // The listing's own `display_name`, or nothing. `parseModelListing` falls back to the ladder's name and
    // then to the id; the first is the plan's and the second is a name, so neither is recorded as listed.
    displayName: model.displayName !== model.modelID && model.displayName !== ladderDisplayName(model.modelID)
      ? model.displayName : undefined,
    source: 'accountListing', observedAt,
    detail: `named by the Anthropic API model listing at ${observedAt}. ${ACCOUNT_LISTING_IS_NOT_EXECUTION}`,
    effortSource: 'the Anthropic API model listing',
  }));
  return {
    outcome: {
      provider: 'anthropicAPI', state: 'listed', source: 'accountListing', probe: 'invoked', observedAt,
      detail: `the Anthropic API listed ${rows.length} identifier(s) for the configured credential at ${observedAt}. `
        + ACCOUNT_LISTING_IS_NOT_EXECUTION,
      routeKeys: rows.map((entry) => entry.routeKey).sort(compareText),
      omitted: [],
      credentialSource: credential.source,
    },
    rows,
  };
}

/**
 * Ask each catalogue provider what it lists, and record the answer — or the absence of one — as a value.
 *
 * Never throws for a provider's failure: a reader that fails or throws is `notAnswered`. Runs nothing
 * itself: both readers are arguments.
 */
export async function discoverCatalogues(options: CatalogueDiscoveryOptions): Promise<CatalogueDiscoveryReport> {
  const takenAt = iso(options.now);
  const allowlist = options.allowlist ?? DEFAULT_PROVIDER_ALLOWLIST;
  const providers = [...new Set(options.providers ?? CATALOGUE_PROVIDERS)].sort(compareText);
  const outcomes: ProviderCatalogueOutcome[] = [];
  const rows: CatalogueDiscoveryRow[] = [];
  for (const provider of providers) {
    if (!isProviderAllowed(allowlist, provider)) {
      outcomes.push({ provider, state: 'notConsulted', probe: 'offline',
        detail: providerAllowlistRefusal(allowlist, provider), refusedByAllowlist: allowlist.version });
      continue;
    }
    if (provider === 'claudeCLI') {
      outcomes.push({ provider, state: 'cannotList', probe: 'offline', detail: CLAUDE_CLI_CANNOT_LIST_MODELS });
      continue;
    }
    const result = provider === 'codexCLI' ? await discoverCodex(options, takenAt) : await discoverAnthropic(options, takenAt);
    outcomes.push(result.outcome);
    rows.push(...result.rows);
  }
  return {
    schema: CATALOGUE_DISCOVERY_SCHEMA,
    takenAt,
    providerAllowlist: allowlist.version,
    providers: outcomes,
    rows: rows.sort((a, b) => compareText(a.routeKey, b.routeKey)),
  };
}

/**
 * One provider's outcome as a discovery-refresh probe, so a catalogue can feed `refreshDiscovery`.
 *
 * Only `listed` refreshes. `cannotList`, `notConsulted` and `notAnswered` re-observed nothing, so the
 * provider's earlier routes are carried forward untouched — never reported as `disappeared`.
 */
export function catalogueDiscoveryProbe(report: CatalogueDiscoveryReport, provider: CatalogueProvider): DiscoveryProbe {
  return async () => {
    const outcome = report.providers.find((entry) => entry.provider === provider);
    if (outcome === undefined) return { refreshed: false, detail: `${provider} was not asked in this catalogue discovery`, routes: [] };
    if (outcome.state !== 'listed') return { refreshed: false, detail: outcome.detail, routes: [] };
    const routes: RouteObservation[] = report.rows.filter((entry) => entry.provider === provider).map((entry) => ({
      routeKey: entry.routeKey, provider: entry.provider, modelID: entry.modelID, listed: true,
      availability: 'unproven' as const, observedAt: entry.discovered.observedAt,
    }));
    return { refreshed: true, detail: outcome.detail, routes };
  };
}

/** Read `codex debug models` with the real CLI. For an authorised caller; tests inject `run` and `findExecutable`. */
export function codexCatalogueReader(options: {
  findExecutable?: (name: string) => string | undefined;
  run?: (options: Parameters<typeof runCLI>[0]) => Promise<CLIResult>;
  timeoutMilliseconds?: number;
} = {}): () => Promise<CatalogueRead> {
  return async () => {
    const executable = (options.findExecutable ?? ((name: string) => findExecutable(name)))('codex');
    if (executable === undefined) return { ok: false, detail: '`codex` is not installed, so nothing was run' };
    const result = await (options.run ?? runCLI)({
      executable, args: [...CODEX_CATALOGUE_ARGUMENTS], timeoutMilliseconds: options.timeoutMilliseconds ?? 30_000,
    });
    return result.failure !== undefined ? { ok: false, detail: result.failure.detail } : { ok: true, text: result.stdout };
  };
}

/**
 * The real readers: one CLI subcommand and one account listing. Building them sends nothing; calling
 * them does, which is why `discoverCatalogues` is the only thing that does, and only for an authorised caller.
 */
export function defaultCatalogueReaders(options: { credentials?: CredentialLookupOptions; now?: () => Date } = {}): CatalogueReaders {
  return {
    readCodexCatalogue: codexCatalogueReader(),
    listAnthropicModels: () => discoverMeteredProvider('anthropicAPI', {
      baseURL: anthropicBaseURL(), ...(options.credentials === undefined ? {} : { credentials: options.credentials }),
      ...(options.now === undefined ? {} : { now: options.now }),
    }),
  };
}
