// Benchmark engine · THE STRUCTURED DESCRIPTION OF ONE ROUTE: what is known about a model, reached
// one way, from which source, as of when — and, as a first-class value, what is NOT known.
//
// WHY THIS EXISTS. Everything a router would need to read about a model was, until now, PROSE: the
// free pool's shape is a sentence ("reasoning, multi-step problem solving and tool use; 200k context"),
// a discovery row's meaning lives in `evidence`, and a price travels as a `source` string. Prose is
// the right place to explain a fact and the wrong place to STORE one, because a router that parsed
// "200k context" out of a sentence would be routing on whatever the sentence happened to say.
//
// THREE RULES, and every field below obeys them.
//
//   1  UNKNOWN IS A VALUE. Every routable property is a `Known<T>`, which is either a value WITH its
//      source and the moment it was observed, or `unknown` WITH A REASON. There is no default: a field
//      nobody established is never `false`, `0` or `[]`, because each of those is a claim.
//   2  NEVER FROM A NAME. Nothing here infers a capability from an identifier. `…-free` is a name, not
//      a price (`opencode/big-pickle` is free and says nothing of the kind); `coder` is a name, not a
//      capability. A property is filled from a STRUCTURED field some source published — a runtime's
//      `capabilities`, a catalogue's `tool_call` and `limit.context` — or it stays unknown.
//   3  A PUBLISHED CLAIM IS LABELLED AS ONE. A catalogue saying `tool_call: true` is the catalogue's
//      statement about the model, not an observation of it using a tool, and its `source` says
//      `catalogue`. Whether the model can actually DO the work is qualification's question, answered
//      from benchmark evidence in `route-qualification.ts`, never from this file.

import { CostEligibility } from './cost-eligibility';
import { DiscoveredFrontierModel, ModelAvailability } from './discovery';
import { DEVELOPMENT_EXECUTABLE_PROVIDERS } from './development-synthetic';
import { PublishedCataloguePrice } from './opencode-pricing';
import { ExecutionClass, ProviderID, executionClassOf, isIdentityAdmissibleProvider } from './provider';

export const MODEL_DESCRIPTION_SCHEMA = 'cmd1';

/** A value with its provenance, or an explicit unknown with the reason. Never a silent default. */
export type Known<T> =
  | { state: 'known'; value: T; source: string; observedAt?: string }
  | { state: 'unknown'; reason: string };

export function known<T>(value: T, source: string, observedAt?: string): Known<T> {
  return observedAt === undefined ? { state: 'known', value, source } : { state: 'known', value, source, observedAt };
}

export function unknown<T>(reason: string): Known<T> {
  return { state: 'unknown', reason };
}

export function valueOf<T>(field: Known<T>): T | undefined {
  return field.state === 'known' ? field.value : undefined;
}

/**
 * How strongly this route can say WHICH model answered. Ordered from strongest to weakest, and every
 * member names its mechanism rather than a degree of confidence.
 */
export type IdentityConfidence =
  /** The provider's reply named the model and it matched. */
  | 'verifiedByProvider'
  /** A local runtime reported the weights digest, and the digest is the identity. */
  | 'verifiedByLocalDigest'
  /** The tool names no model, but REPORTS a substitution when one happens (Codex). */
  | 'unverifiableSubstitutionDetectable'
  /** The tool names no model and would not reveal a substitution (OpenCode `--format json`). */
  | 'unverifiableSubstitutionUndetectable'
  /** Nothing has been established either way. */
  | 'unknown';

/** Whether the published free status of a route is still a current claim, and what made it one. */
export type FreeStatus =
  /** The provider's catalogue published a $0/$0 list price. A statement of intent, not a bill. */
  | 'publishedZeroListPrice'
  /** A person read the account's billing record and signed that this route costs nothing. */
  | 'confirmedZeroMarginalCost'
  /** The catalogue published a non-zero price. */
  | 'publishedNonZeroPrice'
  /** No monetary cost exists at all: the route runs on this machine. */
  | 'localNoMonetaryCost'
  /** Covered by a subscription; $0 marginal, finite allowance. Not "free". */
  | 'subscriptionIncluded';

