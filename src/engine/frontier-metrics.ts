// Benchmark engine · the numbers a frontier campaign produces, each one carrying how it was obtained.
//
// PASS 3 HAD TWO STATES: measured, or unavailable with a reason. That was exactly right for a local
// runtime, where either the runtime counted something or it did not. It is not enough here, because a
// frontier campaign produces a third and a fourth kind of number:
//
//   measured          this process watched it happen — a wall clock, a byte arrival time.
//   providerReported  the provider told us — its own usage block, its own token counts.
//   estimated         nobody counted it; it was derived by a stated method from something that was.
//   unavailable       it is not known, and the reason is recorded rather than a zero being written.
//
// These four are NOT interchangeable and they are never silently promoted. A provider-reported token
// count and a locally estimated one differ by exactly the thing that matters — whether anybody
// actually counted — and a cost computed from the second is a cost nobody can reconcile against a
// bill. So every quantity here carries its provenance, aggregation carries the WORST provenance of
// its inputs, and the report prints it.
//
// COST PER SUCCESSFUL TASK IS THE NUMBER THAT ACTUALLY MATTERS, and it is not cost divided by
// attempts. A model that answers twice as fast and fails half the time costs MORE per useful answer,
// not less, and money spent on a failed attempt is money spent. So the denominator is successes and
// the numerator is TOTAL spend including the failures — including the retries, which is why wasted
// tokens are tracked as their own figure rather than being quietly folded into the total.
//
// A MODEL WITH NO SUCCESSES HAS NO COST PER SUCCESS. Not infinity, not zero, not the total. It is
// `unavailable` with a reason, because every other answer invites an arithmetic somebody will
// mistake for a comparison.

import {
  ADMISSION_STAMP_LONG, ADMISSION_STAMP_SHORT, REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE,
} from './identity-admission';
import { CanonicalValue } from './canonical';

/** How a number was obtained. Ordered worst-to-best; aggregation keeps the worst. */
export type Provenance = 'unavailable' | 'estimated' | 'providerReported' | 'measured';

const PROVENANCE_RANK: Record<Provenance, number> = {
  unavailable: 0, estimated: 1, providerReported: 2, measured: 3,
};

/** One number, or the recorded absence of one. Never a zero standing in for "we do not know". */
export interface Quantity {
  provenance: Provenance;
  /** Absent exactly when `provenance` is `unavailable`. */
  value?: number;
  /** Present on `unavailable` and on `estimated`: the reason, or the method. Always populated. */
  note?: string;
}

export function measuredQuantity(value: number): Quantity {
  return { provenance: 'measured', value };
}

export function reportedQuantity(value: number): Quantity {
  return { provenance: 'providerReported', value };
}

export function estimatedQuantity(value: number, method: string): Quantity {
  return { provenance: 'estimated', value, note: method };
}

export function unavailableQuantity(reason: string): Quantity {
  return { provenance: 'unavailable', note: reason };
}

export function quantityValue(quantity: Quantity): number | undefined {
  return quantity.provenance === 'unavailable' ? undefined : quantity.value;
}

/** The worst provenance among several. A sum is only as trustworthy as its least trustworthy term. */
export function worstProvenance(quantities: Quantity[]): Provenance {
  if (quantities.length === 0) return 'unavailable';
  return quantities.reduce<Provenance>((worst, quantity) =>
    PROVENANCE_RANK[quantity.provenance] < PROVENANCE_RANK[worst] ? quantity.provenance : worst, 'measured');
}

/**
 * Add quantities, keeping the worst provenance and refusing to invent the missing ones.
 *
 * A sum containing an `unavailable` term is `unavailable`, not "the sum of the ones we had". Treating
 * a missing term as zero is how a partial token count becomes a confident undercount of a bill.
 */
export function sumQuantities(quantities: Quantity[], unavailableReason: string): Quantity {
  if (quantities.length === 0) return unavailableQuantity(unavailableReason);
  if (quantities.some((quantity) => quantity.provenance === 'unavailable')) {
    return unavailableQuantity(unavailableReason);
  }
  const total = quantities.reduce((sum, quantity) => sum + (quantity.value ?? 0), 0);
  const provenance = worstProvenance(quantities);
  const notes = [...new Set(quantities.map((quantity) => quantity.note).filter((note): note is string => !!note))];
  return { provenance, value: total, note: notes.length > 0 ? notes.join('; ') : undefined };
}

// MARK: - Throughput, which is three different measurements wearing one word

/**
 * "TOKENS PER SECOND" NAMES THREE DIFFERENT QUANTITIES, and a benchmark that prints one number under
 * that heading has silently chosen one of them for the reader.
 *
 *   providerReportedGeneration  visible tokens / the duration THE PROVIDER SAID it spent generating.
 *                               A property of the model and the provider's hardware. Available only
 *                               when the provider reports a generation duration — and most of them,
 *                               including both subscription CLIs, report no such thing at all.
 *   clientObservedOutput        visible tokens / the interval THIS PROCESS WATCHED, from the first
 *                               visible byte to the last. Needs streaming timestamps. Includes
 *                               transport, buffering and client overhead.
 *   endToEndOutput              visible tokens / total wall-clock time. The only one a completed
 *                               non-streamed reply can yield. Includes everything above PLUS the
 *                               provider's queue and the process launch.
 *
 * They are not interchangeable and the last two are ALWAYS slower than the first, by an amount that
 * is the user's waiting rather than the model's working. So the client-observed and end-to-end
 * figures carry their caveat in the value itself, and neither is ever labelled as the provider's
 * generation speed.
 */
export const CLIENT_OBSERVED_THROUGHPUT_CAVEAT =
  'client-observed: visible output tokens over the interval this process watched, from the first visible output to '
  + 'completion. Includes transport, provider buffering and client overhead. This is NOT the provider\'s internal '
  + 'generation speed and is always the slower of the two.';

