// Benchmark engine · one minimal request, asked only to find out who answers it.
//
// WHAT THIS IS FOR. Discovery can tell us a CLI is installed and signed in. For the `claude` CLI it
// can tell us nothing else, because that tool has no model-listing command: there is no machine-
// readable answer to "which models may this subscription call". So the only honest route from
// `unproven` to `proven` is to ask one model one question and read WHO ANSWERED out of the reply.
//
// THIS SPENDS ALLOWANCE, AND THAT IS WHY IT IS SEPARATE. A status read is free and happens
// constantly. This is a real request against a real plan, so it is its own function, it is called
// only when a person asks for it by name, and it sends EXACTLY ONE request per candidate.
//
// NO RETRY. NOT EVEN ONCE. A smoke test that retried would spend a second allowance slot to get a
// second opinion about the same question, and the temptation it creates — run it again, maybe it
// says `proven` this time — is precisely the temptation that turns a preflight into a way of
// producing the answer somebody wanted. One request, one verdict, recorded whatever it says.
//
// FOUR VERDICTS, AND NONE OF THEM IS A GUESS.
//
//   proven         the provider named the model, and it is the model that was asked for.
//   substituted    the provider named a model, and it is a DIFFERENT one. Never quietly accepted:
//                  a real answer from the wrong model is worse than no answer, because it looks
//                  exactly like the answer that was wanted.
//   unverifiable   the provider answered and named no model at all. Carried and labelled. Never
//                  upgraded to `proven` by assuming the request was honoured.
//   refused        the account, the model or the effort level was rejected. A fact about access,
//                  recorded as such rather than retried away.
//
// THE MEASUREMENTS IT TAKES ARE MINIMAL AND HONEST. A single tiny request is not a benchmark and
// nothing here pretends otherwise: `providerReportedGenerationTokensPerSecond` is `unavailable` for
// every CLI this engine drives because none reports a generation duration, and what IS recorded is
// labelled as the client-observed or end-to-end figure it actually is.
//
// v0.2.4: WHAT IT COSTS IS READ OFF THE BINDING, NOT ASSUMED. Until v0.2.4 the caller built the
// binding by hand and wrote `subscriptionIncluded` into it for every provider, so a metered OpenCode
// smoke would have recorded a $0 marginal charge against a request the provider bills for. The
// binding now comes from `smoke-binding.ts`, which derives billing from the provider registry, and
// a metered request with no price records its cost as UNAVAILABLE — never as zero.

import { CanonicalValue } from './canonical';
import { FrontierAdapter, FrontierRequest, FrontierResponse, totalInputTokens } from './frontier-adapter';
import {
  BindingIdentityState, IDENTITY_ADMISSIBLE_PROVIDER, ProviderBinding,
  REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE, isMetered,
} from './provider';
import {
  Quantity, clientObservedOutputThroughputMilli, costBreakdown, endToEndOutputThroughputMilli,
  measuredQuantity, providerReportedGenerationThroughputMilli, reportedQuantity, unavailableQuantity,
} from './frontier-metrics';
import { redactSecrets } from './redaction';

/** What one minimal request established about who is on the other end. */
export type IdentityVerdict = 'proven' | 'substituted' | 'unverifiable' | 'refused';

/**
 * THE PROMPT. One line, no context, no instructions beyond the answer itself.
 *
 * It is a constant rather than a parameter because a smoke test whose prompt varied would produce
 * token counts that could not be compared between candidates, and because the point is to spend as
 * little of somebody's allowance as the question allows.
 */
export const IDENTITY_SMOKE_PROMPT = 'Reply with only: ok';

export interface IdentitySmokeResult {
  candidate: string;
  provider: string;
  /** DERIVED FROM THE PROVIDER REGISTRY, never written by hand. See `smoke-binding.ts`. */
  executionClass: string;
  billingBasis: string;
  /** How the caller was authorised for this request — the shape of it, never a credential. */
  authorizationMode: string;
  /** Where the prices behind any cost figure came from, or null when there were none. */
  pricingSource: string | null;

  /** What was asked for. */
  requestedModelID: string;
  /** What the provider said answered. Empty means it named nothing — never a copy of the request. */
  reportedModelID: string;
  /** Every model the provider said took part, when it named more than one. */
  participatingModelIDs: string[];
  effort: string;

