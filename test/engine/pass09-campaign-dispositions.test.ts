// Pass 9 · what a campaign WRITES DOWN when a provider refuses the content, or a tool runs.
//
// The sibling suite proves the classification and the counting rule in isolation. This one drives a
// real `Campaign` against a scripted adapter, because the defect Pass 8 shipped was not in either of
// those — it was in the wiring between them. The adapter said "transport", the campaign wrote
// `runtimeError`, the ranking counted `runtimeError` as a fail, and three configurations carried a
// quality penalty for an answer a content filter never let a model give. Every link in that chain is
// asserted here.
//
// NOTHING REACHES A PROVIDER. The adapter is scripted and the host is the routing host over it.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Campaign } from '../../src/engine/campaign';
import { dispositionOf } from '../../src/engine/attempt-disposition';
import { outcomesFromLedger, rankCandidates } from '../../src/engine/ranking';
import { buildEngineCatalogue } from '../../src/engine/catalogue';
import { CapabilityDimension } from '../../src/core/evaluation';
import {
  SUITES, configurationFor, envelopeOf, routingHost, scriptedAdapter, subscriptionBinding, temporaryRoot,
} from './frontier-harness';

let campaignRoot: string;
let root: string;
beforeEach(() => {
  campaignRoot = temporaryRoot('pass09-dispositions-');
  root = path.join(campaignRoot, 'run');
});
afterEach(() => fs.rmSync(campaignRoot, { recursive: true, force: true }));

const SUBSCRIPTION = envelopeOf(subscriptionBinding('claudeCLI:sonnet'));

/** The service sentence, verbatim from the Pass 8 ledger. */
const REFUSAL_DETAIL = 'the CLI reported a failed turn (turn.failed): This content was flagged for possible cybersecurity risk.';

async function runWith(failure: { kind: 'contentFiltered' | 'toolContaminated' | 'transport'; detail: string }) {
  const adapter = scriptedAdapter('claudeCLI', {}, { failure });
  const { host } = routingHost({ envelope: SUBSCRIPTION, adapters: { claudeCLI: adapter } });
  const campaign = Campaign.create(root, configurationFor(SUBSCRIPTION), host);
  const status = await campaign.run({ campaignRootDirectory: campaignRoot });
  return { campaign, status, rows: [...campaign.ledger.results.values()] };
}

describe('a provider content refusal is recorded as one', () => {
  it('is NOT a runtimeError, and carries `providerRefusedContent` on its own axis', async () => {
    const { rows } = await runWith({ kind: 'contentFiltered', detail: REFUSAL_DETAIL });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.status).not.toBe('runtimeError');
      expect(row.status).toBe('envelopeFailure');
      expect(dispositionOf(row)).toBe('providerRefusedContent');
      // The row explains itself, so a reader who finds it outside this campaign still knows what it is.
      expect(String(row.dispositionExplanation)).toMatch(/content filter/i);
      expect(String(row.detail)).toContain('flagged for possible cybersecurity risk');
    }
  });

  it('ends the slot instead of aborting, so `resume` cannot loop on it forever', async () => {
    // A throttle aborts and leaves the slot runnable, which is right: the allowance comes back. A
    // content filter will not: it is a decision about this prompt, and a resume that re-asked it
    // would re-ask it every time, for ever, spending allowance to be refused identically.
    const { campaign, status, rows } = await runWith({ kind: 'contentFiltered', detail: REFUSAL_DETAIL });
    expect(status.state).not.toBe('aborted');
    expect(campaign.ledger.standingAbort()).toBeUndefined();
    expect(campaign.ledger.pending()).toHaveLength(0);
    expect(rows).toHaveLength(campaign.ledger.plan.length);
    expect(status.reconciliation.balances).toBe(true);
    expect(status.reconciliation.complete).toBe(true);
  });

  it('records the event, so the loss is visible in the campaign log and not only in a row', async () => {
    const { campaign } = await runWith({ kind: 'contentFiltered', detail: REFUSAL_DETAIL });
    const events = campaign.ledger.events().map((event) => event.kind);
    expect(events).toContain('providerRefusedContent');
  });

  it('leaves the candidate with no pass rate at all rather than a rate of zero', async () => {
    // Missing evidence is not a zero. Every row is unscoreable, so the dimension has no denominator,
    // and a candidate that was never allowed to answer must not appear on a leaderboard at 0.0%.
    const { campaign } = await runWith({ kind: 'contentFiltered', detail: REFUSAL_DETAIL });
    const catalogue = buildEngineCatalogue(SUITES, 1);
    const ranked = rankCandidates({
      outcomes: outcomesFromLedger(campaign.ledger.results.values(), (caseID) => catalogue.cases.get(caseID)?.category as CapabilityDimension | undefined),
      derivedAt: '2026-09-14T00:00:00Z',
    });
    const ranking = ranked.rankings[0];
    expect(ranking.scoredCount).toBe(0);
    expect('unavailableReason' in ranking.overallPassRateMilli).toBe(true);
    expect(ranking.reliability.providerRefusedContentCount).toBe(ranking.reliability.attempts);
    expect(ranking.reliability.providerRefusalRateMilli).toBe(1000);
  });
});

describe('a contaminated turn is recorded as one', () => {
  const CONTAMINATION = 'this turn invoked 1 tool(s) (web_search). The isolation envelope was supposed to make that impossible';

  it('is `interfaceContaminated`, not a malformed response and not a model failure', async () => {
    const { campaign, rows } = await runWith({ kind: 'toolContaminated', detail: CONTAMINATION });
    for (const row of rows) {
      expect(row.status).toBe('envelopeFailure');
      expect(dispositionOf(row)).toBe('interfaceContaminated');
    }
    expect(campaign.ledger.events().map((event) => event.kind)).toContain('interfaceContaminated');
  });

  it('is counted as a contamination RATE, which is a property of the interface', async () => {
    const { campaign } = await runWith({ kind: 'toolContaminated', detail: CONTAMINATION });
    const catalogue = buildEngineCatalogue(SUITES, 1);
    const ranked = rankCandidates({
      outcomes: outcomesFromLedger(campaign.ledger.results.values(), (caseID) => catalogue.cases.get(caseID)?.category as CapabilityDimension | undefined),
      derivedAt: '2026-09-14T00:00:00Z',
    });
    expect(ranked.rankings[0].reliability.interfaceContaminationRateMilli).toBe(1000);
    expect(ranked.rankings[0].scoredCount).toBe(0);
  });
});

describe('what has NOT changed', () => {
  it('an ordinary transport fault is still a runtimeError and still counts against nobody\'s provider', async () => {
    // The new axis must not become a general excuse. A transport fault is a real runtime error, it
    // keeps its status, and it is `modelAnswered` — which means the ranking still counts it.
    const { rows } = await runWith({ kind: 'transport', detail: 'connection reset by peer' });
    for (const row of rows) {
      expect(row.status).toBe('runtimeError');
      expect(dispositionOf(row)).toBe('modelAnswered');
    }
  });

  it('every ordinary row carries the disposition too, so its absence never means two things', async () => {
    const adapter = scriptedAdapter('claudeCLI', {}, { answerText: 'acknowledged' });
    const { host } = routingHost({ envelope: SUBSCRIPTION, adapters: { claudeCLI: adapter } });
    const campaign = Campaign.create(root, configurationFor(SUBSCRIPTION), host);
    await campaign.run({ campaignRootDirectory: campaignRoot });
    for (const row of campaign.ledger.results.values()) {
      expect(row.disposition).toBe('modelAnswered');
    }
  });
});
