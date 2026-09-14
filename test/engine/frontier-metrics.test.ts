// The metrics, and the four states a number can be in.
//
// The arithmetic here is easy. What is worth testing is the REFUSALS: that a sum containing an
// unknown term is unknown rather than the sum of the known ones, that a cost per success with no
// successes is undefined rather than zero or infinite, and that an estimated figure never quietly
// becomes a provider-reported one on its way through an aggregate.

import { describe, expect, it } from 'vitest';
import {
  FrontierAttemptMetrics, aggregateCandidateMetrics, aggregateFromRows, attemptMetricsFromRow,
  describeCandidateMetrics, estimatedQuantity, measuredQuantity, quantityValue, reportedQuantity,
  sumQuantities, unavailableQuantity, worstProvenance,
} from '../../src/engine/frontier-metrics';

function attempt(overrides: Partial<FrontierAttemptMetrics> = {}): FrontierAttemptMetrics {
  return {
    candidate: 'a', slotKey: 'a|s|1|c', provider: 'anthropicAPI', executionClass: 'meteredAPI', billingBasis: 'meteredAPI',
    inputTokens: reportedQuantity(100),
    visibleOutputTokens: reportedQuantity(20),
    reasoningTokens: unavailableQuantity('not reported separately'),
    totalTokens: reportedQuantity(120),
    providerReportedGenerationTokensPerSecondMilli: unavailableQuantity('this provider reports no generation duration'),
    clientObservedOutputTokensPerSecondMilli: measuredQuantity(40_000),
    endToEndOutputTokensPerSecondMilli: measuredQuantity(22_000),
    timeToFirstVisibleTokenMilliseconds: measuredQuantity(120),
    totalWallClockMilliseconds: measuredQuantity(900),
    marginalAPIChargeMicroUSD: reportedQuantity(600),
    subscriptionIncludedUsageMicroUSD: unavailableQuantity('this execution is billed per token and consumes no allowance'),
    effectiveUserCostMicroUSD: reportedQuantity(600),
    retryCount: 0,
    timedOut: false,
    wastedTokens: measuredQuantity(0),
    estimatedTotalTokens: estimatedQuantity(118, 'a stated method'),
    measurementQuality: 'providerReported',
    ...overrides,
  };
}

describe('provenance is carried, never upgraded', () => {
  it('orders the four states worst-to-best and keeps the worst in a sum', () => {
    expect(worstProvenance([measuredQuantity(1), reportedQuantity(2)])).toBe('providerReported');
    expect(worstProvenance([measuredQuantity(1), estimatedQuantity(2, 'm')])).toBe('estimated');
    expect(worstProvenance([measuredQuantity(1), unavailableQuantity('r')])).toBe('unavailable');
    expect(sumQuantities([measuredQuantity(1), estimatedQuantity(2, 'm')], 'x').provenance).toBe('estimated');
  });

  it('makes a sum containing an UNKNOWN term unknown, not the sum of the known ones', () => {
    const sum = sumQuantities([reportedQuantity(10), unavailableQuantity('the provider said nothing')], 'at least one term is unknown');
    expect(sum.provenance).toBe('unavailable');
    expect(sum.value).toBeUndefined();
    expect(sum.note).toBe('at least one term is unknown');
    expect(quantityValue(sum)).toBeUndefined();
  });

  it('keeps an absent value absent, rather than defaulting it to zero', () => {
    expect(quantityValue(unavailableQuantity('r'))).toBeUndefined();
    expect(unavailableQuantity('r').value).toBeUndefined();
  });
});

