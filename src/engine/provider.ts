// Benchmark engine · WHO is being asked, HOW they are reached, and WHO PAYS.
//
// Pass 3 had one provider and one way of reaching it: a local Ollama on an endpoint Cernum managed.
// Everything about that arrangement was implicit, and implicit was fine while it was the only one.
// It stops being fine the moment a campaign can contain a model that runs on somebody else's
// hardware, is billed to a subscription or a card, and can be silently swapped for a different model
// between one request and the next.
//
// THREE EXECUTION CLASSES, AND THEY ARE NOT INTERCHANGEABLE.
//
//   localRuntime     weights on this machine, served by a runtime Cernum manages residency on.
//                    Monetary cost is genuinely zero. Latency is a property of THIS machine.
//   subscriptionCLI  an officially installed, already-authenticated first-party CLI — the user's own
//                    `claude` or `codex` — driven as a child process. Cernum never reads its token
//                    files, never reuses a browser session, and never imitates its private API. The
//                    marginal API charge is zero; the ALLOWANCE is not, and is tracked separately.
//   meteredAPI       a published HTTP API billed per token against a key the user supplied. Every
//                    request costs money, so no request happens without recorded authorization.
//
// WHY THE CLASS IS FROZEN RATHER THAN OBSERVED. The same model name can be reached three ways, and
// the three produce results that compare on task outcome and on nothing else: their pricing differs,
// their latency conditions differ (a local model has no network; a subscription CLI has a process
// launch; an API has a queue), and their access method differs. A campaign that recorded "claude
// answered" without recording HOW would be a campaign whose latency column cannot be read at all.
//
// THE SCORED CORE AND THE OPERATIONAL ENVELOPE ARE SEPARATE ON PURPOSE. The scored core — the
// prompts, the scoring modes, the output budgets — is what makes two results comparable. The
// operational envelope — provider, execution class, effort, pricing, timeouts, retries — is what
// makes them DIFFERENT. Keeping them apart is what lets a reader say "the same benchmark, run three
// ways" instead of having to choose between pretending the three are identical and refusing to put
// them on one page.
//
// NOTHING HERE ASSERTS THAT A MODEL EXISTS. A binding records what was REQUESTED and what was
// VERIFIED, as two separate fields, because "we asked for Opus" and "the provider confirmed Opus"
// are different facts and a campaign that conflates them is measuring something it cannot name.

import { CanonicalValue, digestObject } from './canonical';
import type { ThinkingMode } from './execution';

/** A provider Cernum can reach. Adding one here does not make it available; discovery decides that. */
export type ProviderID = 'ollama' | 'claudeCLI' | 'codexCLI' | 'anthropicAPI' | 'openaiAPI';

export const PROVIDER_IDS: ProviderID[] = ['ollama', 'claudeCLI', 'codexCLI', 'anthropicAPI', 'openaiAPI'];

/** How a provider is reached, and therefore what its numbers mean. */
export type ExecutionClass = 'localRuntime' | 'subscriptionCLI' | 'meteredAPI';

/**
 * Who pays, and in what currency.
 *
 * `subscriptionIncluded` is NOT "free". It means the marginal API charge for this request is zero
 * because a subscription the user already pays for covers it, while consuming an allowance that is
 * finite and, where the provider reports it, tracked. Describing subscription usage as free is the
 * single easiest way for a benchmark to mislead somebody about what a model costs them.
 */
export type BillingBasis = 'local' | 'subscriptionIncluded' | 'meteredAPI';

/** How the caller is authorised. Never the credential itself — only the SHAPE of the authorisation. */
export type AuthorizationMode = 'none' | 'subscriptionCLISession' | 'apiKeyEnvironment' | 'apiKeyKeychain';

/**
 * A reasoning-effort level, as a frozen request.
 *
 * These are the names the providers themselves use. `none` means the request carries no effort
 * instruction at all, which is different from asking for low.
 */
export type EffortLevel = 'none' | 'low' | 'medium' | 'high' | 'max';

export const EFFORT_LEVELS: EffortLevel[] = ['none', 'low', 'medium', 'high', 'max'];