export const END_TO_END_THROUGHPUT_CAVEAT =
  'end-to-end: visible output tokens over TOTAL wall-clock time, measured on a completed non-streamed response. '
  + 'Includes transport, provider queueing, buffering, process launch and client overhead. This is NOT the '
  + 'provider\'s internal generation speed; it is the whole wait divided into the answer.';

export const NO_PROVIDER_GENERATION_DURATION =
  'the provider reported no generation duration, so its own tokens-per-second cannot be computed. A figure derived '
  + 'from wall-clock time instead would measure this machine, this network and the provider\'s queue, and would be '
  + 'presented under a heading that claims to describe the model.';

export const NO_STREAMING_TIMESTAMPS =
  'no streaming timestamps were observed for this attempt, so there is no watched interval to divide the output by. '
  + 'A completed non-streamed response yields an end-to-end figure instead, and the two are recorded apart.';

/** Visible tokens per second as THE PROVIDER reported it. Both halves required; neither substituted. */
export function providerReportedGenerationThroughputMilli(visibleOutputTokens: Quantity,
                                                          generationDurationMilliseconds: Quantity): Quantity {
  const tokens = quantityValue(visibleOutputTokens);
  const duration = quantityValue(generationDurationMilliseconds);
  if (tokens === undefined || duration === undefined || duration <= 0) {
    // The caller's own reason is kept when it has one: "this CLI reports no such field, and here is
    // why the two durations it DOES report are not it" says more than the generic sentence.
    return unavailableQuantity(generationDurationMilliseconds.provenance === 'unavailable'
      && generationDurationMilliseconds.note ? generationDurationMilliseconds.note : NO_PROVIDER_GENERATION_DURATION);
  }
  return reportedQuantity(Math.round((tokens * 1000 * 1000) / duration));
}

/**
 * Visible tokens per second across the interval THIS PROCESS watched.
 *
 * Both timestamps must have been observed. Reconstructing the first-output moment from a duration
 * the provider reported afterwards would turn a measurement into an inference and keep the label.
 */
export function clientObservedOutputThroughputMilli(visibleOutputTokens: Quantity,
                                                    firstVisibleOutputAtMilliseconds: number | undefined,
                                                    completedAtMilliseconds: number | undefined): Quantity {
  const tokens = quantityValue(visibleOutputTokens);
  if (tokens === undefined) return unavailableQuantity('no visible output token count, so there is nothing to divide');
  if (firstVisibleOutputAtMilliseconds === undefined || completedAtMilliseconds === undefined) {
    return unavailableQuantity(NO_STREAMING_TIMESTAMPS);
  }
  const interval = completedAtMilliseconds - firstVisibleOutputAtMilliseconds;
  if (interval <= 0) {
    return unavailableQuantity('the observed output interval was not positive, so a rate over it would be an artefact '
      + 'of the clock rather than a measurement of anything');
  }
  return { provenance: 'measured', value: Math.round((tokens * 1000 * 1000) / interval), note: CLIENT_OBSERVED_THROUGHPUT_CAVEAT };
}

/** Visible tokens per second across the WHOLE wait. Recorded separately, never as the one above. */
export function endToEndOutputThroughputMilli(visibleOutputTokens: Quantity,
                                              totalWallClockMilliseconds: number | undefined): Quantity {
  const tokens = quantityValue(visibleOutputTokens);
  if (tokens === undefined) return unavailableQuantity('no visible output token count, so there is nothing to divide');
  if (totalWallClockMilliseconds === undefined || totalWallClockMilliseconds <= 0) {
    return unavailableQuantity('no positive wall-clock time was recorded for this attempt');
  }
  return { provenance: 'measured', value: Math.round((tokens * 1000 * 1000) / totalWallClockMilliseconds), note: END_TO_END_THROUGHPUT_CAVEAT };
}

// MARK: - Cost, which is three different questions wearing one word

/**
 * WHAT DID THIS COST? has three answers and they disagree.
 *
 *   marginalApiCharge        money a provider bills for this request. Zero for local. Zero for a
 *                            subscription CLI — genuinely zero, no card is touched.
 *   subscriptionIncludedUsage  the finite plan allowance the request consumed, valued at the
 *                            provider's list price where the provider reports such a figure. It is
 *                            NOT a charge. It is also NOT nothing: it is the reason a Max plan runs
 *                            out before the month does.
 *   effectiveUserCost        what the person actually paid at the margin for this request. For
 *                            metered execution that is the charge. For a subscription it is a share
 *                            of a flat monthly fee, and a share of a fee cannot be derived from one
 *                            request — so it is `unavailable` WITH THAT REASON rather than zero.
 *
 * `$0` under a single "cost" column is true of the first answer, false of the second, and unknown
 * for the third. Printing it alone is how a benchmark tells somebody a Max plan is free.
 */
export interface CostBreakdown {
  marginalAPIChargeMicroUSD: Quantity;
  subscriptionIncludedUsageMicroUSD: Quantity;
  effectiveUserCostMicroUSD: Quantity;
}

export const SUBSCRIPTION_NOT_FREE =
  'subscription execution has a zero marginal API charge and is NOT free: it consumes a finite monthly allowance. '
  + 'What one request costs the person is a share of a flat plan fee, which cannot be derived from the request — '
  + 'it would need the plan price and the total allowance, neither of which the provider reports here.';

export const NOT_A_SUBSCRIPTION = 'this execution is billed per token against a key, so it consumes no plan allowance';
export const LOCAL_NO_ALLOWANCE = 'this candidate ran on local weights and consumed no provider allowance at all';