describe('aggregating a candidate', () => {
  it('sums tokens and cost and computes a success rate', () => {
    const metrics = aggregateCandidateMetrics('a', [attempt(), attempt(), attempt(), attempt()], 3);
    expect(quantityValue(metrics.inputTokens)).toBe(400);
    expect(quantityValue(metrics.visibleOutputTokens)).toBe(80);
    expect(quantityValue(metrics.costPerRunMicroUSD)).toBe(2_400);
    expect(quantityValue(metrics.successfulTaskRateMilli)).toBe(750);
    expect(metrics.attemptCount).toBe(4);
    expect(metrics.successfulTaskCount).toBe(3);
  });

  it('divides TOTAL cost by successes, so money spent on failures still counts', () => {
    // Four attempts at 600 each, one of which succeeded. The honest cost per useful answer is 2400,
    // not 600: a model that fails three times out of four costs MORE per answer, not the same.
    const metrics = aggregateCandidateMetrics('a', [attempt(), attempt(), attempt(), attempt()], 1);
    expect(quantityValue(metrics.costPerSuccessfulTaskMicroUSD)).toBe(2_400);
  });

  it('has NO cost per success when there were none — not zero, not infinity', () => {
    const metrics = aggregateCandidateMetrics('a', [attempt(), attempt()], 0);
    expect(metrics.costPerSuccessfulTaskMicroUSD.provenance).toBe('unavailable');
    expect(quantityValue(metrics.costPerSuccessfulTaskMicroUSD)).toBeUndefined();
    expect(metrics.costPerSuccessfulTaskMicroUSD.note).toMatch(/not a number to compare models on/);
    expect(quantityValue(metrics.tokensPerCompletedPass)).toBeUndefined();
  });

  it('keeps reasoning tokens unknown when a provider does not report them apart from output', () => {
    const metrics = aggregateCandidateMetrics('a', [attempt()], 1);
    expect(metrics.reasoningTokens.provenance).toBe('unavailable');
    expect(metrics.reasoningTokens.note).toMatch(/leave this unknown rather than zero/);
  });

  it('adds up wasted tokens and retries across the attempts', () => {
    const metrics = aggregateCandidateMetrics('a', [
      attempt({ retryCount: 2, wastedTokens: measuredQuantity(200) }),
      attempt({ retryCount: 1, wastedTokens: measuredQuantity(100), timedOut: true }),
    ], 1);
    expect(metrics.retryCount).toBe(3);
    expect(quantityValue(metrics.wastedTokens)).toBe(300);
    expect(metrics.timeoutCount).toBe(1);
  });

  it('compares what the provider reported against what would have been estimated', () => {
    const metrics = aggregateCandidateMetrics('a', [attempt(), attempt()], 2);
    expect(quantityValue(metrics.providerReportedTotalTokens)).toBe(240);
    expect(quantityValue(metrics.estimatedTotalTokens)).toBe(236);
    expect(quantityValue(metrics.reportedMinusEstimatedTokens)).toBe(4);
  });

  it('reports the campaign\'s worst provenance as the row\'s honest quality', () => {
    const unknownCost = aggregateCandidateMetrics('a', [attempt({ marginalAPIChargeMicroUSD: unavailableQuantity('no usage reported') })], 1);
    expect(unknownCost.measurementQuality).toBe('unavailable');
    const allReported = aggregateCandidateMetrics('a', [attempt()], 1);
    expect(allReported.measurementQuality).toBe('providerReported');
  });

  it('has no averages at all when nothing was attempted', () => {
    const metrics = aggregateCandidateMetrics('a', [], 0);
    expect(metrics.successfulTaskRateMilli.provenance).toBe('unavailable');
    expect(metrics.successfulTaskRateMilli.note).toMatch(/nothing to average/);
    expect(metrics.medianClientObservedOutputTokensPerSecondMilli.provenance).toBe('unavailable');
    expect(metrics.medianProviderReportedGenerationTokensPerSecondMilli.provenance).toBe('unavailable');
  });

  it('prints the provenance in its one-line summary rather than hiding it', () => {
    expect(describeCandidateMetrics(aggregateCandidateMetrics('a', [attempt()], 0))).toMatch(/no cost\/success/);
    expect(describeCandidateMetrics(aggregateCandidateMetrics('a', [attempt()], 1))).toMatch(/providerReported$/);
  });
});

describe('reading metrics back out of ledger rows', () => {
  const row = {
    candidate: 'anthropicAPI:m', slotKey: 'k', provider: 'anthropicAPI', executionClass: 'meteredAPI',
    billingBasis: 'meteredAPI', status: 'pass',
    inputTokens: 100, visibleOutputTokens: 20, totalTokens: 120, usageProvenance: 'providerReported',
    costMicroUSD: 600, costProvenance: 'providerReported',
    latencyMilliseconds: 900, timeToFirstTokenMilliseconds: 120, retryCount: 0, wastedTokens: 0, timedOut: false,
  };

  it('preserves the provenance the row recorded', () => {
    const metrics = attemptMetricsFromRow(row)!;
    expect(metrics.inputTokens.provenance).toBe('providerReported');
    expect(metrics.marginalAPIChargeMicroUSD.provenance).toBe('providerReported');
    expect(metrics.timeToFirstVisibleTokenMilliseconds.provenance).toBe('measured');
  });

  it('preserves an ABSENCE as an absence, with its reason', () => {
    const metrics = attemptMetricsFromRow({ ...row, inputTokens: undefined, usageProvenance: 'unavailable' })!;
    expect(metrics.inputTokens.provenance).toBe('unavailable');
    expect(metrics.inputTokens.note).toMatch(/no input token count was recorded/);
    expect(metrics.marginalAPIChargeMicroUSD.provenance).toBe('providerReported');
  });

  it('says why there is no PROVIDER-REPORTED throughput, while still deriving the client-observed one', () => {
    const metrics = attemptMetricsFromRow({ ...row, providerReportedGenerationMilliseconds: undefined })!;
    expect(metrics.providerReportedGenerationTokensPerSecondMilli.provenance).toBe('unavailable');
    expect(metrics.providerReportedGenerationTokensPerSecondMilli.note).toMatch(/reported no generation duration/);
    // The client watched bytes arrive, so THAT figure exists — under its own name, with its caveat.
    expect(metrics.clientObservedOutputTokensPerSecondMilli.provenance).toBe('measured');
    expect(metrics.clientObservedOutputTokensPerSecondMilli.note).toMatch(/NOT the provider's internal/);
  });

  it('ignores a row that binds no provider, rather than inventing one for it', () => {
    expect(attemptMetricsFromRow({ slotKey: 'k', status: 'pass' })).toBeUndefined();
  });

  it('groups by candidate and counts only `pass` as a success', () => {
    const rows = [
      { ...row, status: 'pass' },
      { ...row, status: 'partial' },
      { ...row, status: 'fail' },
      { ...row, candidate: 'claudeCLI:s', provider: 'claudeCLI', executionClass: 'subscriptionCLI', billingBasis: 'subscriptionIncluded', costMicroUSD: 0, costProvenance: 'measured', status: 'pass' },
    ];
    const aggregates = aggregateFromRows(rows, (entry) => entry.status === 'pass');
    expect(aggregates.map((entry) => entry.candidate)).toEqual(['anthropicAPI:m', 'claudeCLI:s']);
    // `partial` is reported beside a pass and never merged into one.
    expect(aggregates[0].successfulTaskCount).toBe(1);
    expect(aggregates[0].attemptCount).toBe(3);
    expect(aggregates[1].billingBasis).toBe('subscriptionIncluded');
    expect(quantityValue(aggregates[1].costPerRunMicroUSD)).toBe(0);
  });
});