export interface PriceMetadata {
  inputMicroUSDPerMillionTokens: number;
  outputMicroUSDPerMillionTokens: number;
  /** Always `publishedListPrice` today. An observed charge would say `observedCharge`. */
  provenance: 'publishedListPrice';
}

/** One route, described. `routeKey` is `provider:modelID`, the same key discovery and qualification use. */
export interface ModelDescription {
  schema: typeof MODEL_DESCRIPTION_SCHEMA;
  routeKey: string;
  provider: ProviderID;
  modelID: string;
  displayName: Known<string>;
  accessRoute: ExecutionClass;
  locality: 'local' | 'remote';
  /**
   * The machine this description was observed ON. For a local route it is also the only machine the
   * description is true of: the same tag on another machine may be different weights.
   */
  observedOnMachine: Known<string>;
  billingClass: Known<CostEligibility>;
  price: Known<PriceMetadata>;
  freeStatus: Known<FreeStatus>;
  discoveredAt: Known<string>;
  /** When this description stops being current and must be re-observed. */
  expiresAt: Known<string>;
  availability: Known<ModelAvailability | 'installedLocally' | 'notListed'>;
  contextWindowTokens: Known<number>;
  maxOutputTokens: Known<number>;
  toolUse: Known<boolean>;
  /** A published or runtime-reported statement that the model is meant for coding/agentic work. */
  codingAgentic: Known<boolean>;
  reasoningEffortLevels: Known<string[]>;
  workspaceDriver: Known<string>;
  developmentDriver: Known<boolean>;
  identityConfidence: IdentityConfidence;
  runtimeVersion: Known<string>;
  modelDigest: Known<string>;
  /** Every source this description drew on, in words. */
  provenance: string[];
}

/** The workspace driver id a provider has in this build, as a fact about THIS build. */
const WORKSPACE_DRIVER_FOR: Partial<Record<ProviderID, string>> = {
  claudeCLI: 'driver.claude-cli.workspace',
  codexCLI: 'driver.codex-cli.workspace',
  opencodeCLI: 'driver.opencode-cli.workspace',
  ollama: 'driver.ollama.workspace',
};

function baseline(provider: ProviderID, modelID: string): ModelDescription {
  const executionClass = executionClassOf(provider);
  const local = executionClass === 'localRuntime';
  const driver = WORKSPACE_DRIVER_FOR[provider];
  return {
    schema: MODEL_DESCRIPTION_SCHEMA,
    routeKey: `${provider}:${modelID}`,
    provider,
    modelID,
    displayName: unknown('no source named this model'),
    accessRoute: executionClass,
    locality: local ? 'local' : 'remote',
    observedOnMachine: unknown('not observed on any machine yet'),
    billingClass: local ? known('local', 'the execution class: a local runtime has no monetary cost')
      : executionClass === 'subscriptionCLI' ? known('subscription_included', 'the execution class: a subscription CLI session')
        : unknown('a metered route is free only when an observation of the account says so; none was supplied'),
    price: unknown('no price was published or captured for this route'),
    freeStatus: local ? known('localNoMonetaryCost', 'the execution class')
      : executionClass === 'subscriptionCLI' ? known('subscriptionIncluded', 'the execution class')
        : unknown('no published price and no confirmation'),
    discoveredAt: unknown('not discovered'),
    expiresAt: unknown('nothing observed, so nothing to expire'),
    availability: unknown('not discovered'),
    contextWindowTokens: unknown('no source published a context window'),
    maxOutputTokens: unknown('no source published an output limit'),
    toolUse: unknown('no source stated whether this model uses tools'),
    codingAgentic: unknown('no source stated whether this model is meant for coding or agentic work'),
    reasoningEffortLevels: unknown('no source listed the effort levels this model accepts'),
    workspaceDriver: driver === undefined ? unknown(`this build has no workspace driver for ${provider}`)
      : known(driver, 'this build\'s workspace driver registry'),
    developmentDriver: known(DEVELOPMENT_EXECUTABLE_PROVIDERS.includes(provider), 'this build\'s development execution registry'),
    identityConfidence: 'unknown',
    runtimeVersion: unknown(local ? 'the runtime version was not read' : 'not applicable to a hosted route'),
    modelDigest: unknown(local ? 'the runtime reported no weights digest' : 'a hosted model exposes no weights digest'),
    provenance: [],
  };
}