/**
 * The three cost answers for one attempt, from the billing basis and what the provider said.
 *
 * `providerReportedUsageMicroUSD` is what a subscription CLI reports about the request — Claude Code
 * emits `total_cost_usd`, which on a subscription plan is the LIST VALUE of the allowance consumed
 * and not an amount anyone is billed. Passing it here records it as exactly that.
 */
export function costBreakdown(options: {
  billingBasis: string;
  /** The per-token charge, for metered execution only. Undefined means it is not known. */
  meteredChargeMicroUSD?: number;
  meteredChargeProvenance?: Provenance;
  /** A subscription CLI's own list valuation of this request, when it reports one. */
  providerReportedUsageMicroUSD?: number;
}): CostBreakdown {
  if (options.billingBasis === 'local') {
    return {
      marginalAPIChargeMicroUSD: measuredQuantity(0),
      subscriptionIncludedUsageMicroUSD: unavailableQuantity(LOCAL_NO_ALLOWANCE),
      effectiveUserCostMicroUSD: measuredQuantity(0),
    };
  }
  if (options.billingBasis === 'subscriptionIncluded') {
    return {
      // Zero, and true. No request to a metered endpoint was made and no card was charged.
      marginalAPIChargeMicroUSD: measuredQuantity(0),
      subscriptionIncludedUsageMicroUSD: options.providerReportedUsageMicroUSD === undefined
        ? unavailableQuantity('this subscription CLI reported no usage valuation for the request, so how much of the '
          + 'plan allowance it consumed is not known. It is not zero.')
        : reportedQuantity(options.providerReportedUsageMicroUSD),
      effectiveUserCostMicroUSD: unavailableQuantity(SUBSCRIPTION_NOT_FREE),
    };
  }
  const charge: Quantity = options.meteredChargeMicroUSD === undefined
    ? unavailableQuantity('the provider reported no usage for this metered request, so its charge is not known and '
      + 'this engine will not write a budget in place of a bill')
    : { provenance: options.meteredChargeProvenance ?? 'estimated', value: options.meteredChargeMicroUSD };
  return {
    marginalAPIChargeMicroUSD: charge,
    subscriptionIncludedUsageMicroUSD: unavailableQuantity(NOT_A_SUBSCRIPTION),
    // Metered is the one case where the charge IS what the person pays at the margin.
    effectiveUserCostMicroUSD: charge,
  };
}

/** The cost sentence for one billing basis. Never renders subscription execution as "cost $0". */
export function describeCost(breakdown: CostBreakdown, billingBasis: string): string {
  const dollars = (quantity: Quantity): string => {
    const value = quantityValue(quantity);
    return value === undefined ? 'not known' : `$${(value / 1_000_000).toFixed(6)}`;
  };
  if (billingBasis === 'local') {
    return 'local · marginal API charge $0.000000 · consumes no plan allowance · effective cost $0.000000';
  }
  if (billingBasis === 'subscriptionIncluded') {
    return `subscription-included · marginal API charge $0.000000 · plan allowance consumed (list value) `
      + `${dollars(breakdown.subscriptionIncludedUsageMicroUSD)} · effective cost to you: not known — ${SUBSCRIPTION_NOT_FREE}`;
  }
  return `metered API · marginal API charge ${dollars(breakdown.marginalAPIChargeMicroUSD)} · consumes no plan `
    + `allowance · effective cost ${dollars(breakdown.effectiveUserCostMicroUSD)}`;
}

/** What a frontier attempt produced, in the shape a ledger row records. */
export interface FrontierAttemptRecord extends Record<string, CanonicalValue | undefined> {
  provider: string;
  executionClass: string;
  billingBasis: string;
  requestedModelID: string;
  /** Empty when the provider did not say. Never a copy of the request. */
  reportedModelID: string;
  /**
   * What was known about this candidate's identity before the request — `verified`, `unverifiable`,
   * or the Pass 6 admission state. Carried on the RECORD as well as the aggregate so a row exported
   * on its own still says what it is.
   */
  bindingIdentityState?: string;
  /**
   * EVERY input token the provider processed, cached and fresh.
   *
   * Pass 6 recorded the FRESH REMAINDER here and called it the input count. On the Claude envelope
   * that is 2 tokens for a request that processed 6,000, and on the Codex envelope it is the total
   * minus the cached portion — so both halves of a cross-provider comparison were understated, in
   * two different ways, by two different factors. The decomposition below is recorded beside this
   * total rather than instead of it: a reader who has only one figure cannot tell which they hold.
   */
  inputTokens?: number;
  /** The fresh remainder alone — what Pass 6 put in `inputTokens`. Kept so the two are comparable. */
  freshInputTokens?: number;
  /** Input tokens this request WROTE into the provider's prompt cache. */
  cacheCreationInputTokens?: number;
  /** Input tokens this request was SERVED from the provider's prompt cache. */
  cacheReadInputTokens?: number;
  visibleOutputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  usageProvenance: Provenance;
  /** The MARGINAL API CHARGE, integer microUSD. Zero for local and subscription; absent when unknown. */
  costMicroUSD?: number;
  costProvenance: Provenance;
  /**
   * Plan allowance this attempt consumed, at the provider's list value, in integer microUSD.
   * Absent when the provider reported none — which is not the same as zero. Never added to
   * `costMicroUSD`: one is a bill and the other is a budget being spent down.
   */
  subscriptionIncludedUsageMicroUSD?: number;
  /**
   * WHETHER THE ALLOWANCE WAS OBTAINED, stated rather than inferred from whether a number is there.
   *
   * An absent number and a number that is absent FOR A REASON are different records, and a surface
   * that has only the first has to guess which. `reported` means the provider valued the request;
   * `unavailable` means it did not, and the explanation beside it says so in the provider's own
   * terms. Neither is ever zero.
   */
  subscriptionAllowanceState?: 'reported' | 'unavailable';
  subscriptionAllowanceProvenance?: Provenance;
  /** Why, in plain language. Populated on both states — on `reported` it says where the figure came from. */
  subscriptionAllowanceExplanation?: string;
  /** The duration the PROVIDER said it spent generating, in milliseconds. Absent when it did not say. */
  providerReportedGenerationMilliseconds?: number;
  retryCount: number;
  wastedTokens: number;
  timedOut: boolean;
  /** The provider's own usage block, verbatim, so a cost here can be reconciled against a bill. */
  rawUsage?: CanonicalValue;
}