/**
 * What is actually known about the model identity behind a binding.
 *
 * There is no `assumed`. A provider that did not confirm which model answered leaves the binding
 * `unverifiable`, and that word appears on every artefact the run produces.
 */
export type BindingIdentityState = 'verified' | 'unverifiable';

/** Published prices, as they stood at a moment somebody recorded. Never inferred, never defaulted. */
export interface PricingSnapshot {
  /**
   * Where these figures came from, in words. A pricing snapshot with no provenance is a guess with
   * a timestamp, so this is required and is written into the manifest.
   */
  source: string;
  capturedAt: string;
  currency: 'USD';
  /** Integer-scaled: microUSD (10^-6 USD) per million tokens, so the canonical encoder sees no float. */
  inputMicroUSDPerMillionTokens: number;
  outputMicroUSDPerMillionTokens: number;
  /** Charged separately by some providers. Null when the provider does not bill reasoning apart. */
  reasoningMicroUSDPerMillionTokens: number | null;
}

/** The retry policy, frozen. A campaign that retried differently on resume is a different campaign. */
export interface RetryPolicy {
  maxRetries: number;
  backoffMilliseconds: number;
  /**
   * The failure kinds a retry is permitted for. A timeout and a rate limit are retryable; a refusal
   * or a model mismatch is not, because retrying those would just spend money reproducing them.
   */
  retryOn: string[];
}

export const NO_RETRY: RetryPolicy = { maxRetries: 0, backoffMilliseconds: 0, retryOn: [] };

export const DEFAULT_RETRY: RetryPolicy = {
  maxRetries: 2,
  backoffMilliseconds: 2_000,
  retryOn: ['timeout', 'rateLimited', 'transport'],
};

/** Sampling settings, integer-scaled. Null means "the request carries no such setting". */
export interface SamplingSettings {
  temperatureMilli: number | null;
  topPMilli: number | null;
  seed: number | null;
}

export const DETERMINISTIC_SAMPLING: SamplingSettings = { temperatureMilli: 0, topPMilli: 1_000, seed: 7 };

/**
 * Everything about ONE candidate that is not the benchmark itself.
 *
 * This is the operational half of a candidate's identity. It is frozen into the manifest, bound into
 * the manifest digest through the operational-envelope digest, and never adjusted afterwards —
 * including on a resume, where a changed binding is a drift that refuses the resume rather than a
 * setting that quietly takes effect.
 */
export interface ProviderBinding {
  /** The candidate name this binds, matching `ManifestCandidate.name`. */
  candidate: string;
  provider: ProviderID;
  executionClass: ExecutionClass;
  /** What Cernum will ASK for. */
  requestedModelID: string;
  /** What was actually established about the identity, and how. */
  identityState: BindingIdentityState;
  /** The identifier the provider returned. Empty string means it returned none — never a copy of the request. */
  verifiedModelID: string;
  /** In words: discovery listing, identity smoke test, or the reason it could not be established. */
  identityEvidence: string;
  effort: EffortLevel;
  thinkingMode: ThinkingMode;
  sampling: SamplingSettings;
  maxInputTokens: number;
  maxOutputTokens: number;
  timeoutMilliseconds: number;
  retry: RetryPolicy;
  billingBasis: BillingBasis;
  /** Required for a metered binding, forbidden for the other two: they have no per-token price. */
  pricing: PricingSnapshot | null;
  authorizationMode: AuthorizationMode;
}

/**
 * The whole operational side of a campaign, kept apart from the scored core.
 *
 * `mixed` is computed rather than declared so nothing can claim a campaign is homogeneous when its
 * bindings say otherwise.
 */
export interface OperationalEnvelope {
  bindings: ProviderBinding[];
  executionClasses: ExecutionClass[];
  providers: ProviderID[];
  mixed: boolean;
  /** True when at least one binding will be billed per token. Decides whether authorization is required. */
  hasMeteredBinding: boolean;
}

export class ProviderBindingError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ProviderBindingError';
  }
}

/** The execution class a provider is reached through. Fixed by what the provider IS, never chosen. */
export function executionClassOf(provider: ProviderID): ExecutionClass {
  switch (provider) {
    case 'ollama': return 'localRuntime';
    case 'claudeCLI': case 'codexCLI': return 'subscriptionCLI';
    case 'anthropicAPI': case 'openaiAPI': return 'meteredAPI';
  }
}

