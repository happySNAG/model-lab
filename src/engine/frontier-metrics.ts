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

/** What a frontier attempt produced, in the shape a ledger row records. */
export interface FrontierAttemptRecord extends Record<string, CanonicalValue | undefined> {
  provider: string;
  executionClass: string;
  billingBasis: string;
  requestedModelID: string;
  /** Empty when the provider did not say. Never a copy of the request. */
  reportedModelID: string;
  inputTokens?: number;
  visibleOutputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  usageProvenance: Provenance;
  /** Integer microUSD. Zero for local and subscription; absent when a metered cost is not known. */
  costMicroUSD?: number;
  costProvenance: Provenance;
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

  inputTokens: Quantity;
  /** The answer the person would read. Kept apart from reasoning, always. */
  visibleOutputTokens: Quantity;
  /** Reasoning / thinking tokens, when the provider reports them at all. */
  reasoningTokens: Quantity;
  totalTokens: Quantity;

  /** Visible output tokens per second, integer-scaled by 1000. */
  tokensPerSecondMilli: Quantity;
  /** Milliseconds to the first VISIBLE token. Measured from byte arrival or not recorded. */
  timeToFirstVisibleTokenMilliseconds: Quantity;
  totalWallClockMilliseconds: Quantity;

  /** Integer microUSD. Zero with `measured` provenance for local; never a guess for metered. */
  costMicroUSD: Quantity;

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

  attemptCount: number;
  successfulTaskCount: number;
  /** Successes per thousand attempts. Unavailable — never zero — when nothing was attempted. */
  successfulTaskRateMilli: Quantity;

  inputTokens: Quantity;
  visibleOutputTokens: Quantity;
  reasoningTokens: Quantity;
  totalTokens: Quantity;

  medianTokensPerSecondMilli: Quantity;
  medianTimeToFirstVisibleTokenMilliseconds: Quantity;
  totalWallClockMilliseconds: Quantity;

  /** Everything this candidate cost across the whole campaign, failures included. */
  costPerRunMicroUSD: Quantity;
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

  const inputTokens = sumQuantities(attempts.map((a) => a.inputTokens),
    'at least one attempt has no input token count, so the campaign total would be an undercount presented as a total');
  const visibleOutputTokens = sumQuantities(attempts.map((a) => a.visibleOutputTokens),
    'at least one attempt has no visible output token count');
  const reasoningTokens = sumQuantities(attempts.map((a) => a.reasoningTokens),
    'at least one attempt has no reasoning token count; providers that do not report reasoning separately leave this unknown rather than zero');
  const totalTokens = sumQuantities(attempts.map((a) => a.totalTokens), 'at least one attempt has no total token count');
  const wastedTokens = sumQuantities(attempts.map((a) => a.wastedTokens), 'at least one attempt cannot say how many of its tokens were wasted');
  const costPerRun = sumQuantities(attempts.map((a) => a.costMicroUSD), 'at least one attempt has no cost, so the campaign total is not known');

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
    attemptCount: attempts.length,
    successfulTaskCount,
    successfulTaskRateMilli: attempts.length === 0
      ? unavailableQuantity(NO_ATTEMPTS)
      : measuredQuantity(Math.round((successfulTaskCount * 1000) / attempts.length)),
    inputTokens,
    visibleOutputTokens,
    reasoningTokens,
    totalTokens,
    medianTokensPerSecondMilli: medianQuantity(attempts.map((a) => a.tokensPerSecondMilli),
      'no attempt produced both a token count and a duration to divide it by'),
    medianTimeToFirstVisibleTokenMilliseconds: medianQuantity(attempts.map((a) => a.timeToFirstVisibleTokenMilliseconds),
      'no attempt observed a first visible token arriving'),
    totalWallClockMilliseconds: sumQuantities(attempts.map((a) => a.totalWallClockMilliseconds),
      'at least one attempt recorded no wall time'),
    costPerRunMicroUSD: costPerRun,
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
  return [
    metrics.candidate.padEnd(24),
    metrics.executionClass.padEnd(14),
    (rate === undefined ? 'no rate' : `${(rate / 10).toFixed(1)}%`).padStart(8),
    (cost === undefined ? 'no cost/success' : `$${(cost / 1_000_000).toFixed(6)}`).padStart(16),
    metrics.measurementQuality,
  ].join('  ');
}

/**
 * The line that must appear beside any table mixing execution classes.
 *
 * Not a footnote. A table that puts a local model's latency next to an API model's, without this,
 * is a table that has quietly ranked two access methods and called it a model comparison.
 */
export const MIXED_METRICS_CAVEAT =
  'Task outcomes above are comparable; speed and cost are not. Candidates in this table were reached through different '
  + 'execution classes, and latency, throughput and price are properties of the access method as much as of the model.';

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
  const visibleOutputTokens = number(row.visibleOutputTokens);
  const reasoningTokens = number(row.reasoningTokens);
  const totalTokens = number(row.totalTokens);
  const latency = number(row.latencyMilliseconds);
  const throughput = number(row.throughputTokensPerSecondMilli);
  const firstToken = number(row.timeToFirstTokenMilliseconds);
  const cost = number(row.costMicroUSD);
  const wasted = number(row.wastedTokens);

  const estimatedTotal = inputTokens !== undefined && visibleOutputTokens !== undefined
    ? estimatedQuantity(inputTokens + visibleOutputTokens + (reasoningTokens ?? 0),
      'the same counts the provider reported, summed here for comparison against its own total')
    : unavailableQuantity('this attempt carries no token counts to estimate a total from');

  return {
    candidate: typeof row.candidate === 'string' ? row.candidate : '',
    slotKey: typeof row.slotKey === 'string' ? row.slotKey : '',
    provider: row.provider,
    executionClass: typeof row.executionClass === 'string' ? row.executionClass : 'unknown',
    billingBasis: typeof row.billingBasis === 'string' ? row.billingBasis : 'unknown',
    inputTokens: quantity(inputTokens, usageProvenance, 'no input token count was recorded for this attempt'),
    visibleOutputTokens: quantity(visibleOutputTokens, usageProvenance, 'no visible output token count was recorded'),
    reasoningTokens: quantity(reasoningTokens, usageProvenance,
      'this provider did not report reasoning tokens separately, which is not the same as reporting zero'),
    totalTokens: quantity(totalTokens, usageProvenance, 'no total token count was recorded'),
    tokensPerSecondMilli: throughput === undefined
      ? unavailableQuantity('no throughput was recorded: that needs both a token count and the provider\'s own generation duration, and these APIs report the second of those not at all')
      : measuredQuantity(throughput),
    timeToFirstVisibleTokenMilliseconds: firstToken === undefined
      ? unavailableQuantity('no first visible token arrival was observed for this attempt')
      : measuredQuantity(firstToken),
    totalWallClockMilliseconds: latency === undefined
      ? unavailableQuantity('no client wall time was recorded')
      : measuredQuantity(latency),
    costMicroUSD: cost === undefined
      ? unavailableQuantity('this attempt\'s cost is not known; the provider reported no usage and this engine will not write a budget in place of a charge')
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