  verdict: IdentityVerdict;
  /**
   * WHAT THIS REQUEST ESTABLISHED ABOUT IDENTITY, in the engine's own vocabulary.
   *
   * `verified` only when the provider named the model and it matched. For `codexCLI` — whose `exec`
   * names no model in any reply — a request the provider ACCEPTED and answered lands on
   * `requestAcceptedIdentityUnverifiable`: weaker than `unverifiable`, not stronger, and never a
   * claim about which model answered. Everything else stays `unverifiable`.
   */
  identityState: BindingIdentityState;
  /** In words, always populated: what established this verdict, or what is missing. */
  evidence: string;

  /** The answer, trimmed. Kept short: this is evidence of who replied, not a result to score. */
  answerText: string;

  inputTokens: Quantity;
  visibleOutputTokens: Quantity;
  reasoningTokens: Quantity;
  totalTokens: Quantity;

  timeToFirstVisibleTokenMilliseconds: Quantity;
  totalWallClockMilliseconds: Quantity;
  providerReportedGenerationTokensPerSecondMilli: Quantity;
  clientObservedOutputTokensPerSecondMilli: Quantity;
  endToEndOutputTokensPerSecondMilli: Quantity;

  marginalAPIChargeMicroUSD: Quantity;
  subscriptionIncludedUsageMicroUSD: Quantity;
  effectiveUserCostMicroUSD: Quantity;

  /** Always zero. Present so a reader can see it was zero rather than assume it. */
  retryCount: number;
  wastedTokens: number;

  /**
   * What the provider said about the effort or thinking it APPLIED, when it said anything.
   *
   * Empty string means it reported nothing, which is not the same as reporting that it applied none.
   */
  reportedEffort: string;
  /**
   * WHY GENERATION STOPPED, in the provider's own word — `stop`, `length`, `end_turn`, `max_tokens`.
   *
   * Empty string means the provider named no terminal reason, which is not the same as saying it
   * finished. Always present so a reader can see which of the two this was, and never written as
   * `stop` on the engine's own initiative.
   */
  finishReason: string;
  /**
   * THE TOOL'S OWN TELEMETRY ABOUT THIS TURN, when a collector was asked for.
   *
   * Codex only, opt-in only. It carries the reasoning effort the CLI says it applied — which `codex
   * exec --json` never echoes — and its token decomposition. IT ESTABLISHES NO IDENTITY: the `model`
   * attribute in that telemetry is the identifier this client SENT, so a Codex row stays
   * `requestAcceptedIdentityUnverifiable` however complete the telemetry is.
   */
  telemetry?: IdentitySmokeTelemetry;

  /** Settings the tool could not enforce, carried so an unbounded request is visible as one. */
  notEnforceable: string[];
  /** The provider's own usage block, verbatim, for reconciling against a bill or a usage page. */
  providerReportedUsage?: CanonicalValue;
  attemptedAt: string;
}

/** The subset of a tool's own telemetry an identity smoke records. Never an identity claim. */
export interface IdentitySmokeTelemetry extends Record<string, CanonicalValue | undefined> {
  /** The redactor's placeholder for this conversation. Stable within a run, meaningless outside it. */
  correlationKey: string;
  /** True when a turn span had already arrived while the request was still open. Often false. */
  correlated: boolean;
  /** `codex.turn.reasoning_effort` — the effort the CLI says it APPLIED. */
  turnReasoningEffort?: string;
  /** `codex.request.reasoning_effort` — the effort it says it SENT. */
  requestReasoningEffort?: string;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  totalTokens?: number;
  /** How many telemetry records mentioned this conversation. Zero means it was never seen. */
  recordCount: number;
}

export interface IdentitySmokeOptions {
  now?: () => Date;
  clock?: () => number;
  shouldCancel?: () => boolean;
}

/**
 * Ask one model, once, who it is.
 *
 * The binding is used EXACTLY AS FROZEN. Nothing here relaxes a timeout, widens a budget or drops an
 * effort level to coax an answer out of a provider that refused one — a smoke test that adjusted the
 * request until it succeeded would prove the adjusted request works and would be recorded as proving
 * the frozen one does.
 */