/** Everything one frontier attempt produced, with provenance on every figure. */
export interface FrontierAttemptMetrics {
  candidate: string;
  slotKey: string;
  provider: string;
  executionClass: string;
  billingBasis: string;

  /** What was asked for. */
  requestedModelID: string;
  /** What the provider named. EMPTY when it named nothing — never a copy of the request. */
  reportedModelID: string;
  /** `verified`, `unverifiable`, or `requestAcceptedIdentityUnverifiable`. */
  identityState: string;
  /**
   * The stamp this row must be displayed with, or an empty string when it needs none.
   *
   * Computed here, once, so a chart legend, a CSV column and a terminal row cannot drift into
   * describing the same state three different ways. `identityDisclosureRequired` is the flag a
   * surface checks; this is what it prints.
   */
  identityDisclosure: string;
  identityDisclosureRequired: boolean;

  /** EVERY input token the provider processed, cached and fresh. The figure a cost rests on. */
  inputTokens: Quantity;
  /** The fresh remainder alone. Published beside the total so neither can be mistaken for the other. */
  freshInputTokens: Quantity;
  /** Input tokens this request wrote into the provider's prompt cache. */
  cacheCreationInputTokens: Quantity;
  /** Input tokens this request was served from the provider's prompt cache. */
  cacheReadInputTokens: Quantity;
  /** The answer the person would read. Kept apart from reasoning, always. */
  visibleOutputTokens: Quantity;
  /** Reasoning / thinking tokens, when the provider reports them at all. */
  reasoningTokens: Quantity;
  totalTokens: Quantity;

  /**
   * THE PROVIDER'S OWN GENERATION SPEED. Visible output tokens divided by the duration the PROVIDER
   * reported spending generating them, integer-scaled by 1000. Present only when the provider
   * reported BOTH figures. It is the only one of the three that describes the model.
   */
  providerReportedGenerationTokensPerSecondMilli: Quantity;
  /**
   * WHAT THIS CLIENT WATCHED. Visible output tokens divided by the observed interval from the first
   * visible output to completion, integer-scaled by 1000. Requires streaming timestamps.
   * Includes transport, buffering and client overhead; excludes the pre-first-token queue.
   */
  clientObservedOutputTokensPerSecondMilli: Quantity;
  /**
   * THE WHOLE WAIT. Visible output tokens divided by total wall-clock time, integer-scaled by 1000.
   * The only throughput a completed non-streamed response can produce, and the one that includes
   * provider queueing as well as transport.
   */
  endToEndOutputTokensPerSecondMilli: Quantity;
  /** Milliseconds to the first VISIBLE token. Measured from byte arrival or not recorded. */
  timeToFirstVisibleTokenMilliseconds: Quantity;
  totalWallClockMilliseconds: Quantity;

  /** Real money billed for this request. Integer microUSD. Zero — truly — for local and subscription. */
  marginalAPIChargeMicroUSD: Quantity;
  /**
   * Finite plan allowance this request consumed, valued at the provider's list price when the
   * provider reports such a figure. NOT a charge: no card is billed for it. Recording it is what
   * stops subscription execution being reported as free.
   */
  subscriptionIncludedUsageMicroUSD: Quantity;
  /** What this request actually cost the person at the margin. See `effectiveUserCost`. */
  effectiveUserCostMicroUSD: Quantity;

  retryCount: number;
  timedOut: boolean;
  /** Tokens spent on attempts that produced nothing usable — failures and retried tries. */
  wastedTokens: Quantity;

  /** What the provider said it used, verbatim, when it said anything. For reconciling against a bill. */
  providerReportedUsage?: CanonicalValue;
  /** What Cernum would have estimated, kept beside the reported figure rather than replacing it. */
  estimatedTotalTokens: Quantity;

  /** The single worst provenance across this attempt's figures — the honest quality of the row. */
  measurementQuality: Provenance;
}

/** Everything one candidate produced across a campaign. */
export interface FrontierCandidateMetrics {
  candidate: string;
  provider: string;
  executionClass: string;
  billingBasis: string;

  /** What was asked for, across this candidate's attempts. */
  requestedModelID: string;
  /** What the provider named. Empty when it never named anything. */
  reportedModelID: string;
  /**
   * The WEAKEST identity state any of this candidate's attempts carried.
   *
   * Weakest, not commonest: an aggregate is only as attributable as its least attributable row, and
   * an average taken over one unattributable answer is an unattributable average.
   */
  identityState: string;
  identityDisclosure: string;
  identityDisclosureRequired: boolean;

  attemptCount: number;
  successfulTaskCount: number;
  /** Successes per thousand attempts. Unavailable — never zero — when nothing was attempted. */
  successfulTaskRateMilli: Quantity;

  inputTokens: Quantity;
  /** The campaign's fresh-input total, beside the real one. The gap between them is the cache. */
  freshInputTokens: Quantity;
  cacheCreationInputTokens: Quantity;
  cacheReadInputTokens: Quantity;
  visibleOutputTokens: Quantity;
  reasoningTokens: Quantity;
  totalTokens: Quantity;

  medianProviderReportedGenerationTokensPerSecondMilli: Quantity;
  medianClientObservedOutputTokensPerSecondMilli: Quantity;
  medianEndToEndOutputTokensPerSecondMilli: Quantity;
  medianTimeToFirstVisibleTokenMilliseconds: Quantity;
  totalWallClockMilliseconds: Quantity;