/** The billing basis an execution class implies. Also fixed: a class cannot be billed two ways. */
export function billingBasisOf(executionClass: ExecutionClass): BillingBasis {
  switch (executionClass) {
    case 'localRuntime': return 'local';
    case 'subscriptionCLI': return 'subscriptionIncluded';
    case 'meteredAPI': return 'meteredAPI';
  }
}

export function isFrontier(binding: ProviderBinding): boolean {
  return binding.executionClass !== 'localRuntime';
}

export function isLocal(binding: ProviderBinding): boolean {
  return binding.executionClass === 'localRuntime';
}

export function isMetered(binding: ProviderBinding): boolean {
  return binding.billingBasis === 'meteredAPI';
}

export const PROVIDER_LABELS: Record<ProviderID, string> = {
  ollama: 'Local Models',
  claudeCLI: 'Claude Subscription',
  codexCLI: 'Codex Subscription',
  anthropicAPI: 'Anthropic API',
  openaiAPI: 'OpenAI API',
};

export const EXECUTION_CLASS_LABELS: Record<ExecutionClass, string> = {
  localRuntime: 'local',
  subscriptionCLI: 'subscription',
  meteredAPI: 'metered API',
};

/**
 * How a binding's cost is described, in the words that are actually true.
 *
 * There are three of these and not two, because "subscription" and "free" are not the same claim and
 * a reader who is told the second will plan as though the allowance were infinite.
 */
export function billingLabel(binding: ProviderBinding): string {
  switch (binding.billingBasis) {
    case 'local':
      return 'local · no monetary cost, wall-clock time still recorded';
    case 'subscriptionIncluded':
      return 'subscription-included · marginal API charge $0, consumes a finite allowance';
    case 'meteredAPI':
      return 'metered API · billed per token against your key';
  }
}

/** The one line shown beside a candidate wherever there is room for one line. */
export function describeBinding(binding: ProviderBinding): string {
  const identity = binding.identityState === 'verified'
    ? `identity verified as ${binding.verifiedModelID}`
    : 'identity UNVERIFIABLE';
  const effort = binding.effort === 'none' ? 'no effort instruction' : `effort ${binding.effort}`;
  const thinking = binding.thinkingMode === 'enabled' ? 'thinking on'
    : binding.thinkingMode === 'disabled' ? 'thinking off'
      : 'thinking left to the provider';
  return `${PROVIDER_LABELS[binding.provider]} · ${EXECUTION_CLASS_LABELS[binding.executionClass]} · `
    + `${binding.requestedModelID} · ${identity} · ${effort} · ${thinking} · ${billingLabel(binding)}`;
}

/**
 * Refuse a binding that cannot be executed honestly, BEFORE anything is frozen.
 *
 * Every one of these is a refusal rather than a repair. A binding that had its missing pricing
 * filled in with a plausible number, or its execution class corrected to match its provider, would
 * be a binding that says something nobody checked.
 */