export async function identitySmokeTest(binding: ProviderBinding, adapter: FrontierAdapter,
                                        options: IdentitySmokeOptions = {}): Promise<IdentitySmokeResult> {
  const now = options.now ?? (() => new Date());
  const clock = options.clock ?? (() => Date.now());
  const attemptedAt = now().toISOString().replace(/\.\d{3}Z$/, 'Z');

  const request: FrontierRequest = {
    binding,
    promptText: IDENTITY_SMOKE_PROMPT,
    shouldCancel: options.shouldCancel,
    now: clock,
  };

  // Called once. There is no loop here and `withRetry` is deliberately not used.
  const response = await adapter.complete(request);
  return readSmoke(binding, response, attemptedAt);
}

const NO_GENERATION_DURATION_FROM_CLI =
  'no CLI this engine drives reports the duration it spent GENERATING. The `claude` envelope carries `duration_ms` '
  + '(the turn\'s wall clock) and `duration_api_ms` (a sum across concurrent API calls, observed larger than the turn '
  + 'itself); `codex exec` reports no duration at all; and the OpenCode assistant message carries created and completed '
  + 'timestamps, which bound the whole turn rather than its generation. None of them is a generation duration. A '
  + 'tokens-per-second computed from any of them would be presented as the provider\'s speed while actually measuring '
  + 'this machine, this network and the provider\'s queue.';

/** Fold one response into a verdict and its measurements. Exported so a fixture can be read directly. */
export function readSmoke(binding: ProviderBinding, response: FrontierResponse, attemptedAt: string): IdentitySmokeResult {
  const quantityOf = (value: number | undefined, missing: string): Quantity =>
    (value === undefined ? unavailableQuantity(missing)
      : response.usageProvenance === 'providerReported' ? reportedQuantity(value) : measuredQuantity(value));

  const input = quantityOf(totalInputTokens(response.usage),
    'the provider reported no input token count for this request');
  const visible = quantityOf(response.usage.visibleOutputTokens,
    'the provider reported no visible output token count for this request');
  const reasoning = response.usage.reasoningTokens === undefined
    ? unavailableQuantity('this provider did not report reasoning tokens separately, which is not the same as zero')
    : quantityOf(response.usage.reasoningTokens, '');
  const totalTokens = input.provenance === 'unavailable' || visible.provenance === 'unavailable'
    ? unavailableQuantity('at least one half of this request\'s token count is unknown, so its total is not known')
    : { provenance: input.provenance, value: (input.value ?? 0) + (visible.value ?? 0) + (reasoning.value ?? 0) };

  // THE COST OF A METERED REQUEST IS NEVER ZERO BY DEFAULT.
  //
  // `meteredChargeMicroUSD: undefined` is what makes `costBreakdown` record `unavailable` with a
  // reason. A price is used only where prices were SUPPLIED and the provider reported the tokens to
  // apply them to; the result is labelled `estimated`, because a computed charge is a derivation
  // from a published rate and not the figure on anybody's bill. With no price, or with no reported
  // tokens, the answer is UNAVAILABLE — which is not zero, and is not free.
  const metered = isMetered(binding);
  const costs = costBreakdown({
    billingBasis: binding.billingBasis,
    meteredChargeMicroUSD: metered ? meteredChargeFrom(binding, input, visible, reasoning) : 0,
    meteredChargeProvenance: metered ? 'estimated' : 'measured',
    meteredChargeUnavailableReason: !metered ? undefined
      : binding.pricing ? 'this request is billed per token and prices were supplied, but the provider reported no '
        + 'token count to apply them to, so what it will charge is not known and no budget is written in place of a bill'
        : 'this request is billed per token against your own credential and Cernum holds no price for this candidate, '
        + 'so its charge is UNAVAILABLE — not zero, not free, and not estimated. The amount exists only on your '
        + 'provider account.',
    providerReportedUsageMicroUSD: response.subscriptionIncludedUsageMicroUSD,
  });

  const { verdict, evidence } = judge(binding, response);

  return {
    candidate: binding.candidate,
    provider: binding.provider,
    executionClass: binding.executionClass,
    billingBasis: binding.billingBasis,
    authorizationMode: binding.authorizationMode,
    pricingSource: binding.pricing ? `${binding.pricing.source} (captured ${binding.pricing.capturedAt})` : null,
    requestedModelID: binding.requestedModelID,
    reportedModelID: response.reportedModelID,
    participatingModelIDs: response.participatingModelIDs ?? [],
    effort: binding.effort,
    verdict,
    identityState: identityStateFrom(binding, response, verdict),
    evidence,
    answerText: redactSecrets(response.answerText).trim().slice(0, 200),
    inputTokens: input,
    visibleOutputTokens: visible,
    reasoningTokens: reasoning,
    totalTokens,
    timeToFirstVisibleTokenMilliseconds: response.firstVisibleTokenMilliseconds === undefined
      ? unavailableQuantity('no first visible output was observed arriving for this request')
      : measuredQuantity(response.firstVisibleTokenMilliseconds),
    totalWallClockMilliseconds: measuredQuantity(response.totalElapsedMilliseconds),
    // Asked for honestly, and answered `unavailable` for every subscription CLI there is.
    providerReportedGenerationTokensPerSecondMilli: providerReportedGenerationThroughputMilli(
      visible, unavailableQuantity(NO_GENERATION_DURATION_FROM_CLI)),
    clientObservedOutputTokensPerSecondMilli: clientObservedOutputThroughputMilli(
      visible, response.firstVisibleTokenMilliseconds, response.totalElapsedMilliseconds),
    endToEndOutputTokensPerSecondMilli: endToEndOutputThroughputMilli(visible, response.totalElapsedMilliseconds),
    marginalAPIChargeMicroUSD: costs.marginalAPIChargeMicroUSD,
    subscriptionIncludedUsageMicroUSD: costs.subscriptionIncludedUsageMicroUSD,
    effectiveUserCostMicroUSD: costs.effectiveUserCostMicroUSD,
    retryCount: response.retryCount,
    wastedTokens: response.wastedTokens,
    reportedEffort: response.reportedEffort ?? '',
    finishReason: response.finishReason ?? '',
    telemetry: response.otlpTurn === undefined ? undefined : {
      correlationKey: response.otlpTurn.correlationKey,
      correlated: response.otlpTurn.correlated,
      turnReasoningEffort: response.otlpTurn.turnReasoningEffort,
      requestReasoningEffort: response.otlpTurn.requestReasoningEffort,
      inputTokens: response.otlpTurn.inputTokens,
      cachedInputTokens: response.otlpTurn.cachedInputTokens,
      outputTokens: response.otlpTurn.outputTokens,
      reasoningOutputTokens: response.otlpTurn.reasoningOutputTokens,
      totalTokens: response.otlpTurn.totalTokens,
      recordCount: response.otlpTurn.recordCount,
    },
    notEnforceable: response.notEnforceable ?? [],
    providerReportedUsage: response.rawUsage,
    attemptedAt,
  };
}

