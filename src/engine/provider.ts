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
export type ProviderID = 'ollama' | 'claudeCLI' | 'codexCLI' | 'opencodeCLI' | 'anthropicAPI' | 'openaiAPI';

export const PROVIDER_IDS: ProviderID[] = ['ollama', 'claudeCLI', 'codexCLI', 'opencodeCLI', 'anthropicAPI', 'openaiAPI'];

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
export type AuthorizationMode =
  | 'none'
  | 'subscriptionCLISession'
  | 'apiKeyEnvironment'
  | 'apiKeyKeychain'
  /**
   * The TOOL holds the credential and uses it; Cernum never reads, stores or passes one.
   *
   * Added in v0.2.3 for OpenCode, which is the first provider that is METERED and yet authenticates
   * itself. Neither existing mode is true of it: `apiKeyEnvironment` and `apiKeyKeychain` both claim
   * Cernum knows where a key lives, and `subscriptionCLISession` would assert a subscription for
   * something billed per token — the exact conflation `codexCLI` already refuses by hand. So the
   * manifest records what is actually the case: a credential exists, the tool owns it, and this
   * engine cannot say more than that.
   */
  | 'toolManagedCredential';

/**
 * A reasoning-effort level, as a frozen request.
 *
 * These are the names the providers themselves use. `none` means the request carries no effort
 * instruction at all, which is different from asking for low.
 */
export type EffortLevel = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * `xhigh` and `minimal` are here because the tools have them.
 *
 * Pass 4B modelled four levels plus `none`. The installed `claude` CLI documents FIVE — low, medium,
 * high, xhigh, max — and a ladder that cannot name `xhigh` cannot ask for it, which would have made
 * a level of the provider's own ladder permanently unreachable and invisible.
 *
 * PASS 5B ADDS `minimal`, for the same reason and from the same kind of evidence: the Codex service
 * names its own accepted set in the 400 it returns for an unknown one — `none`, `minimal`, `low`,
 * `medium`, `high`, `xhigh`, `max`. `minimal` was a level of a provider's ladder this engine could
 * not express.
 *
 * `ultra` IS DELIBERATELY ABSENT. The Codex catalogue lists it for three models and the Codex
 * service's effort enum does not contain it, because it is an orchestration mode that answers with a
 * tree of subagents rather than a reasoning level a single model runs at. See
 * `CODEX_ULTRA_IS_NOT_A_REASONING_EFFORT` in `codex-cli.ts`. A benchmark row naming one model must
 * have been produced by one model, so this ladder cannot name ultra and cannot ask for it.
 */
