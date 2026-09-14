// Pass 7 · the two figures Pass 6 computed and then threw away, and the fixtures that prove it.
//
// Both defects had the same shape: a value the adapters parsed CORRECTLY, discarded at a boundary on
// its way to the ledger. Neither was caught by 825 passing tests, because nothing asserted what the
// ledger row itself had to contain. These tests assert exactly that, against the real envelopes the
// Pass 6 pilot received.
//
// THE DEFECT IS REPRODUCED BEFORE IT IS CORRECTED. A test that only checks the new number cannot
// tell a fix from a coincidence, so each case first shows what Pass 6 recorded and then shows the
// corrected path disagreeing with it by the documented factor.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Campaign, campaignPaths } from '../../src/engine/campaign';
import { Ledger } from '../../src/engine/ledger';
import { totalInputTokens, parseCLIResponse } from '../../src/engine/frontier-adapter';
import { readCodexUsage } from '../../src/engine/codex-cli';
import { attemptMetricsFromRow, aggregateFromRows, quantityValue } from '../../src/engine/frontier-metrics';
import { PASS06_CAPTURED } from './fixtures/pass06-captured';
import { PROVEN_SONNET_HIGH, PROVEN_HAIKU } from './fixtures/claude-cli';
import {
  configurationFor, envelopeOf, routingHost, scriptedAdapter, subscriptionBinding, temporaryRoot,
} from './frontier-harness';

/** The Claude envelope's own decomposition, read the way the adapter reads it. */
function claudeUsage(usage: Record<string, unknown>) {
  const n = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
  return {
    inputTokens: n(usage.input_tokens),
    cacheCreationInputTokens: n(usage.cache_creation_input_tokens),
    cacheReadInputTokens: n(usage.cache_read_input_tokens),
    visibleOutputTokens: n(usage.output_tokens),
  };
}

const CLAUDE = PASS06_CAPTURED.filter((a) => a.provider === 'claudeCLI');
const CODEX = PASS06_CAPTURED.filter((a) => a.provider === 'codexCLI');

describe('the 48 captured Pass 6 responses', () => {
  it('is the whole sealed cohort: 24 Claude and 24 Codex attempts', () => {
    expect(PASS06_CAPTURED).toHaveLength(48);
    expect(CLAUDE).toHaveLength(24);
    expect(CODEX).toHaveLength(24);
    // Twelve configurations, each answering the same four cases exactly once.
    expect(new Set(PASS06_CAPTURED.map((a) => a.candidate)).size).toBe(12);
    expect(new Set(PASS06_CAPTURED.map((a) => a.caseID)).size).toBe(4);
  });

  it('reproduces the Pass 6 Claude undercount: 80 recorded against 131,987 processed', () => {
    const recorded = CLAUDE.reduce((sum, a) => sum + (a.ledgerInputTokens ?? 0), 0);
    const processed = CLAUDE.reduce((sum, a) => sum + (totalInputTokens(claudeUsage(a.usage!)) ?? 0), 0);
    expect(recorded).toBe(80);
    expect(processed).toBe(131_987);
    // Roughly 1,650x. Asserted as a floor rather than a point value so the test says what it means:
    // this is an order-of-magnitude defect, not a rounding one.
    expect(processed / recorded).toBeGreaterThan(1_600);
  });

  it('reproduces the Pass 6 CODEX undercount too, which the Pass 6 report recorded as 1x', () => {
    // The Pass 6 report's §8.2 called the Codex column exact. It was not. `codex` reports
    // `input_tokens` as the TOTAL with the cached portion inside it; the adapter correctly derives
    // the fresh remainder, and the host then recorded the REMAINDER. So the same one-line defect
    // understated both halves — by different factors, in a column that looked like-for-like.
    const recorded = CODEX.reduce((sum, a) => sum + (a.ledgerInputTokens ?? 0), 0);
    const processed = CODEX.reduce((sum, a) => sum + (totalInputTokens(readCodexUsage(a.usage!)) ?? 0), 0);
    expect(recorded).toBe(190_508);
    expect(processed).toBe(333_740);
    expect(processed).toBeGreaterThan(recorded);
  });

  it('puts the corrected pilot-wide input at 465,727 tokens, not the 322,495 Pass 6 published', () => {
    const processed = CLAUDE.reduce((sum, a) => sum + (totalInputTokens(claudeUsage(a.usage!)) ?? 0), 0)
      + CODEX.reduce((sum, a) => sum + (totalInputTokens(readCodexUsage(a.usage!)) ?? 0), 0);
    expect(processed).toBe(465_727);
  });

  it('keeps every attempt\'s decomposition summing to its own total, on both providers', () => {
    for (const attempt of PASS06_CAPTURED) {
      const usage = attempt.provider === 'claudeCLI' ? claudeUsage(attempt.usage!) : readCodexUsage(attempt.usage!);
      const parts = (usage.inputTokens ?? 0) + (usage.cacheCreationInputTokens ?? 0) + (usage.cacheReadInputTokens ?? 0);
      expect(totalInputTokens(usage)).toBe(parts);
      // And the corrected figure is never smaller than what Pass 6 wrote: a correction that could
      // reduce a recorded count would be a different bug.
      expect(totalInputTokens(usage)!).toBeGreaterThanOrEqual(attempt.ledgerInputTokens ?? 0);
    }
  });

  it('reports NOTHING rather than zero when a provider counted nothing', () => {
    expect(totalInputTokens({})).toBeUndefined();
    expect(totalInputTokens({ visibleOutputTokens: 5 })).toBeUndefined();
    // One field present is enough to have a total; the absent ones contribute nothing, not unknown.
    expect(totalInputTokens({ cacheReadInputTokens: 3_289 })).toBe(3_289);
  });
});

