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

// MARK: - cmd2: lifecycle, aliases and one canonical id
//
// WHAT cmd2 ADDS. Three things a release watcher needs and cmd1 cannot say:
//
//   LIFECYCLE    whether a model is active, deprecated or retired — a `Known<…>` like every other
//                property, so "no source said" is `unknown` with its reason and never `active`.
//                It is set only from a STRUCTURED lifecycle statement a source published. A refused
//                smoke is not retirement (it may be tier, region or moderation), a model missing from
//                a listing is not retirement (the listing may be partial), and `-preview` or `-latest`
//                in an identifier is a name, which says nothing.
//   ALIASES      other identifiers that a source STATED reach the same model, each with that source.
//                An alias is never inferred from two names looking alike.
//   CANONICAL    the one id the model is filed under, so `sonnet` and `claude-sonnet-4-5` are one model
//                when — and only when — a source said so. Dedup is by that id.
//
// cmd1 STAYS READABLE. `readModelDescription` accepts a cmd1 document and returns it as cmd2 with the
// lifecycle unknown, no aliases and its own id as canonical: exactly what cmd1 established, no more.

export const MODEL_DESCRIPTION_SCHEMA_V2 = 'cmd2';

/** Where a model is in its provider's lifecycle. `unknown` is the `Known` wrapper's, not a member. */
export type LifecycleState = 'active' | 'deprecated' | 'retired';

export const LIFECYCLE_STATES: LifecycleState[] = ['active', 'deprecated', 'retired'];

/** One identifier a source stated reaches this model. */
export interface ModelAlias {
  alias: string;
  source: string;
  observedAt?: string;
}

/** A route described under cmd2. Every cmd1 field, unchanged in meaning, plus lifecycle and aliases. */
export interface ModelDescriptionV2 extends Omit<ModelDescription, 'schema'> {
  schema: typeof MODEL_DESCRIPTION_SCHEMA_V2;
  /** The id this model is filed under. Its own `modelID` unless an alias statement says otherwise. */
  canonicalModelID: string;
  /** `provider:canonicalModelID`. The dedup key. */
  canonicalRouteKey: string;
  /** Every other identifier a source stated reaches this model. Sorted, never containing the canonical id. */
  aliases: ModelAlias[];
  lifecycle: Known<LifecycleState>;
}

export const CMD1_HAS_NO_LIFECYCLE = 'a cmd1 description carries no lifecycle, and no source has stated one';
export const NO_LIFECYCLE_SOURCE = 'no source has published a lifecycle state for this model';

/**
 * A source's statement that `alias` and `canonicalModelID` are the same model at one provider.
 *
 * The source is required: an alias with no one behind it is a guess, and a guess about identity is
 * how a benchmark of one model gets filed under another.
 */