export const EFFORT_LEVELS: EffortLevel[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/**
 * The providers the identity exception may ever apply to. TWO, as of Pass 7.
 *
 * Declared here, next to the state itself, so `validateBinding` can enforce it without importing
 * `identity-admission` — which imports this module, and a cycle between the two would make the
 * enforcement depend on module evaluation order. `ADMISSIBLE_PROVIDERS` there is the authority a
 * person reads; this is the same fact where the binding validator can reach it, and a test asserts
 * the two never drift apart.
 *
 * THE BAR FOR MEMBERSHIP, which is narrow and is not "this candidate is hard to prove". A provider
 * belongs here only when its interface STRUCTURALLY cannot name the model that answered — so that a
 * candidate on it being unproven is a property of the tool rather than a fault in this engine or a
 * gap in someone's evidence. `claudeCLI` names its model, so a Claude candidate that cannot be proven
 * has a different problem and this exception would hide it. That is the test each entry has to pass,
 * and `IDENTITY_UNNAMEABLE_BECAUSE` is where each one shows its work.
 */
export const IDENTITY_ADMISSIBLE_PROVIDERS: ProviderID[] = ['codexCLI', 'opencodeCLI'];

/**
 * WHY each admissible provider cannot name the model that answered, in its own terms.
 *
 * Per provider rather than one sentence for both, because the two are not the same fault and a
 * message that described Codex's silence would be false about OpenCode's. Every refusal and every
 * evidence string reads the reason from here, so a reader is told which tool did what, not merely
 * that the exception applies.
 *
 * THE DIFFERENCE WORTH KNOWING BEFORE TRUSTING EITHER. Codex names no model in ANY reply, so its
 * silence is total and declared. OpenCode HAS the field and routes it away from the JSON stream, so a
 * substituted model would return byte-identical output and `modelMismatch` cannot fire — substitution
 * on that path is UNDETECTABLE rather than merely unproven. Both are admissible; they are not
 * equally informative, and neither is verified identity.
 */
export const IDENTITY_UNNAMEABLE_BECAUSE: Partial<Record<ProviderID, string>> = {
  codexCLI:
    '`codex exec --json` names no model in any event it emits — not `thread.started`, not '
    + '`item.completed`, not `turn.completed`. The silence is total, so a Codex reply can establish '
    + 'that the identifier was accepted and something answered, and never which model did.',
  opencodeCLI:
    '`opencode run --format json` emits no assistant message, which is the only place OpenCode names '
    + 'the model that answered: `run` reads that event solely in its non-JSON branch, to print it for '
    + 'a person. Captured 2026-09-20 from a live request. Because the field is absent rather than '
    + 'contradicted, a SUBSTITUTED model would return the same bytes and no mismatch check can catch '
    + 'it — this path cannot detect substitution at all, which is a strictly weaker position than '
    + 'Codex\'s and must not be read as an equivalent one.',
};

/** Whether the identity exception may apply to this provider at all. The greppable form of the rule. */
export function isIdentityAdmissibleProvider(provider: ProviderID): boolean {
  return IDENTITY_ADMISSIBLE_PROVIDERS.includes(provider);
}

/**
 * The name of the Pass 6 admission state, in one place.
 *
 * It lives in this module rather than in `identity-admission` because it is a member of
 * `BindingIdentityState`, and the type and its member drifting apart is exactly the sort of silent
 * divergence this engine spends its effort refusing. `identity-admission` re-exports it.
 */
export const REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE = 'requestAcceptedIdentityUnverifiable' as const;

/**
 * What is actually known about the model identity behind a binding.
 *
 * There is no `assumed`. A provider that did not confirm which model answered leaves the binding
 * `unverifiable`, and that word appears on every artefact the run produces.
 *
 * `requestAcceptedIdentityUnverifiable` — ADDED IN PASS 6, EXTENDED TO OPENCODE IN PASS 7 — is
 * weaker than `unverifiable`, not stronger. `unverifiable` is what a binding gets when nothing
 * established an identity; this third state says that AND that the campaign carried a sealed,
 * campaign-bound authorization to run the candidate anyway. It records one fact and one only: THE
 * PROVIDER ACCEPTED THIS IDENTIFIER AND SOMETHING ANSWERED. It is never a claim about which model
 * answered, it never reaches `verifiedModelID`, and it is not routable or promotable. It applies only
 * to `IDENTITY_ADMISSIBLE_PROVIDERS`. See `identity-admission.ts`.
 */
export type BindingIdentityState = 'verified' | 'unverifiable' | typeof REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE;

/**
 * WHAT KIND OF REQUEST A BINDING DESCRIBES, AND THEREFORE WHAT ITS BUDGETS MEAN.
 *
 * Every binding before this pass described one shape of request: a prompt goes out, a completion
 * comes back, and `maxInputTokens`/`maxOutputTokens` are the ceiling the request itself carries.
 * `validateBinding` refused a zero on either, and it was right to: a prose request whose output
 * ceiling is zero asks a provider for nothing.
 *
 * A WORKSPACE TASK IS NOT THAT SHAPE. What goes out is an instruction and a directory; what comes
 * back is a tree. `ClaudeWorkspaceDriver` documents the consequence in
 * `CLAUDE_OUTPUT_IS_NOT_BOUNDED`: this CLI has no output-token budget flag that applies to a
 * subscription session, so there is nowhere in the invocation to PUT a ceiling. A workspace binding
 * carrying `maxOutputTokens: 4096` would be a binding whose frozen number never reached the tool —
 * the same defect `unexpressed` refuses a run over on the driver side.
 *
 * So the contract is declared, and the budget rule follows from it rather than from a number. The
 * two facts a reader must never confuse — "zero because nobody configured a budget" and "zero
 * because the contract cannot carry one" — are now different FIELDS rather than the same integer,
 * and each is refused in the other's place.
 *
 * ABSENT MEANS `proseCompletion`. `canonicalJSON` drops an undefined key entirely, so every
 * envelope already frozen to disk hashes to exactly the bytes it always did, and every existing
 * binding is validated under exactly the rule it was written against.
 */
export type ExecutionContract =
  /** A prompt out, a completion back. The budgets are the request's own ceiling. */
  | 'proseCompletion'
  /** An instruction and a directory out, a tree back. See `workspace-case.ts`. */
  | 'workspaceTask';

/**
 * How the provider-side token ceiling is expressed — stated, never inferred from a zero.
 *
 * `notExpressibleByContract` is an ASSERTION, not a permission. It says the execution contract has
 * no field for a ceiling, so the binding names none; it does not say the run is unmeasured. Tokens,
 * cost and plan allowance are still read off the provider's own reply afterwards and recorded on
 * the same `FrontierAttemptRecord` a prose attempt produces, and a metered binding is still checked
 * against the spend ceiling before the attempt — `worstCaseAttemptMicroUSD` reads the budgets, so a
 * metered workspace binding is refused by `unboundedMeteredWorkspaceBinding` below rather than
 * allowed through a ceiling it would compute as zero.
 */
export type TokenCeilingExpression =
  /** The binding names a positive input and output budget and the request carries them. */
  | 'boundedByBinding'
  /** The contract has nowhere to put one. Only ever legal on a `workspaceTask` binding. */
  | 'notExpressibleByContract';

export const WORKSPACE_TOKEN_CEILING_IS_UNEXPRESSED =
  'this binding describes a workspace task, whose execution contract has no field for a provider-side token ceiling: '
  + 'the instruction and a directory go out and a tree comes back, and the installed CLI documents no output budget '
  + 'that applies to a subscription session. The binding therefore names NO ceiling rather than naming one that would '
  + 'never reach the tool. What the request actually consumed is measured after the fact, from the provider\'s own '
  + 'usage block, and recorded on the same attempt record a prose attempt produces.';

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
  /**
   * What shape of request this binding describes. Absent means `proseCompletion`, which is what
   * every binding frozen before this pass is, and what every prose binding stays.
   */
  executionContract?: ExecutionContract;
  /**
   * Whether the two budgets below are a ceiling or an admitted absence. Absent means
   * `boundedByBinding`, so a binding that says nothing is held to the rule it always was.
   */
  tokenCeiling?: TokenCeilingExpression;
  /** The request's ceiling when `tokenCeiling` is `boundedByBinding`; exactly 0 when it is not. */
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
    // OPENCODE IS A CLI YOU INSTALL, BILLED LIKE AN API. The execution class describes BILLING, and
    // the credential OpenCode reports is an API key against a metered service. Calling it
    // `subscriptionCLI` would stamp every OpenCode row `subscriptionIncluded` with a zero marginal
    // charge -- the same misreport `codexCLI` already refuses by hand. See `opencode-cli.ts`.
    case 'opencodeCLI': return 'meteredAPI';
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

/**
 * How a provider authorises a request, fixed by what the provider IS.
 *
 * THE THIRD THING THE REGISTRY HAS TO OWN. `executionClassOf` and `billingBasisOf` were already
 * derived here, and `validateBinding` already refuses a binding whose authorization mode does not
 * match its execution class — but there was no function that ANSWERED the question, so every caller
 * that had to build a binding wrote the answer out by hand. The identity smoke path wrote
 * `subscriptionCLISession` for every provider it was given, including a metered one, and nothing
 * caught it because nothing validated a smoke binding.
 *
 * Derived from the execution class rather than listed per provider, so a provider added later is
 * answered by the class it is reached through and cannot be forgotten here.
 */
export function authorizationModeForProvider(provider: ProviderID): AuthorizationMode {
  switch (executionClassOf(provider)) {
    case 'localRuntime': return 'none';
    case 'subscriptionCLI': return 'subscriptionCLISession';
    case 'meteredAPI':
      // OpenCode is the one metered provider that holds its own credential: Cernum never reads it,
      // never passes one, and cannot say where it lives. The published HTTP APIs are reached with a
      // key the user supplied, which this engine looks for in the environment first.
      return provider === 'opencodeCLI' ? 'toolManagedCredential' : 'apiKeyEnvironment';
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
  opencodeCLI: 'OpenCode (metered API)',
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
    : binding.identityState === REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE
      // Longer than the other two on purpose. This is the state a reader is most likely to skim past
      // as though it said "verified", so the one line it gets says what it is and what it is not.
      ? `request ACCEPTED, identity UNVERIFIABLE — ${binding.requestedModelID} was accepted and something `
        + 'answered; the provider named no model, so this is not a claim that this model answered'
      : 'identity UNVERIFIABLE';
  const effort = binding.effort === 'none' ? 'no effort instruction' : `effort ${binding.effort}`;
  const thinking = binding.thinkingMode === 'enabled' ? 'thinking on'
    : binding.thinkingMode === 'disabled' ? 'thinking off'
      : 'thinking left to the provider';
  // Appended only where it is true, so every prose line is byte-identical to what it always was.
  const contract = isWorkspaceBinding(binding)
    ? ' · workspace task · no provider token ceiling (the contract carries none; usage is measured after the fact)'
    : '';
  return `${PROVIDER_LABELS[binding.provider]} · ${EXECUTION_CLASS_LABELS[binding.executionClass]} · `
    + `${binding.requestedModelID} · ${identity} · ${effort} · ${thinking} · ${billingLabel(binding)}${contract}`;
}

/**
 * Refuse a binding that cannot be executed honestly, BEFORE anything is frozen.
 *
 * Every one of these is a refusal rather than a repair. A binding that had its missing pricing
 * filled in with a plausible number, or its execution class corrected to match its provider, would
 * be a binding that says something nobody checked.
 */
export interface BindingValidationOptions {
  /**
   * Permit a metered binding that carries no pricing snapshot.
   *
   * THE ONLY CALLER ALLOWED TO PASS THIS IS THE IDENTITY SMOKE PATH, and only when the person
   * running it typed `--authorize-unpriced-metered` for an exactly-one-request scope. A campaign
   * never passes it: a campaign is many requests whose total cannot be bounded without a price, and
   * refusing to run one it cannot price is the guard `meteredWithoutPricing` exists to be.
   *
   * It relaxes the PRICE requirement and nothing else. The binding is still metered, still records
   * `meteredAPI`, and its cost is still recorded as UNAVAILABLE rather than as zero — see
   * `smoke-binding.ts`, where the acknowledgement that the provider may bill an amount nobody can
   * state is written down beside the request it authorises.
   */
  allowUnpricedMetered?: boolean;
}

/**
 * The contract a binding describes. ABSENT MEANS PROSE, so nothing frozen before this pass moves.
 *
 * A function rather than a default on the struct, because a default written into `makeBinding` would
 * be a default the bindings already on disk never got, and this has to answer the same for both.
 */
export function executionContractOf(binding: Pick<ProviderBinding, 'executionContract'>): ExecutionContract {
  return binding.executionContract ?? 'proseCompletion';
}

/** How this binding expresses its token ceiling. Absent means it names one, as every prose binding does. */
export function tokenCeilingOf(binding: Pick<ProviderBinding, 'tokenCeiling'>): TokenCeilingExpression {
  return binding.tokenCeiling ?? 'boundedByBinding';
}

/** True when this binding describes a repository task rather than a prompt. */
export function isWorkspaceBinding(binding: Pick<ProviderBinding, 'executionContract'>): boolean {
  return executionContractOf(binding) === 'workspaceTask';
}

export function validateBinding(binding: ProviderBinding, options: BindingValidationOptions = {}): void {
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
  if (binding.identityState === REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE) {
    // The two refusals that keep the exception from becoming a way to launder an identity: it
    // applies to a closed list of providers, and its returned-model field stays empty forever.
    // Enforced HERE, in the validator every binding passes through, rather than only in the builder
    // that writes one — a binding assembled by any other route is refused on exactly the same terms.
    if (!isIdentityAdmissibleProvider(binding.provider)) {
      throw new ProviderBindingError('identityAdmissionProviderNotAdmissible',
        `${binding.candidate}: the accepted-request identity state applies only to `
        + `${IDENTITY_ADMISSIBLE_PROVIDERS.join(', ')}, whose interfaces structurally cannot name the model that `
        + `answered. ${binding.provider} does report identity, so a candidate on it that could not be proven has a `
        + 'different problem, and recording it under this state would conceal that.');
    }
    if (binding.verifiedModelID.length > 0) {
      throw new ProviderBindingError('identityAdmissionWithReturnedIdentity',
        `${binding.candidate}: this binding carries the accepted-request identity state AND a returned model `
        + 'identifier. Those cannot both be true: if the provider named a model, the binding is verified and needs '
        + 'no exception. Never backfill the requested identifier into the returned-model field.');
    }
  }
  if (isMetered(binding) && binding.pricing === null && !options.allowUnpricedMetered) {
    throw new ProviderBindingError('meteredWithoutPricing',
      `${binding.candidate}: a metered binding without a pricing snapshot cannot have its cost estimated, and Cernum `
      + 'refuses a paid run it cannot price rather than guessing at what it will spend');
  }
  if (!isMetered(binding) && binding.pricing !== null) {
    throw new ProviderBindingError('unmeteredWithPricing',
      `${binding.candidate}: ${binding.billingBasis} execution is not billed per token, so a per-token price on it `
      + 'would be a number that looks like a cost and is not one');
  }
  // THE BUDGET RULE, DECIDED BY THE EXECUTION CONTRACT RATHER THAN BY THE NUMBER.
  //
  // Nothing about the prose rule is relaxed: a binding that does not declare otherwise is
  // `boundedByBinding`, and a zero on either side is still `emptyBudget`. What changes is that a
  // binding may now SAY its contract has no ceiling to carry — and saying so costs it the right to
  // name one, so the two readings of a zero can never be mistaken for each other.
  const contract = executionContractOf(binding);
  const ceiling = tokenCeilingOf(binding);
  if (ceiling === 'boundedByBinding') {
    if (binding.maxOutputTokens <= 0 || binding.maxInputTokens <= 0) {
      throw new ProviderBindingError('emptyBudget', `${binding.candidate}: input and output budgets must both be positive`);
    }
  } else {
    if (contract !== 'workspaceTask') {
      throw new ProviderBindingError('ceilingNotExpressibleOutsideWorkspace',
        `${binding.candidate}: only a workspaceTask binding may declare that its contract cannot carry a token `
        + 'ceiling. A prose request has a place to put one, so a prose binding that named no ceiling would be a '
        + 'binding nobody had configured rather than one nobody could configure.');
    }
    if (binding.maxInputTokens !== 0 || binding.maxOutputTokens !== 0) {
      throw new ProviderBindingError('unexpressedCeilingWithBudget',
        `${binding.candidate}: this binding declares that its execution contract cannot carry a token ceiling AND `
        + `names one (${binding.maxInputTokens} in, ${binding.maxOutputTokens} out). Those cannot both be true. A `
        + 'number frozen here would never reach the tool, and a manifest that recorded it would describe a limit '
        + 'that was never in force.');
    }
    if (isMetered(binding)) {
      // FAIL CLOSED, and this is the one refusal that keeps the exception from becoming a hole in
      // the spending ceiling. `worstCaseAttemptMicroUSD` bounds a metered attempt from the frozen
      // budgets; with no budgets it would bound it at zero, and a ceiling that computes every
      // attempt as free is not a ceiling. A metered workspace run needs a contract that can carry a
      // bound before it can be authorised, and there is not one yet.
      throw new ProviderBindingError('unboundedMeteredWorkspaceBinding',
        `${binding.candidate}: this binding is billed per token and declares no token ceiling, so the worst case for `
        + 'one attempt cannot be computed and the spending ceiling would be enforced against zero. Cernum refuses a '
        + 'paid run it cannot bound. A subscription workspace run is unaffected: its marginal API charge is zero and '
        + 'the allowance it consumes is recorded rather than bounded.');
    }
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
      && binding.authorizationMode !== 'apiKeyEnvironment' && binding.authorizationMode !== 'apiKeyKeychain'
      && binding.authorizationMode !== 'toolManagedCredential') {
    throw new ProviderBindingError('meteredAuthorization',
      `${binding.candidate}: a metered API binding must name where its key comes from — an environment `
      + 'variable, the keychain, or the tool itself when the tool is the thing holding it');
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