export function validateBinding(binding: ProviderBinding): void {
  const expectedClass = executionClassOf(binding.provider);
  if (binding.executionClass !== expectedClass) {
    throw new ProviderBindingError('executionClassMismatch',
      `${binding.candidate}: ${binding.provider} is reached as ${expectedClass}, not ${binding.executionClass}; `
      + 'the execution class is a property of the provider and is not a choice a campaign gets to make');
  }
  const expectedBilling = billingBasisOf(binding.executionClass);
  if (binding.billingBasis !== expectedBilling) {
    throw new ProviderBindingError('billingBasisMismatch',
      `${binding.candidate}: ${binding.executionClass} is billed as ${expectedBilling}, not ${binding.billingBasis}`);
  }
  if (binding.requestedModelID.length === 0) {
    throw new ProviderBindingError('noModelRequested', `${binding.candidate}: a binding with no requested model identifier asks for nothing`);
  }
  if (binding.identityState === 'verified' && binding.verifiedModelID.length === 0) {
    throw new ProviderBindingError('verifiedWithoutIdentity',
      `${binding.candidate}: the binding claims a verified identity but carries no identifier the provider returned. `
      + 'An identity nobody can name is not verified; record it as unverifiable instead.');
  }
  if (isMetered(binding) && binding.pricing === null) {
    throw new ProviderBindingError('meteredWithoutPricing',
      `${binding.candidate}: a metered binding without a pricing snapshot cannot have its cost estimated, and Cernum `
      + 'refuses a paid run it cannot price rather than guessing at what it will spend');
  }
  if (!isMetered(binding) && binding.pricing !== null) {
    throw new ProviderBindingError('unmeteredWithPricing',
      `${binding.candidate}: ${binding.billingBasis} execution is not billed per token, so a per-token price on it `
      + 'would be a number that looks like a cost and is not one');
  }
  if (binding.maxOutputTokens <= 0 || binding.maxInputTokens <= 0) {
    throw new ProviderBindingError('emptyBudget', `${binding.candidate}: input and output budgets must both be positive`);
  }
  if (binding.timeoutMilliseconds <= 0) {
    throw new ProviderBindingError('noTimeout', `${binding.candidate}: a binding with no timeout can hang a campaign indefinitely`);
  }
  if (binding.retry.maxRetries < 0) {
    throw new ProviderBindingError('negativeRetries', `${binding.candidate}: maxRetries cannot be negative`);
  }
  if (binding.executionClass === 'localRuntime' && binding.authorizationMode !== 'none') {
    throw new ProviderBindingError('localAuthorization',
      `${binding.candidate}: a local runtime needs no authorization mode; recording one would imply a credential that does not exist`);
  }
  if (binding.executionClass === 'subscriptionCLI' && binding.authorizationMode !== 'subscriptionCLISession') {
    throw new ProviderBindingError('subscriptionAuthorization',
      `${binding.candidate}: a subscription CLI is authorised by the user's own already-authenticated CLI session and by nothing else`);
  }
  if (binding.executionClass === 'meteredAPI'
      && binding.authorizationMode !== 'apiKeyEnvironment' && binding.authorizationMode !== 'apiKeyKeychain') {
    throw new ProviderBindingError('meteredAuthorization',
      `${binding.candidate}: a metered API binding must name where its key comes from`);
  }
}

/** The binding a local Ollama candidate gets. Explicit, so "local" is an assertion and not an absence. */
export function localOllamaBinding(options: {
  candidate: string;
  modelID: string;
  runtimeDigest: string;
  thinkingMode: ThinkingMode;
  maxInputTokens: number;
  maxOutputTokens: number;
  timeoutMilliseconds: number;
  sampling?: SamplingSettings;
}): ProviderBinding {
  return {
    candidate: options.candidate,
    provider: 'ollama',
    executionClass: 'localRuntime',
    requestedModelID: options.modelID,
    // The runtime digest IS the identity for a local model, and Pass 3 already verified it per
    // attempt. A model the runtime reported a digest for is verified here too; one it did not is not.
    identityState: options.runtimeDigest.length > 0 ? 'verified' : 'unverifiable',
    verifiedModelID: options.runtimeDigest.length > 0 ? options.modelID : '',
    identityEvidence: options.runtimeDigest.length > 0
      ? `the local runtime reported a weights digest (${options.runtimeDigest.slice(0, 16)}) for this model at freeze time`
      : 'the local runtime reported no weights digest for this model, so nothing confirms which weights answer',
    effort: 'none',
    thinkingMode: options.thinkingMode,
    sampling: options.sampling ?? { temperatureMilli: null, topPMilli: null, seed: null },
    maxInputTokens: options.maxInputTokens,
    maxOutputTokens: options.maxOutputTokens,
    timeoutMilliseconds: options.timeoutMilliseconds,
    retry: NO_RETRY,
    billingBasis: 'local',
    pricing: null,
    authorizationMode: 'none',
  };
}

