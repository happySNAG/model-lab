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
// both subscription CLIs because neither reports a generation duration, and what IS recorded is
// labelled as the client-observed or end-to-end figure it actually is.

import { CanonicalValue } from './canonical';
import { FrontierAdapter, FrontierRequest, FrontierResponse, totalInputTokens } from './frontier-adapter';
import { ProviderBinding, isMetered } from './provider';
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
  executionClass: string;
  billingBasis: string;

  /** What was asked for. */
  requestedModelID: string;
  /** What the provider said answered. Empty means it named nothing — never a copy of the request. */
  reportedModelID: string;
  /** Every model the provider said took part, when it named more than one. */
  participatingModelIDs: string[];
  effort: string;

  verdict: IdentityVerdict;
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

  /** Settings the tool could not enforce, carried so an unbounded request is visible as one. */
  notEnforceable: string[];
  /** The provider's own usage block, verbatim, for reconciling against a bill or a usage page. */
  providerReportedUsage?: CanonicalValue;
  attemptedAt: string;
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
  'neither subscription CLI reports the duration it spent GENERATING. The `claude` envelope carries `duration_ms` '
  + '(the turn\'s wall clock) and `duration_api_ms` (a sum across concurrent API calls, observed larger than the turn '
  + 'itself), and neither is a generation duration. A tokens-per-second computed from either would be presented as the '
  + 'provider\'s speed while actually measuring this machine, this network and the provider\'s queue.';

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

  const costs = costBreakdown({
    billingBasis: binding.billingBasis,
    meteredChargeMicroUSD: isMetered(binding) ? undefined : 0,
    meteredChargeProvenance: 'measured',
    providerReportedUsageMicroUSD: response.subscriptionIncludedUsageMicroUSD,
  });

  const { verdict, evidence } = judge(binding, response);

  return {
    candidate: binding.candidate,
    provider: binding.provider,
    executionClass: binding.executionClass,
    billingBasis: binding.billingBasis,
    requestedModelID: binding.requestedModelID,
    reportedModelID: response.reportedModelID,
    participatingModelIDs: response.participatingModelIDs ?? [],
    effort: binding.effort,
    verdict,
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
    notEnforceable: response.notEnforceable ?? [],
    providerReportedUsage: response.rawUsage,
    attemptedAt,
  };
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
      evidence: 'the provider answered but named no model, so which model produced this answer is not known. It is '
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