/** Add a day count to an ISO time. Returns undefined for an unreadable input rather than guessing. */
export function isoPlus(at: string, milliseconds: number): string | undefined {
  const parsed = Date.parse(at);
  return Number.isNaN(parsed) ? undefined : new Date(parsed + milliseconds).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * A hosted route, from a discovery row. The row says WHETHER the route was proven and WHEN; it says
 * nothing about context, tools or price, and so those stay unknown here.
 */
export function describeDiscoveredRoute(row: DiscoveredFrontierModel, options: {
  machine?: string; evidenceMaxAgeMilliseconds: number;
}): ModelDescription {
  const description = baseline(row.provider, row.modelID);
  description.displayName = row.displayName.length > 0 ? known(row.displayName, 'discovery row') : description.displayName;
  description.discoveredAt = known(row.discoveredAt, 'discovery row');
  const expires = isoPlus(row.discoveredAt, options.evidenceMaxAgeMilliseconds);
  description.expiresAt = expires === undefined ? unknown('the discovery row carries no readable timestamp, so it is treated as expired')
    : known(expires, 'discovery evidence window');
  description.availability = known(row.availability, 'discovery row', row.discoveredAt);
  if (options.machine !== undefined) description.observedOnMachine = known(options.machine, 'the machine that ran discovery');
  description.identityConfidence = row.availability === 'proven' && row.verifiedModelID.length > 0 ? 'verifiedByProvider'
    : row.provider === 'codexCLI' ? 'unverifiableSubstitutionDetectable'
      : row.provider === 'opencodeCLI' ? 'unverifiableSubstitutionUndetectable'
        : isIdentityAdmissibleProvider(row.provider) ? 'unverifiableSubstitutionUndetectable' : 'unknown';
  description.provenance.push(`discovery row (${row.availability}) at ${row.discoveredAt}`);
  return description;
}

/**
 * One entry of OpenCode's model catalogue (`~/.cache/opencode/models.json`), in its own field names.
 * Only the structured fields are read; `description` and `name` are prose and route nothing.
 */
export interface OpenCodeCatalogueEntry {
  id: string;
  name?: string;
  reasoning?: boolean;
  reasoning_options?: unknown[];
  tool_call?: boolean;
  limit?: { context?: number; input?: number; output?: number };
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
}

/**
 * Fold a catalogue entry's STRUCTURED fields into a description. Every value is labelled as the
 * catalogue's published claim, dated to when the catalogue was read.
 *
 * `codingAgentic` IS NOT SET FROM HERE. The catalogue publishes `tool_call`, which is a statement about
 * an API feature; whether the model is meant for coding is only in its prose `description`, and prose
 * routes nothing. It stays unknown until a structured source says otherwise — and qualification never
 * needed it to be known: it asks the benchmark.
 */
export function withOpenCodeCatalogueEntry(description: ModelDescription, entry: OpenCodeCatalogueEntry,
                                          catalogue: { source: string; readAt: string }): ModelDescription {
  const out: ModelDescription = { ...description, provenance: [...description.provenance] };
  const source = `catalogue: ${catalogue.source}`;
  if (typeof entry.name === 'string' && entry.name.length > 0) out.displayName = known(entry.name, source, catalogue.readAt);
  if (typeof entry.limit?.context === 'number') out.contextWindowTokens = known(entry.limit.context, source, catalogue.readAt);
  if (typeof entry.limit?.output === 'number') out.maxOutputTokens = known(entry.limit.output, source, catalogue.readAt);
  if (typeof entry.tool_call === 'boolean') out.toolUse = known(entry.tool_call, source, catalogue.readAt);
  if (Array.isArray(entry.reasoning_options)) {
    const levels = entry.reasoning_options.filter((level): level is string => typeof level === 'string');
    out.reasoningEffortLevels = known(levels, source, catalogue.readAt);
  }
  const input = entry.cost?.input;
  const output = entry.cost?.output;
  if (typeof input === 'number' && typeof output === 'number') {
    out.price = known({
      inputMicroUSDPerMillionTokens: Math.round(input * 1_000_000),
      outputMicroUSDPerMillionTokens: Math.round(output * 1_000_000),
      provenance: 'publishedListPrice',
    }, source, catalogue.readAt);
    // A PUBLISHED zero, labelled as one. `freeStatus` only reaches `confirmedZeroMarginalCost` through a
    // signed observation (`withZeroMarginalCostConfirmation`), and a published price never gets it there.
    if (out.freeStatus.state !== 'known' || out.freeStatus.value !== 'confirmedZeroMarginalCost') {
      out.freeStatus = known(input === 0 && output === 0 ? 'publishedZeroListPrice' : 'publishedNonZeroPrice', source, catalogue.readAt);
    }
    if (out.billingClass.state === 'unknown') {
      out.billingClass = input === 0 && output === 0
        ? unknown('the catalogue publishes $0 for this route, which is a list price and not an observation of the account; '
          + 'it is unknown_cost until a signed confirmation makes it free_confirmed')
        : known('metered', source, catalogue.readAt);
    }
  }
  out.provenance.push(`${source} read ${catalogue.readAt}`);
  return out;
}

/** Fold a captured published price (the free pool's) into a description. */
export function withPublishedPrice(description: ModelDescription, price: PublishedCataloguePrice): ModelDescription {
  return withOpenCodeCatalogueEntry(description, {
    id: price.modelID, name: price.displayName,
    cost: { input: price.publishedUSDPerMillionTokens.input, output: price.publishedUSDPerMillionTokens.output },
  }, { source: price.source, readAt: price.capturedAt });
}

/** A signed observation of the account's billing. The only way `freeStatus` becomes confirmed. */
export function withZeroMarginalCostConfirmation(description: ModelDescription, confirmation: {
  observedAt: string; observedBillingRecord: string; confirmedBy: string; expiresAt?: string;
}): ModelDescription {
  const source = `zero-marginal-cost confirmation by ${confirmation.confirmedBy} against ${confirmation.observedBillingRecord}`;
  return {
    ...description,
    billingClass: known('free_confirmed', source, confirmation.observedAt),
    freeStatus: known('confirmedZeroMarginalCost', source, confirmation.observedAt),
    provenance: [...description.provenance, source],
  };
}

/** A local model, from THIS machine's runtime. Every field is the runtime's own report. */
export function describeLocalModel(model: {
  modelID: string; runtimeDigest: string; family?: string; parameterSize?: string; quantization?: string;
  sizeBytes?: number; capabilities?: string[]; contextLengthTokens?: number;
}, options: { machine: string; observedAt: string; runtimeVersion?: string; endpoint: string }): ModelDescription {
  const description = baseline('ollama', model.modelID);
  const source = `the local runtime at ${options.endpoint} on ${options.machine}`;
  description.observedOnMachine = known(options.machine, 'the machine whose runtime listed it', options.observedAt);
  description.discoveredAt = known(options.observedAt, source);
  description.availability = known('installedLocally', source, options.observedAt);
  // A LOCAL LISTING HAS NO EXPIRY WINDOW: it is true until the digest changes, which a refresh detects.
  description.expiresAt = unknown('a local description stays current until a refresh sees the weights digest change');
  if (model.runtimeDigest.length > 0) {
    description.modelDigest = known(model.runtimeDigest, source, options.observedAt);
    description.identityConfidence = 'verifiedByLocalDigest';
  }
  if (options.runtimeVersion !== undefined) description.runtimeVersion = known(options.runtimeVersion, source, options.observedAt);
  if (model.contextLengthTokens !== undefined) description.contextWindowTokens = known(model.contextLengthTokens, `${source} (/api/show)`, options.observedAt);
  if (model.capabilities !== undefined) {
    description.toolUse = known(model.capabilities.includes('tools'), `${source} (capabilities)`, options.observedAt);
  }
  description.displayName = known(model.modelID, source);
  description.provenance.push(`${source} at ${options.observedAt}${model.family ? ` · family ${model.family}` : ''}`
    + `${model.parameterSize ? ` · ${model.parameterSize}` : ''}${model.quantization ? ` · ${model.quantization}` : ''}`
    + `${model.sizeBytes === undefined ? '' : ` · ${model.sizeBytes} bytes`}`);
  return description;
}