  /** Everything this candidate was BILLED across the whole campaign, failures included. */
  costPerRunMicroUSD: Quantity;
  /** Plan allowance this candidate consumed across the campaign, at list value. */
  subscriptionIncludedUsageMicroUSD: Quantity;
  /** What the campaign actually cost the person for this candidate, at the margin. */
  effectiveUserCostMicroUSD: Quantity;
  /** Total cost divided by successes. Unavailable when there were none. */
  costPerSuccessfulTaskMicroUSD: Quantity;
  /** Total tokens divided by completed passes — what one finished piece of work actually consumed. */
  tokensPerCompletedPass: Quantity;
  wastedTokens: Quantity;

  retryCount: number;
  timeoutCount: number;

  providerReportedTotalTokens: Quantity;
  estimatedTotalTokens: Quantity;
  /**
   * Provider-reported minus estimated, when both exist. The number that says whether the estimate is
   * any good — and the one to look at before trusting a cost projection for a bigger run.
   */
  reportedMinusEstimatedTokens: Quantity;

  measurementQuality: Provenance;
}

const NO_ATTEMPTS = 'this candidate recorded no attempts, so there is nothing to average';
const NO_SUCCESSES = 'this candidate completed no task successfully. Cost per successful task is undefined rather than '
  + 'infinite or zero: a rate with no successes in its denominator is not a number to compare models on';

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

function medianQuantity(quantities: Quantity[], reason: string): Quantity {
  const usable = quantities.filter((quantity) => quantity.provenance !== 'unavailable');
  const value = median(usable.map((quantity) => quantity.value ?? 0));
  if (value === undefined) return unavailableQuantity(reason);
  return { provenance: worstProvenance(usable), value };
}

/**
 * The line a row in this state must be displayed with, and an empty string for a row that needs none.
 *
 * ONE function, called by the attempt reader and by the aggregate, so that a chart legend, a CSV
 * column and a terminal row cannot describe the same state three different ways. A surface that
 * prints a metrics row without this line is showing a verified-looking row for a candidate nothing
 * verified — see `assertSurfaceCanStamp`.
 */
export function identityDisclosureFor(identityState: string, requestedModelID: string): string {
  if (identityState !== REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE) return '';
  return `${requestedModelID || 'this candidate'}: ${ADMISSION_STAMP_SHORT}. ${ADMISSION_STAMP_LONG}`;
}

/**
 * The line that must appear beside any table containing a candidate whose identity was never
 * established. The counterpart of `MIXED_METRICS_CAVEAT`, and for the same reason: the caveat
 * belongs on the table, not in a footnote somebody reads once.
 */
export const IDENTITY_UNVERIFIABLE_CAVEAT =
  'At least one candidate in this table ran under the accepted-request identity exception. The provider accepted the '
  + 'identifier and something answered; nothing named what. Those rows measure WHAT ANSWERED WHEN THAT IDENTIFIER WAS '
  + 'REQUESTED, which is not the same claim as "this model scored this", and they must not be cited, charted or '
  + 'compared as though it were. They earn no capability role and no retention recommendation.';

/**
 * Fold one candidate's attempts into its aggregate.
 *
 * `successfulTaskCount` is supplied rather than derived, because what counts as success is the
 * benchmark's decision — the same counting rules the ranking uses — and this module must not grow a
 * second opinion about it.
 */