export interface AliasStatement {
  provider: ProviderID;
  alias: string;
  canonicalModelID: string;
  source: string;
  observedAt?: string;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A cmd1 description as cmd2: no lifecycle, no aliases, its own id as canonical. Pure. */
export function upgradeToCmd2(description: ModelDescription): ModelDescriptionV2 {
  const { schema: _schema, ...rest } = description;
  return {
    ...rest,
    provenance: [...description.provenance],
    schema: MODEL_DESCRIPTION_SCHEMA_V2,
    canonicalModelID: description.modelID,
    canonicalRouteKey: description.routeKey,
    aliases: [],
    lifecycle: unknown(CMD1_HAS_NO_LIFECYCLE),
  };
}

/**
 * Read a stored description of either schema. A cmd1 document is upgraded; anything else is refused
 * with the reason, never coerced.
 */
export function readModelDescription(document: unknown):
  { ok: true; readFrom: 'cmd1' | 'cmd2'; description: ModelDescriptionV2 } | { ok: false; reason: string } {
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    return { ok: false, reason: 'a model description is a JSON object' };
  }
  const record = document as Record<string, unknown>;
  for (const field of ['routeKey', 'provider', 'modelID'] as const) {
    if (typeof record[field] !== 'string' || (record[field] as string).length === 0) {
      return { ok: false, reason: `${field} is missing or empty` };
    }
  }
  if (record.schema === MODEL_DESCRIPTION_SCHEMA) {
    return { ok: true, readFrom: 'cmd1', description: upgradeToCmd2(record as unknown as ModelDescription) };
  }
  if (record.schema !== MODEL_DESCRIPTION_SCHEMA_V2) {
    return { ok: false, reason: `schema is '${String(record.schema)}', not ${MODEL_DESCRIPTION_SCHEMA} or ${MODEL_DESCRIPTION_SCHEMA_V2}` };
  }
  const lifecycle = record.lifecycle as Known<unknown> | undefined;
  if (lifecycle === undefined || (lifecycle.state !== 'known' && lifecycle.state !== 'unknown')) {
    return { ok: false, reason: 'a cmd2 description must carry lifecycle as a known value or an unknown with its reason' };
  }
  if (lifecycle.state === 'known' && !LIFECYCLE_STATES.includes(lifecycle.value as LifecycleState)) {
    return { ok: false, reason: `lifecycle '${String(lifecycle.value)}' is not one of ${LIFECYCLE_STATES.join(', ')}` };
  }
  if (!Array.isArray(record.aliases) || typeof record.canonicalModelID !== 'string' || typeof record.canonicalRouteKey !== 'string') {
    return { ok: false, reason: 'a cmd2 description must carry canonicalModelID, canonicalRouteKey and aliases' };
  }
  return { ok: true, readFrom: 'cmd2', description: record as unknown as ModelDescriptionV2 };
}

/**
 * Read a lifecycle state from a source's STRUCTURED field. Only the exact words are accepted; any other
 * value leaves the lifecycle unknown and says what was seen, because "sunsetting" or "legacy" might mean
 * either deprecated or retired and this is not the place to decide which.
 */
export function lifecycleFromField(value: unknown, source: string, observedAt?: string): Known<LifecycleState> {
  if (typeof value === 'string' && LIFECYCLE_STATES.includes(value as LifecycleState)) {
    return known(value as LifecycleState, source, observedAt);
  }
  return unknown(value === undefined ? `${source} published no lifecycle field`
    : `${source} published lifecycle ${JSON.stringify(value)}, which is not one of ${LIFECYCLE_STATES.join(', ')}`);
}

/** Record a source's lifecycle statement on a description. */
export function withLifecycle(description: ModelDescriptionV2, state: LifecycleState, source: string, observedAt?: string): ModelDescriptionV2 {
  return {
    ...description,
    lifecycle: known(state, source, observedAt),
    provenance: [...description.provenance, `lifecycle ${state}: ${source}${observedAt === undefined ? '' : ` at ${observedAt}`}`],
  };
}

/** Record a source's statement that other identifiers reach this model. */
export function withAliases(description: ModelDescriptionV2, aliases: ModelAlias[]): ModelDescriptionV2 {
  const byAlias = new Map(description.aliases.map((entry) => [entry.alias, entry]));
  for (const entry of aliases) {
    if (entry.alias === description.canonicalModelID || byAlias.has(entry.alias)) continue;
    byAlias.set(entry.alias, entry);
  }
  return { ...description, aliases: [...byAlias.values()].sort((a, b) => compareText(a.alias, b.alias)) };
}

export class AliasResolutionError extends Error {
  constructor(readonly code: 'missingSource' | 'selfAlias', message: string) {
    super(message);
    this.name = 'AliasResolutionError';
  }
}

/** What an identifier resolves to. Every state carries its reason. */
export type AliasResolution =
  | { state: 'canonical'; canonicalRouteKey: string; reason: string }
  | { state: 'alias'; canonicalRouteKey: string; via: string[]; reason: string }
  /** Two sources disagree about what this identifier reaches, or the statements form a cycle. */
  | { state: 'ambiguous'; candidates: string[]; reason: string };

export interface AliasConflict {
  routeKey: string;
  reason: string;
  sources: string[];
}