describe('the corrected ledger row', () => {
  let campaignRoot: string;
  let root: string;
  beforeEach(() => {
    campaignRoot = temporaryRoot('pass07-correction-');
    root = path.join(campaignRoot, 'run');
  });
  afterEach(() => fs.rmSync(campaignRoot, { recursive: true, force: true }));

  /** The real Pass 6 Claude shape: 2 fresh tokens in front of a cached system prompt. */
  const CAPTURED = claudeUsage(CLAUDE[0].usage!);

  it('records EVERY input token, with the decomposition beside it', async () => {
    const envelope = envelopeOf(subscriptionBinding('claudeCLI:claude-opus-5'));
    const { host } = routingHost({
      envelope,
      adapters: {
        claudeCLI: scriptedAdapter('claudeCLI', {}, {
          usage: CAPTURED,
          subscriptionIncludedUsageMicroUSD: 26_427,
          answerText: 'teal',
        }),
      },
    });
    const campaign = Campaign.create(root, configurationFor(envelope), host);
    await campaign.run({ campaignRootDirectory: campaignRoot });

    const rows = [...campaign.ledger.results.values()];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.inputTokens).toBe(totalInputTokens(CAPTURED));
      expect(row.freshInputTokens).toBe(CAPTURED.inputTokens);
      expect(row.cacheCreationInputTokens).toBe(CAPTURED.cacheCreationInputTokens);
      expect(row.cacheReadInputTokens).toBe(CAPTURED.cacheReadInputTokens);
      // The exact regression: the total is NOT the fresh remainder Pass 6 wrote.
      expect(row.inputTokens).not.toBe(row.freshInputTokens);
      expect(row.totalTokens).toBe((row.inputTokens as number) + (row.visibleOutputTokens as number ?? 0));
    }
  });

  it('carries the plan allowance, its state, its provenance and its explanation', async () => {
    const envelope = envelopeOf(subscriptionBinding('claudeCLI:claude-opus-5'));
    const { host } = routingHost({
      envelope,
      adapters: {
        claudeCLI: scriptedAdapter('claudeCLI', {}, { usage: CAPTURED, subscriptionIncludedUsageMicroUSD: 26_427 }),
      },
    });
    const campaign = Campaign.create(root, configurationFor(envelope), host);
    await campaign.run({ campaignRootDirectory: campaignRoot });

    for (const row of campaign.ledger.results.values()) {
      expect(row.subscriptionIncludedUsageMicroUSD).toBe(26_427);
      expect(row.subscriptionAllowanceState).toBe('reported');
      expect(row.subscriptionAllowanceProvenance).toBe('providerReported');
      expect(String(row.subscriptionAllowanceExplanation)).toMatch(/NOT a charge/);
      // The marginal charge is still a true zero, and still recorded apart from the allowance.
      expect(row.costMicroUSD).toBe(0);
    }
  });

  it('writes NO allowance figure, and no zero, when the provider reported none', async () => {
    const envelope = envelopeOf(subscriptionBinding('codexCLI:gpt-5.6-luna', 'codexCLI'));
    const { host } = routingHost({
      envelope,
      // No `subscriptionIncludedUsageMicroUSD`: this is the Codex case in life.
      adapters: { codexCLI: scriptedAdapter('codexCLI', {}, { usage: readCodexUsage(CODEX[0].usage!) }) },
    });
    const campaign = Campaign.create(root, configurationFor(envelope), host);
    await campaign.run({ campaignRootDirectory: campaignRoot });

    for (const row of campaign.ledger.results.values()) {
      expect(row.subscriptionIncludedUsageMicroUSD).toBeUndefined();
      expect(row.subscriptionAllowanceState).toBe('unavailable');
      expect(row.subscriptionAllowanceProvenance).toBe('unavailable');
      expect(String(row.subscriptionAllowanceExplanation)).toMatch(/NOT zero/);
      // The reading a report would take from the row must be unavailable, not zero.
      const metrics = attemptMetricsFromRow(row as Record<string, unknown>)!;
      expect(metrics.subscriptionIncludedUsageMicroUSD.provenance).toBe('unavailable');
      expect(quantityValue(metrics.subscriptionIncludedUsageMicroUSD)).toBeUndefined();
    }
  });

  it('survives the round trip to disk: a reopened ledger carries all five new columns', async () => {
    const envelope = envelopeOf(subscriptionBinding('claudeCLI:claude-opus-5'));
    const { host } = routingHost({
      envelope,
      adapters: { claudeCLI: scriptedAdapter('claudeCLI', {}, { usage: CAPTURED, subscriptionIncludedUsageMicroUSD: 24_383 }) },
    });
    const campaign = Campaign.create(root, configurationFor(envelope), host);
    await campaign.run({ campaignRootDirectory: campaignRoot });

    const reopened = Ledger.open(campaignPaths(root).ledger);
    for (const row of reopened.results.values()) {
      expect(row.inputTokens).toBe(totalInputTokens(CAPTURED));
      expect(row.freshInputTokens).toBe(CAPTURED.inputTokens);
      expect(row.cacheReadInputTokens).toBe(CAPTURED.cacheReadInputTokens);
      expect(row.subscriptionIncludedUsageMicroUSD).toBe(24_383);
      expect(row.subscriptionAllowanceState).toBe('reported');
    }
  });
});