export function aggregateCandidateMetrics(candidate: string, attempts: FrontierAttemptMetrics[],
                                          successfulTaskCount: number): FrontierCandidateMetrics {
  const first = attempts[0];
  const provider = first?.provider ?? 'unknown';
  const executionClass = first?.executionClass ?? 'unknown';
  const billingBasis = first?.billingBasis ?? 'unknown';
  // The weakest state across the attempts, not the first one's. One admitted attempt is enough to
  // make the whole aggregate unattributable, and an aggregate that reported the majority state
  // would hide exactly the row a reader needs to see.
  const identityState = attempts.some((a) => a.identityState === REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE)
    ? REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE
    : first?.identityState ?? 'verified';
  const requestedModelID = first?.requestedModelID ?? '';
  // Empty unless EVERY attempt named the same model. A candidate whose replies named two different
  // models has no single reported identity, and printing one of them would pick a winner.
  const reportedIDs = new Set(attempts.map((a) => a.reportedModelID).filter((id) => id.length > 0));
  const reportedModelID = reportedIDs.size === 1 ? [...reportedIDs][0] : '';

  const inputTokens = sumQuantities(attempts.map((a) => a.inputTokens),
    'at least one attempt has no input token count, so the campaign total would be an undercount presented as a total');
  // Summed apart so a reader can SEE the cache rather than take the correction on trust: the gap
  // between these two totals is exactly what Pass 6 was missing.
  const freshInputTokens = sumQuantities(attempts.map((a) => a.freshInputTokens),
    'at least one attempt has no fresh input token count');
  const cacheCreationInputTokens = sumQuantities(attempts.map((a) => a.cacheCreationInputTokens),
    'at least one attempt did not report cache-creation input tokens, which is not the same as reporting zero');
  const cacheReadInputTokens = sumQuantities(attempts.map((a) => a.cacheReadInputTokens),
    'at least one attempt did not report cache-read input tokens, which is not the same as reporting zero');
  const visibleOutputTokens = sumQuantities(attempts.map((a) => a.visibleOutputTokens),
    'at least one attempt has no visible output token count');
  const reasoningTokens = sumQuantities(attempts.map((a) => a.reasoningTokens),
    'at least one attempt has no reasoning token count; providers that do not report reasoning separately leave this unknown rather than zero');
  const totalTokens = sumQuantities(attempts.map((a) => a.totalTokens), 'at least one attempt has no total token count');
  const wastedTokens = sumQuantities(attempts.map((a) => a.wastedTokens), 'at least one attempt cannot say how many of its tokens were wasted');
  const costPerRun = sumQuantities(attempts.map((a) => a.marginalAPIChargeMicroUSD),
    'at least one attempt has no marginal charge recorded, so the campaign total is not known');
  // Summed apart from the charge, because adding an allowance to a bill produces a number that is
  // neither, and because a campaign can legitimately have one without the other.
  const subscriptionIncludedUsage = sumQuantities(attempts.map((a) => a.subscriptionIncludedUsageMicroUSD),
    'at least one attempt did not report how much plan allowance it consumed, so the campaign total is not known — '
    + 'and it is not zero');
  const effectiveUserCost = sumQuantities(attempts.map((a) => a.effectiveUserCostMicroUSD),
    'at least one attempt cannot say what it cost the person at the margin; subscription execution in particular '
    + 'cannot, because a share of a flat plan fee is not derivable from one request');

  const costPerSuccess: Quantity = successfulTaskCount === 0
    ? unavailableQuantity(NO_SUCCESSES)
    : costPerRun.provenance === 'unavailable'
      ? unavailableQuantity('the total cost is not known, so a cost per successful task cannot be derived from it')
      // Money spent on failures counts. Dividing only the successful attempts' cost by the successes
      // would report a model as cheap precisely because its failures were free to ignore.
      : { provenance: costPerRun.provenance, value: Math.round((costPerRun.value ?? 0) / successfulTaskCount) };

  const tokensPerCompletedPass: Quantity = successfulTaskCount === 0
    ? unavailableQuantity('no pass completed, so no pass consumed a measurable number of tokens')
    : totalTokens.provenance === 'unavailable'
      ? unavailableQuantity('the total token count is not known')
      : { provenance: totalTokens.provenance, value: Math.round((totalTokens.value ?? 0) / successfulTaskCount) };

  const providerReportedTotalTokens = sumQuantities(
    attempts.map((a) => a.totalTokens).filter((q) => q.provenance === 'providerReported'),
    'no attempt carried a provider-reported token count');
  const estimatedTotalTokens = sumQuantities(attempts.map((a) => a.estimatedTotalTokens),
    'at least one attempt could not be estimated');

  const reportedMinusEstimated: Quantity =
    providerReportedTotalTokens.provenance === 'unavailable' || estimatedTotalTokens.provenance === 'unavailable'
      ? unavailableQuantity('a comparison needs both a provider-reported and an estimated figure, and one of them is absent')
      : { provenance: 'providerReported', value: (providerReportedTotalTokens.value ?? 0) - (estimatedTotalTokens.value ?? 0) };

  const everyQuantity = [inputTokens, visibleOutputTokens, totalTokens, costPerRun];

  return {
    candidate,
    provider,
    executionClass,
    billingBasis,
    requestedModelID,
    reportedModelID,
    identityState,
    identityDisclosure: identityDisclosureFor(identityState, requestedModelID),
    identityDisclosureRequired: identityState === REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE,
    attemptCount: attempts.length,
    successfulTaskCount,
    successfulTaskRateMilli: attempts.length === 0
      ? unavailableQuantity(NO_ATTEMPTS)
      : measuredQuantity(Math.round((successfulTaskCount * 1000) / attempts.length)),
    inputTokens,
    freshInputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    visibleOutputTokens,
    reasoningTokens,
    totalTokens,
    medianProviderReportedGenerationTokensPerSecondMilli:
      medianQuantity(attempts.map((a) => a.providerReportedGenerationTokensPerSecondMilli), NO_PROVIDER_GENERATION_DURATION),
    medianClientObservedOutputTokensPerSecondMilli:
      medianQuantity(attempts.map((a) => a.clientObservedOutputTokensPerSecondMilli), NO_STREAMING_TIMESTAMPS),
    medianEndToEndOutputTokensPerSecondMilli:
      medianQuantity(attempts.map((a) => a.endToEndOutputTokensPerSecondMilli),
        'no attempt produced both a visible output token count and a positive wall-clock time'),
    medianTimeToFirstVisibleTokenMilliseconds: medianQuantity(attempts.map((a) => a.timeToFirstVisibleTokenMilliseconds),
      'no attempt observed a first visible token arriving'),
    totalWallClockMilliseconds: sumQuantities(attempts.map((a) => a.totalWallClockMilliseconds),
      'at least one attempt recorded no wall time'),
    costPerRunMicroUSD: costPerRun,
    subscriptionIncludedUsageMicroUSD: subscriptionIncludedUsage,
    effectiveUserCostMicroUSD: effectiveUserCost,
    costPerSuccessfulTaskMicroUSD: costPerSuccess,
    tokensPerCompletedPass,
    wastedTokens,
    retryCount: attempts.reduce((sum, a) => sum + a.retryCount, 0),
    timeoutCount: attempts.filter((a) => a.timedOut).length,
    providerReportedTotalTokens,
    estimatedTotalTokens,
    reportedMinusEstimatedTokens: reportedMinusEstimated,
    measurementQuality: worstProvenance(everyQuantity),
  };
}