/** Every alias statement, indexed. Built once; resolution is a lookup. */
export interface AliasTable {
  /** `provider:alias` → every statement about it. */
  statements: Map<string, AliasStatement[]>;
  conflicts: AliasConflict[];
}

/**
 * Index alias statements. A statement with no source, or that names a model its own alias, is refused
 * by throwing: it is a defect in whatever produced it, not a fact to route around.
 */
export function buildAliasTable(statements: AliasStatement[]): AliasTable {
  const table = new Map<string, AliasStatement[]>();
  for (const statement of statements) {
    if (typeof statement.source !== 'string' || statement.source.trim().length === 0) {
      throw new AliasResolutionError('missingSource', `the alias ${statement.provider}:${statement.alias} → `
        + `${statement.canonicalModelID} names no source. An alias nobody stated is a guess about identity, and is refused.`);
    }
    if (statement.alias === statement.canonicalModelID) {
      throw new AliasResolutionError('selfAlias', `${statement.provider}:${statement.alias} is stated as an alias of itself`);
    }
    const key = `${statement.provider}:${statement.alias}`;
    table.set(key, [...(table.get(key) ?? []), statement]);
  }
  const conflicts: AliasConflict[] = [];
  for (const [routeKey, entries] of [...table.entries()].sort((a, b) => compareText(a[0], b[0]))) {
    const targets = [...new Set(entries.map((entry) => entry.canonicalModelID))].sort(compareText);
    if (targets.length > 1) {
      conflicts.push({
        routeKey, reason: `sources disagree: ${routeKey} is stated to reach ${targets.join(' and ')}`,
        sources: entries.map((entry) => entry.source).sort(compareText),
      });
    }
  }
  return { statements: table, conflicts };
}

/**
 * Resolve an identifier to its one canonical route key, following alias statements to the end.
 *
 * An identifier no statement names is its own canonical id: that is the absence of an alias, not a
 * claim about one. Disagreeing statements and cycles are `ambiguous`, never resolved by picking one.
 */
export function resolveAlias(table: AliasTable, provider: ProviderID, modelID: string): AliasResolution {
  const via: string[] = [];
  let current = modelID;
  const seen = new Set<string>();
  for (;;) {
    const key = `${provider}:${current}`;
    if (seen.has(key)) {
      return { state: 'ambiguous', candidates: [...seen].sort(compareText), reason: `the alias statements form a cycle through ${[...seen].join(' → ')}` };
    }
    seen.add(key);
    const entries = table.statements.get(key) ?? [];
    const targets = [...new Set(entries.map((entry) => entry.canonicalModelID))].sort(compareText);
    if (targets.length > 1) {
      return { state: 'ambiguous', candidates: targets.map((target) => `${provider}:${target}`),
        reason: `sources disagree about what ${key} reaches: ${targets.join(', ')}` };
    }
    if (targets.length === 0) {
      return via.length === 0
        ? { state: 'canonical', canonicalRouteKey: key, reason: `no source states that ${key} is an alias` }
        : { state: 'alias', canonicalRouteKey: key, via,
          reason: `${provider}:${modelID} is an alias of ${key} (${via.join('; ')})` };
    }
    via.push(`${key} → ${targets[0]} per ${entries.map((entry) => entry.source).sort(compareText).join(', ')}`);
    current = targets[0];
  }
}

/** What dedup did: which descriptions it folded together, and what it could not reconcile. */
export interface DedupOutcome {
  descriptions: ModelDescriptionV2[];
  merged: { canonicalRouteKey: string; fromRouteKeys: string[] }[];
  /** Identifiers left as their own model because their resolution was ambiguous. */
  unresolved: { routeKey: string; reason: string }[];
  /** Lifecycle statements that disagreed within one canonical model. */
  lifecycleConflicts: AliasConflict[];
}

/**
 * One description per canonical id.
 *
 * The description filed under the canonical id itself is kept when there is one; otherwise the first by
 * route key. Every other identifier becomes an alias, with the statement's source. A lifecycle stated by
 * any member is carried; two members stating DIFFERENT lifecycles leave it unknown, with both named —
 * which one is current is a question for the sources, not for a merge.
 */