describe('the allowance the adapter already parsed', () => {
  it('reads Claude Code\'s own list valuation out of a real captured envelope', () => {
    // This half was never broken. It is pinned so a future change cannot break the parse while the
    // persistence test above keeps passing on a value that never arrives.
    const sonnet = parseCLIResponse(PROVEN_SONNET_HIGH)!;
    expect(sonnet.subscriptionIncludedUsageMicroUSD).toBe(24_384);
    const haiku = parseCLIResponse(PROVEN_HAIKU)!;
    expect(haiku.subscriptionIncludedUsageMicroUSD).toBe(14_273);
    // And the same envelope's input decomposition, which is what the host now sums.
    expect(totalInputTokens(sonnet.usage)).toBe(2 + 5_685 + 3_289);
    expect(sonnet.usage.inputTokens).toBe(2);
  });
});

describe('an aggregate refuses to invent what a row did not report', () => {
  const row = (overrides: Record<string, unknown>) => ({
    slotKey: 'c|s|1|case', candidate: 'c', status: 'pass', provider: 'claudeCLI',
    executionClass: 'subscriptionCLI', billingBasis: 'subscriptionIncluded',
    requestedModelID: 'm', reportedModelID: 'm', usageProvenance: 'providerReported',
    costMicroUSD: 0, costProvenance: 'measured', inputTokens: 100, visibleOutputTokens: 10,
    totalTokens: 110, retryCount: 0, wastedTokens: 0, timedOut: false, ...overrides,
  });

  it('leaves a campaign total UNAVAILABLE when one attempt reported no allowance', () => {
    const aggregate = aggregateFromRows([
      row({ slotKey: 'c|s|1|a', subscriptionIncludedUsageMicroUSD: 1_000, subscriptionAllowanceState: 'reported' }),
      row({ slotKey: 'c|s|1|b', subscriptionAllowanceState: 'unavailable' }),
    ], () => true)[0];
    expect(aggregate.subscriptionIncludedUsageMicroUSD.provenance).toBe('unavailable');
    expect(quantityValue(aggregate.subscriptionIncludedUsageMicroUSD)).toBeUndefined();
    expect(aggregate.subscriptionIncludedUsageMicroUSD.note).toMatch(/not zero/);
  });

  it('sums the allowance when EVERY attempt reported one', () => {
    const aggregate = aggregateFromRows([
      row({ slotKey: 'c|s|1|a', subscriptionIncludedUsageMicroUSD: 1_000, subscriptionAllowanceState: 'reported' }),
      row({ slotKey: 'c|s|1|b', subscriptionIncludedUsageMicroUSD: 2_500, subscriptionAllowanceState: 'reported' }),
    ], () => true)[0];
    expect(quantityValue(aggregate.subscriptionIncludedUsageMicroUSD)).toBe(3_500);
    expect(aggregate.subscriptionIncludedUsageMicroUSD.provenance).toBe('providerReported');
  });

  it('believes the STATE over a stray number, and reads the row\'s own explanation', () => {
    const metrics = attemptMetricsFromRow(row({
      subscriptionIncludedUsageMicroUSD: 999,
      subscriptionAllowanceState: 'unavailable',
      subscriptionAllowanceExplanation: 'codexCLI returned no usage valuation for this request.',
    }))!;
    expect(metrics.subscriptionIncludedUsageMicroUSD.provenance).toBe('unavailable');
    expect(quantityValue(metrics.subscriptionIncludedUsageMicroUSD)).toBeUndefined();
    expect(metrics.subscriptionIncludedUsageMicroUSD.note).toMatch(/no usage valuation/);
  });

  it('still reads a pre-Pass-7 row, and says the decomposition is not separable', () => {
    // The sealed Pass 6 ledger has no state field and no decomposition. It must remain readable,
    // and must not acquire a measured zero for the cache it never recorded.
    const metrics = attemptMetricsFromRow(row({ subscriptionIncludedUsageMicroUSD: 35_257 }))!;
    expect(quantityValue(metrics.subscriptionIncludedUsageMicroUSD)).toBe(35_257);
    expect(metrics.freshInputTokens.provenance).toBe('unavailable');
    expect(metrics.freshInputTokens.note).toMatch(/not separable/);
    expect(quantityValue(metrics.cacheReadInputTokens)).toBeUndefined();
  });
});