/** One line per candidate, for a terminal table. Prints the provenance rather than hiding it. */
export function describeCandidateMetrics(metrics: FrontierCandidateMetrics): string {
  const rate = quantityValue(metrics.successfulTaskRateMilli);
  const cost = quantityValue(metrics.costPerSuccessfulTaskMicroUSD);
  // A subscription candidate shows its ALLOWANCE here, never a $0 charge: the charge is genuinely
  // zero and saying so alone is what tells a reader the plan is free.
  const allowance = quantityValue(metrics.subscriptionIncludedUsageMicroUSD);
  const money = metrics.billingBasis === 'subscriptionIncluded'
    ? (allowance === undefined ? 'allowance unknown' : `${(allowance / 1_000_000).toFixed(6)} allow.`)
    : (cost === undefined ? 'no cost/success' : `$${(cost / 1_000_000).toFixed(6)}`);
  return [
    metrics.candidate.padEnd(24),
    metrics.executionClass.padEnd(14),
    (rate === undefined ? 'no rate' : `${(rate / 10).toFixed(1)}%`).padStart(8),
    money.padStart(18),
    metrics.measurementQuality,
    // Appended to the ROW, not printed under the table. A reader scanning a leaderboard reads rows,
    // and a caveat at the bottom is a caveat they have already skipped by the time it applies.
    metrics.identityDisclosureRequired ? `  ** ${ADMISSION_STAMP_SHORT} **` : '',
  ].join('  ').trimEnd();
}

/**
 * The line that must appear beside any table mixing execution classes.
 *
 * Not a footnote. A table that puts a local model's latency next to an API model's, without this,
 * is a table that has quietly ranked two access methods and called it a model comparison.
 */
export const MIXED_METRICS_CAVEAT =
  'Task outcomes above are comparable; speed and cost are not. Candidates in this table were reached through different '
  + 'execution classes, and latency, throughput and price are properties of the access method as much as of the model. '
  + 'Where a throughput column is client-observed or end-to-end rather than provider-reported, it measures this machine, '
  + 'this network and the provider\'s queue alongside the model. And a subscription candidate\'s zero charge is not a '
  + 'zero cost: it consumes a finite plan allowance, reported in its own column.';

// MARK: - Reading the metrics back out of a ledger

/**
 * One ledger row, as a metrics row.
 *
 * The ledger is the source of truth, not an in-memory tally kept alongside it. A campaign resumed in
 * another process, or finalized days later by a different surface, reads the same rows and reaches
 * the same totals — which is the only way a cost figure in a report can be checked against the
 * evidence it came from.
 *
 * Every absence is preserved as an absence. A row whose provider reported no token count produces
 * `unavailable` here, and the aggregate that contains it says so rather than quietly summing the
 * rows that did report.
 */