/**
 * The charge for one metered request, where there is honestly one to compute.
 *
 * Returns `undefined` — which `costBreakdown` turns into `unavailable` WITH A REASON — whenever
 * either half of the input is missing. That is the whole point: an OpenCode request whose price
 * Cernum does not hold has an unknown cost, and an unknown cost written as `0` is the single most
 * misleading number this engine could produce about somebody's money.
 */
function meteredChargeFrom(binding: ProviderBinding, input: Quantity, visible: Quantity,
                           reasoning: Quantity): number | undefined {
  // `?? null` rather than `=== null`: a binding assembled by a caller that simply omitted the field
  // has no price either, and reading `undefined.source` to find that out would be a crash where the
  // honest answer is "unavailable".
  const price = binding.pricing ?? null;
  if (price === null) return undefined;
  if (input.provenance === 'unavailable' || visible.provenance === 'unavailable') return undefined;
  const reasoningTokens = reasoning.provenance === 'unavailable' ? 0 : (reasoning.value ?? 0);
  const reasoningRate = price.reasoningMicroUSDPerMillionTokens ?? price.outputMicroUSDPerMillionTokens;
  return Math.ceil(((input.value ?? 0) * price.inputMicroUSDPerMillionTokens) / 1_000_000)
    + Math.ceil(((visible.value ?? 0) * price.outputMicroUSDPerMillionTokens) / 1_000_000)
    + Math.ceil((reasoningTokens * reasoningRate) / 1_000_000);
}