/** Fold a set of bindings into the envelope the manifest freezes. Order follows candidate order. */
export function buildOperationalEnvelope(bindings: ProviderBinding[]): OperationalEnvelope {
  if (bindings.length === 0) {
    throw new ProviderBindingError('noBindings', 'an operational envelope over zero bindings describes no campaign');
  }
  const seen = new Set<string>();
  for (const binding of bindings) {
    validateBinding(binding);
    if (seen.has(binding.candidate)) {
      throw new ProviderBindingError('duplicateBinding',
        `${binding.candidate} has two bindings; a candidate reached two ways is two candidates and must be named as two`);
    }
    seen.add(binding.candidate);
  }
  const executionClasses = [...new Set(bindings.map((binding) => binding.executionClass))].sort();
  const providers = [...new Set(bindings.map((binding) => binding.provider))].sort();
  return {
    bindings,
    executionClasses,
    providers,
    mixed: executionClasses.length > 1,
    hasMeteredBinding: bindings.some(isMetered),
  };
}

export function operationalEnvelopeDigest(envelope: OperationalEnvelope): string {
  return digestObject(envelope as unknown as CanonicalValue);
}

/** Find one candidate's binding, or say plainly that the campaign does not bind it. */
export function bindingFor(envelope: OperationalEnvelope, candidate: string): ProviderBinding {
  const binding = envelope.bindings.find((entry) => entry.candidate === candidate);
  if (!binding) {
    throw new ProviderBindingError('unboundCandidate',
      `${candidate} has no provider binding in this campaign, so there is no record of who would be asked or who would pay`);
  }
  return binding;
}

/**
 * Why a mixed campaign's operational columns cannot be compared across execution classes.
 *
 * Written once, quoted everywhere, for the same reason `NONCANONICAL_REASONS` is: three surfaces
 * paraphrasing the same caveat is three chances for one of them to soften it.
 */
export const MIXED_EXECUTION_REASONS = [
  'this campaign contains candidates reached through more than one execution class, and they were not measured under the same conditions',
  'task outcomes (pass, partial, fail, requiresHumanReview) ARE comparable: every candidate answered the same frozen prompts, scored by the same frozen evaluators',
  'latency, time-to-first-token and throughput are NOT comparable across execution classes: a local model has no network, a subscription CLI pays a process launch, and a metered API sits behind somebody else\'s queue',
  'cost is not comparable either: local execution has no monetary cost, subscription execution consumes an allowance rather than a per-token charge, and only metered execution has a price per token',
  'a ranking that ordered these candidates by speed or by cost would be ordering their access methods, not their capabilities',
];

/**
 * What a pricing file is, and why there is one rather than a fetch.
 *
 * Cernum does not look up prices. A benchmark that fetched live pricing would produce an estimate
 * that changed between the preview and the run, would need network access to price a campaign, and
 * would have to decide what to do when the lookup failed — and every answer to that last question is
 * worse than asking a person. So prices are supplied, with their source and the moment they were
 * captured, and both are written into the manifest where a later reader can see how stale they are.
 */
export const PRICING_FILE_NOTE =
  'A pricing file maps "<provider>:<model>" to the provider\'s published prices, in microUSD per million tokens, '
  + 'with the source you took them from and when. Cernum never fetches prices: an estimate that changes between the '
  + 'preview and the run is not an estimate anybody can approve.';

/** Read one pricing entry out of a parsed pricing file, or explain what is missing. */
export function pricingFor(file: Record<string, unknown>, provider: ProviderID, modelID: string): PricingSnapshot | undefined {
  const entry = file[`${provider}:${modelID}`] ?? file[modelID];
  if (!entry || typeof entry !== 'object') return undefined;
  const row = entry as Record<string, unknown>;
  const integer = (value: unknown): number | undefined =>
    (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined);
  const input = integer(row.inputMicroUSDPerMillionTokens);
  const output = integer(row.outputMicroUSDPerMillionTokens);
  if (input === undefined || output === undefined) return undefined;
  if (typeof row.source !== 'string' || row.source.length === 0) return undefined;
  if (typeof row.capturedAt !== 'string' || row.capturedAt.length === 0) return undefined;
  return {
    source: row.source,
    capturedAt: row.capturedAt,
    currency: 'USD',
    inputMicroUSDPerMillionTokens: input,
    outputMicroUSDPerMillionTokens: output,
    reasoningMicroUSDPerMillionTokens: integer(row.reasoningMicroUSDPerMillionTokens) ?? null,
  };
}