export function attemptMetricsFromRow(row: Record<string, unknown>): FrontierAttemptMetrics | undefined {
  if (typeof row.provider !== 'string') return undefined;
  const number = (value: unknown): number | undefined => (typeof value === 'number' ? value : undefined);
  const provenance = (value: unknown): Provenance =>
    (value === 'measured' || value === 'providerReported' || value === 'estimated' ? value : 'unavailable');

  const usageProvenance = provenance(row.usageProvenance);
  const costProvenance = provenance(row.costProvenance);
  const quantity = (value: number | undefined, own: Provenance, reason: string): Quantity =>
    value === undefined || own === 'unavailable' ? unavailableQuantity(reason) : { provenance: own, value };

  const inputTokens = number(row.inputTokens);
  const freshInputTokens = number(row.freshInputTokens);
  const cacheCreationInputTokens = number(row.cacheCreationInputTokens);
  const cacheReadInputTokens = number(row.cacheReadInputTokens);
  const visibleOutputTokens = number(row.visibleOutputTokens);
  const reasoningTokens = number(row.reasoningTokens);
  const totalTokens = number(row.totalTokens);
  const latency = number(row.latencyMilliseconds);
  const firstToken = number(row.timeToFirstTokenMilliseconds);
  const generationDuration = number(row.providerReportedGenerationMilliseconds);
  const cost = number(row.costMicroUSD);
  const allowance = number(row.subscriptionIncludedUsageMicroUSD);
  const allowanceExplanation = typeof row.subscriptionAllowanceExplanation === 'string'
    && row.subscriptionAllowanceExplanation.length > 0 ? row.subscriptionAllowanceExplanation : undefined;
  const allowanceProvenance = row.subscriptionAllowanceProvenance === undefined
    ? undefined : provenance(row.subscriptionAllowanceProvenance);
  // The STATE is the authority, not the presence of a number. A row that says `unavailable` and
  // carries a figure anyway is a contradiction, and the honest reading of a contradiction is the
  // weaker of the two claims — never the number.
  const allowanceReported = row.subscriptionAllowanceState === undefined
    ? allowance !== undefined
    : row.subscriptionAllowanceState === 'reported' && allowance !== undefined;
  const wasted = number(row.wastedTokens);

  const estimatedTotal = inputTokens !== undefined && visibleOutputTokens !== undefined
    ? estimatedQuantity(inputTokens + visibleOutputTokens + (reasoningTokens ?? 0),
      'the same counts the provider reported, summed here for comparison against its own total')
    : unavailableQuantity('this attempt carries no token counts to estimate a total from');

  const billingBasisOfRow = typeof row.billingBasis === 'string' ? row.billingBasis : 'unknown';
  const rowRequestedModelID = typeof row.requestedModelID === 'string' ? row.requestedModelID : '';
  // `verified` is the fallback for a row written before Pass 6, where a local candidate's identity
  // was established by its weights digest and there was no third state to record. The state this
  // reader exists to surface is never absent from a row that has it — `campaign.ts` stamps it.
  const rowIdentityState = typeof row.bindingIdentityState === 'string' ? row.bindingIdentityState : 'verified';

  return {
    candidate: typeof row.candidate === 'string' ? row.candidate : '',
    slotKey: typeof row.slotKey === 'string' ? row.slotKey : '',
    provider: row.provider,
    executionClass: typeof row.executionClass === 'string' ? row.executionClass : 'unknown',
    billingBasis: billingBasisOfRow,
    requestedModelID: rowRequestedModelID,
    // Read straight through, never defaulted to the request. A row that named nothing keeps an
    // empty field here, all the way onto whatever surface displays it.
    reportedModelID: typeof row.reportedModelID === 'string' ? row.reportedModelID : '',
    identityState: rowIdentityState,
    identityDisclosure: identityDisclosureFor(rowIdentityState, rowRequestedModelID),
    identityDisclosureRequired: rowIdentityState === REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE,
    inputTokens: quantity(inputTokens, usageProvenance, 'no input token count was recorded for this attempt'),
    // Absent on every row written before Pass 7, and absent is what those rows get. Substituting the
    // total here would make a pre-correction row look as though its cache had been measured at zero.
    freshInputTokens: quantity(freshInputTokens, usageProvenance,
      'this row was written before the input decomposition was recorded, so the fresh remainder is not separable from its total'),
    cacheCreationInputTokens: quantity(cacheCreationInputTokens, usageProvenance,
      'no cache-creation input token count was recorded for this attempt'),
    cacheReadInputTokens: quantity(cacheReadInputTokens, usageProvenance,
      'no cache-read input token count was recorded for this attempt'),
    visibleOutputTokens: quantity(visibleOutputTokens, usageProvenance, 'no visible output token count was recorded'),
    reasoningTokens: quantity(reasoningTokens, usageProvenance,
      'this provider did not report reasoning tokens separately, which is not the same as reporting zero'),
    totalTokens: quantity(totalTokens, usageProvenance, 'no total token count was recorded'),
    providerReportedGenerationTokensPerSecondMilli: providerReportedGenerationThroughputMilli(
      quantity(visibleOutputTokens, usageProvenance, 'no visible output token count was recorded'),
      generationDuration === undefined ? unavailableQuantity(NO_PROVIDER_GENERATION_DURATION) : reportedQuantity(generationDuration)),
    clientObservedOutputTokensPerSecondMilli: clientObservedOutputThroughputMilli(
      quantity(visibleOutputTokens, usageProvenance, 'no visible output token count was recorded'), firstToken, latency),
    endToEndOutputTokensPerSecondMilli: endToEndOutputThroughputMilli(
      quantity(visibleOutputTokens, usageProvenance, 'no visible output token count was recorded'), latency),
    timeToFirstVisibleTokenMilliseconds: firstToken === undefined
      ? unavailableQuantity('no first visible token arrival was observed for this attempt')
      : measuredQuantity(firstToken),
    totalWallClockMilliseconds: latency === undefined
      ? unavailableQuantity('no client wall time was recorded')
      : measuredQuantity(latency),
    marginalAPIChargeMicroUSD: cost === undefined
      ? unavailableQuantity('this attempt\'s charge is not known; the provider reported no usage and this engine will not write a budget in place of a charge')
      : { provenance: costProvenance === 'unavailable' ? 'estimated' : costProvenance, value: cost },
    // THE ROW'S OWN ACCOUNT WINS. From Pass 7 the attempt records why the allowance is or is not
    // there, in the provider's terms — "Codex reports no cost figure at all" is a different fact
    // from "this request was not valued", and a generic sentence reconstructed here would flatten
    // the two. The generic sentence is the fallback for rows written before that was recorded.
    subscriptionIncludedUsageMicroUSD: billingBasisOfRow === 'subscriptionIncluded'
      ? (!allowanceReported
        ? unavailableQuantity(allowanceExplanation
          ?? 'this subscription attempt reported no usage valuation, so how much plan allowance it '
          + 'consumed is not known. It is not zero.')
        : { provenance: allowanceProvenance === undefined || allowanceProvenance === 'unavailable'
              ? 'providerReported' : allowanceProvenance,
            value: allowance, note: allowanceExplanation })
      : unavailableQuantity(billingBasisOfRow === 'local' ? LOCAL_NO_ALLOWANCE : NOT_A_SUBSCRIPTION),
    effectiveUserCostMicroUSD: billingBasisOfRow === 'subscriptionIncluded'
      ? unavailableQuantity(SUBSCRIPTION_NOT_FREE)
      : cost === undefined
        ? unavailableQuantity('this attempt\'s charge is not known, so what it cost the person is not known either')
        : { provenance: costProvenance === 'unavailable' ? 'estimated' : costProvenance, value: cost },
    retryCount: number(row.retryCount) ?? 0,
    timedOut: row.timedOut === true,
    wastedTokens: wasted === undefined
      ? unavailableQuantity('this attempt cannot say how many of its tokens were spent on discarded tries')
      : measuredQuantity(wasted),
    providerReportedUsage: (row.providerReportedUsage ?? undefined) as CanonicalValue | undefined,
    estimatedTotalTokens: estimatedTotal,
    measurementQuality: worstProvenance([
      quantity(inputTokens, usageProvenance, ''),
      quantity(visibleOutputTokens, usageProvenance, ''),
      cost === undefined ? unavailableQuantity('') : { provenance: costProvenance, value: cost },
    ]),
  };
}

/**
 * Every candidate's aggregate, from a ledger's rows.
 *
 * `isSuccess` is supplied by the caller so this module never grows a second opinion about what
 * counts as a pass. It is the same rule the ranking uses, and the two must not be able to disagree
 * about the denominator of a cost-per-success.
 */
export function aggregateFromRows(rows: Record<string, unknown>[],
                                  isSuccess: (row: Record<string, unknown>) => boolean): FrontierCandidateMetrics[] {
  const byCandidate = new Map<string, { attempts: FrontierAttemptMetrics[]; successes: number }>();
  for (const row of rows) {
    const metrics = attemptMetricsFromRow(row);
    if (!metrics) continue;
    const entry = byCandidate.get(metrics.candidate) ?? { attempts: [], successes: 0 };
    entry.attempts.push(metrics);
    if (isSuccess(row)) entry.successes += 1;
    byCandidate.set(metrics.candidate, entry);
  }
  return [...byCandidate.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([candidate, entry]) => aggregateCandidateMetrics(candidate, entry.attempts, entry.successes));
}