/**
 * What this request established about identity, as a binding state rather than only as a verdict.
 *
 * THE CODEX CASE IS THE REASON THIS FUNCTION EXISTS. `codex exec` answers and names no model, so a
 * Codex smoke can never reach `verified` — and recording it as plain `unverifiable` loses the one
 * fact it DID establish: the provider accepted this identifier and something answered. That is
 * exactly what `requestAcceptedIdentityUnverifiable` means, and it is the state the Pass 6 admission
 * machinery reads. It is never a claim about which model answered, it never reaches
 * `verifiedModelID`, and it never makes a candidate selectable on its own.
 */
function identityStateFrom(binding: ProviderBinding, response: FrontierResponse,
                           verdict: IdentityVerdict): BindingIdentityState {
  if (verdict === 'proven') return 'verified';
  if (verdict !== 'unverifiable') return 'unverifiable';
  // A request that never completed established nothing, not even acceptance.
  if (response.failure) return 'unverifiable';
  if (binding.provider !== IDENTITY_ADMISSIBLE_PROVIDER) return 'unverifiable';
  return REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE;
}

/** The verdict, and the sentence that has to survive being read back a year later. */
function judge(binding: ProviderBinding, response: FrontierResponse): { verdict: IdentityVerdict; evidence: string } {
  if (response.failure) {
    const kind = response.failure.kind;
    const refused = kind === 'refused' || kind === 'notAuthenticated' || kind === 'budgetRefused';
    return {
      verdict: refused ? 'refused' : 'unverifiable',
      evidence: refused
        ? `the provider rejected this request (${kind}): ${response.failure.detail}`
        : `this request did not complete (${kind}), so nothing was established about who would have answered: `
          + `${response.failure.detail}`,
    };
  }
  if (response.reportedModelID.length === 0) {
    return {
      verdict: 'unverifiable',
      evidence: binding.provider === IDENTITY_ADMISSIBLE_PROVIDER
        // The Codex CLI names no model in any reply, so this is the strongest true statement there is
        // about a Codex request: the provider ACCEPTED the identifier and something answered. It is
        // recorded as `requestAcceptedIdentityUnverifiable`, which is weaker than unverifiable rather
        // than stronger, and it is never a claim that the model asked for is the model that answered.
        ? `${binding.requestedModelID} was accepted and something answered, but the provider named no model in its `
          + 'reply — `codex exec` never does. WHICH model produced this answer is not known, and it is recorded as '
          + 'unverifiable rather than assumed to be the model that was requested. The state is '
          + 'requestAcceptedIdentityUnverifiable: the request was ACCEPTED and the identity is UNVERIFIABLE. That is '
          + 'not proof, it makes nothing selectable, and putting such a candidate under measurement takes a separate '
          + 'sealed authorization.'
        : 'the provider answered but named no model, so which model produced this answer is not known. It is '
          + 'recorded as unverifiable rather than assumed to be the model that was requested.',
    };
  }
  if (response.reportedModelID !== binding.requestedModelID
      && !(response.participatingModelIDs ?? []).includes(binding.requestedModelID)) {
    return {
      verdict: 'substituted',
      evidence: `${binding.requestedModelID} was requested and ${response.reportedModelID} answered. A real answer from `
        + 'a different model is not a result for the model that was asked for, and is never recorded as one.',
    };
  }
  const others = (response.participatingModelIDs ?? []).filter((id) => id !== response.reportedModelID);
  return {
    verdict: 'proven',
    evidence: `the provider named ${response.reportedModelID} as the model that answered a minimal identity request, `
      + `and it matches what was requested (${binding.requestedModelID})`
      + (others.length === 0 ? '.'
        : `. The tool also routed part of this invocation to ${others.join(', ')} for its own housekeeping; that is `
          + 'recorded because the allowance figure covers the whole invocation, not only the model under test.'),
  };
}

/** One line per smoke, for a terminal. Prints the verdict and never rounds it off. */
export function describeSmoke(result: IdentitySmokeResult): string {
  const effort = result.effort === 'none' ? 'no effort flag' : `effort ${result.effort}`;
  const returned = result.reportedModelID.length === 0 ? 'named nothing' : `returned ${result.reportedModelID}`;
  return `${result.verdict.padEnd(12)} ${result.requestedModelID.padEnd(22)} ${effort.padEnd(16)} ${returned}`;
}