export function dedupByCanonicalID(descriptions: (ModelDescription | ModelDescriptionV2)[], statements: AliasStatement[] = []): DedupOutcome {
  const table = buildAliasTable(statements);
  const groups = new Map<string, ModelDescriptionV2[]>();
  const unresolved: DedupOutcome['unresolved'] = [];
  const upgraded = descriptions.map((entry) => (entry.schema === MODEL_DESCRIPTION_SCHEMA ? upgradeToCmd2(entry as ModelDescription) : entry as ModelDescriptionV2))
    .sort((a, b) => compareText(a.routeKey, b.routeKey));
  for (const description of upgraded) {
    const resolution = resolveAlias(table, description.provider, description.modelID);
    let canonical: string;
    if (resolution.state === 'ambiguous') {
      unresolved.push({ routeKey: description.routeKey, reason: resolution.reason });
      canonical = description.routeKey;
    } else {
      canonical = resolution.canonicalRouteKey;
    }
    groups.set(canonical, [...(groups.get(canonical) ?? []), description]);
  }

  const out: ModelDescriptionV2[] = [];
  const merged: DedupOutcome['merged'] = [];
  const lifecycleConflicts: AliasConflict[] = [];
  for (const [canonicalRouteKey, members] of [...groups.entries()].sort((a, b) => compareText(a[0], b[0]))) {
    const canonicalModelID = canonicalRouteKey.slice(canonicalRouteKey.indexOf(':') + 1);
    const primary = members.find((entry) => entry.modelID === canonicalModelID) ?? members[0];
    let result: ModelDescriptionV2 = { ...primary, canonicalModelID, canonicalRouteKey, provenance: [...primary.provenance] };
    const aliases: ModelAlias[] = [...primary.aliases];
    for (const member of members) {
      aliases.push(...member.aliases);
      if (member.modelID !== canonicalModelID) {
        const stated = table.statements.get(member.routeKey) ?? [];
        aliases.push({ alias: member.modelID, source: stated.map((entry) => entry.source).sort(compareText).join(', ') || 'alias statement',
          ...(stated[0]?.observedAt === undefined ? {} : { observedAt: stated[0].observedAt }) });
      }
    }
    for (const [key, entries] of table.statements) {
      if (!key.startsWith(`${primary.provider}:`)) continue;
      const resolution = resolveAlias(table, primary.provider, key.slice(key.indexOf(':') + 1));
      if (resolution.state === 'alias' && resolution.canonicalRouteKey === canonicalRouteKey) {
        aliases.push({ alias: key.slice(key.indexOf(':') + 1), source: entries.map((entry) => entry.source).sort(compareText).join(', '),
          ...(entries[0].observedAt === undefined ? {} : { observedAt: entries[0].observedAt }) });
      }
    }
    result = withAliases({ ...result, aliases: [] }, aliases);

    const stated = members.filter((entry) => entry.lifecycle.state === 'known')
      .map((entry) => ({ routeKey: entry.routeKey, lifecycle: entry.lifecycle as Extract<Known<LifecycleState>, { state: 'known' }> }));
    const states = [...new Set(stated.map((entry) => entry.lifecycle.value))].sort(compareText);
    if (states.length === 1) {
      result.lifecycle = stated[0].lifecycle;
    } else if (states.length > 1) {
      const reason = `sources disagree about the lifecycle of ${canonicalRouteKey}: `
        + stated.map((entry) => `${entry.routeKey} ${entry.lifecycle.value} per ${entry.lifecycle.source}`).join('; ');
      result.lifecycle = unknown(reason);
      lifecycleConflicts.push({ routeKey: canonicalRouteKey, reason, sources: stated.map((entry) => entry.lifecycle.source).sort(compareText) });
    }
    if (members.length > 1) {
      merged.push({ canonicalRouteKey, fromRouteKeys: members.map((entry) => entry.routeKey) });
      result.provenance = [...new Set(members.flatMap((entry) => entry.provenance))];
    }
    out.push(result);
  }
  return { descriptions: out, merged, unresolved, lifecycleConflicts };
}
