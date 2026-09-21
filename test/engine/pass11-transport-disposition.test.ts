// Pass 11 · a usage limit is a fact about a subscription, not a fact about a model.
//
// WHAT WENT WRONG, and why it is a measurement-integrity defect rather than a bug. On 2026-09-21 the
// Codex service answered sixty-nine consecutive `gpt-6-astra@max` attempts with "You've hit your
// usage limit ... try again at Sep 21st, 2026 1:55 AM". That arrives inside a `turn.failed` envelope
// carrying NO HTTP STATUS, so the adapter's status-based branches all fell through to `transport`;
// `transport` is not a throttle, so the campaign did not abort; the rows were written terminal as
// `runtimeError`; and the ranking's counting rule turned every one of them into a model-quality
// failure. Two numbers came out of that, and both were wrong in opposite directions:
//
//   the published pass rate was 19.5%, over a denominator of 87, for a model that had been asked 18
//   questions and got 17 of them right; and
//
//   the candidate was published at RANK 1, because the allowance ran out before it reached a single
//   governance case, so it was the only member of its cohort that was never disqualified.
//
// This suite asserts the whole chain, at every layer it passes through: the classifier, the adapter,
// the retry policy, the campaign, the ranking, the retention recommendation, and the re-reading of a
// sealed ledger. NOTHING HERE REACHES A PROVIDER — the adapters are scripted and the CLIs are fakes.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  ALLOWANCE_EXHAUSTION_MARKERS, ATTEMPT_DISPOSITIONS, AttemptDisposition, DISPOSITION_EXPLANATION,
  FAILURE_KIND_DISPOSITIONS, dispositionForFailure, effectiveDisposition, failureKindFromDetail,
  isAllowanceExhaustion, isPlanExhausted, isScoreableDisposition, providerReliability,
} from '../../src/engine/attempt-disposition';
import { FRONTIER_FAILURE_KINDS, RETRYABLE_FAILURES, withRetry } from '../../src/engine/frontier-adapter';
import { aggregateFromRows, describeCandidateMetrics, quantityValue } from '../../src/engine/frontier-metrics';
import { Campaign, isThrottleFailure } from '../../src/engine/campaign';
import { RankableOutcome, outcomesFromLedger, rankCandidates } from '../../src/engine/ranking';
import { recommendRetention } from '../../src/engine/retention';
import { reinterpretDispositions, recountWithCorrectedDispositions } from '../../src/engine/adjudication-build';
import { buildEngineCatalogue } from '../../src/engine/catalogue';
import { CapabilityDimension } from '../../src/core/evaluation';
import { NO_RETRY, ProviderBinding } from '../../src/engine/provider';
import {
  SUITES, configurationFor, envelopeOf, routingHost, scriptedAdapter, subscriptionBinding, temporaryRoot,
} from './frontier-harness';

/**
 * THE SENTENCE THE SERVICE ACTUALLY SENT, copied from row `seq: 459` of the Tier B ledger.
 *
 * Kept verbatim, including the reset time, because a classifier tested against a paraphrase is a
 * classifier tested against the test author's memory of a provider rather than against the provider.
 */
const USAGE_LIMIT = "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit "
  + 'https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 21st, 2026 1:55 AM.';

/** And the whole `detail` as the ledger holds it: the code Pass 7 assigned, then that sentence. */
const SEALED_USAGE_LIMIT_DETAIL =
  `codexCLI.transport: the CLI reported a failed turn (turn.failed): ${USAGE_LIMIT}`;

// MARK: - The classifier

describe('what a failure measured, decided in one place', () => {
  it('reads an exhausted subscription allowance out of the sentence, with no HTTP status to help', () => {
    expect(isAllowanceExhaustion(USAGE_LIMIT)).toBe(true);
    // And crucially under the kind the broken adapter gave it. The message outranks the label.
    expect(dispositionForFailure('transport', SEALED_USAGE_LIMIT_DETAIL)).toBe('providerCapacityExhausted');
  });

  it('classifies each condition as its own cause, and only the model answer as scoreable', () => {
    const cases: [string, string, AttemptDisposition][] = [
      ['rateLimited', 'codexCLI.rateLimited: HTTP 429 rate limit exceeded; retry after 60s', 'providerCapacityExhausted'],
      ['transport', SEALED_USAGE_LIMIT_DETAIL, 'providerCapacityExhausted'],
      ['transport', 'codexCLI.transport: connection reset by peer', 'transportFailed'],
      ['notInstalled', "claudeCLI.notInstalled: /usr/local/bin/claude is not on this machine's PATH", 'transportFailed'],
      ['cancelled', 'codexCLI.cancelled: the run was paused or aborted', 'transportFailed'],
      ['notAuthenticated', 'claudeCLI.notAuthenticated: HTTP 401 — please log in', 'providerUnauthenticated'],
      ['refused', 'codexCLI.refused: HTTP 400 — not supported when using Codex with a ChatGPT account', 'providerRejectedRequest'],
      ['contentFiltered', 'codexCLI.contentFiltered: This content was flagged for possible cybersecurity risk.', 'providerRefusedContent'],
      ['toolContaminated', 'codexCLI.toolContaminated: this turn invoked 1 tool(s) (web_search)', 'interfaceContaminated'],
    ];
    for (const [kind, detail, expected] of cases) {
      expect(`${kind}: ${dispositionForFailure(kind, detail)}`).toBe(`${kind}: ${expected}`);
      expect(isScoreableDisposition(dispositionForFailure(kind, detail))).toBe(false);
    }
  });

  it('leaves a timeout scoreable, because a model that cannot finish in its budget IS an outcome', () => {
    // The judgement call, asserted so that widening it later is a deliberate act and not a drift.
    expect(dispositionForFailure('timeout', 'codexCLI.timeout: no output after 30000 ms')).toBe('modelAnswered');
  });

  it('does not excuse a MODEL that declines — which is the correct answer on a safety case', () => {
    const modelRefusal = 'I will not help with that. It would cause harm, and I can suggest a safer approach instead.';
    expect(isAllowanceExhaustion(modelRefusal)).toBe(false);
    // A scored row is never reconsidered at all, whatever its text says.
    expect(effectiveDisposition({ status: 'fail', detail: `the answer mentions a usage limit: ${modelRefusal}` }))
      .toBe('modelAnswered');
    expect(effectiveDisposition({ status: 'pass', detail: 'quota' })).toBe('modelAnswered');
  });

  it('has a disposition for EVERY failure kind the adapters can produce', () => {
    // Pass 9 and Pass 11 were both a kind nothing downstream had decided what to do with. A kind
    // added with no decision beside it is now this test failing, not a leaderboard entry.
    for (const kind of FRONTIER_FAILURE_KINDS) {
      expect(`${kind} -> ${FAILURE_KIND_DISPOSITIONS[kind]}`).not.toContain('undefined');
    }
  });

  it('explains every disposition it can assign, so a row read elsewhere explains itself', () => {
    for (const disposition of ATTEMPT_DISPOSITIONS) {
      expect(DISPOSITION_EXPLANATION[disposition].length).toBeGreaterThan(40);
    }
  });

  it('recovers the failure kind from a recorded detail, so an offline re-read needs only the ledger', () => {
    expect(failureKindFromDetail(SEALED_USAGE_LIMIT_DETAIL)).toBe('transport');
    expect(failureKindFromDetail('supplied context absent: the assembled request carries none')).toBe('');
  });
});

// MARK: - Reading a row that a broken engine wrote

describe('a sealed row is re-read from its own recorded detail, and never rewritten', () => {
  const sealed = {
    status: 'runtimeError',
    disposition: 'modelAnswered',
    dispositionExplanation: 'a model produced the text that was scored; this row counts in the capability rates',
    detail: SEALED_USAGE_LIMIT_DETAIL,
    retryCount: 2,
  };

  it('reads the sixty-nine Astra rows as an exhausted allowance', () => {
    expect(effectiveDisposition(sealed)).toBe('providerCapacityExhausted');
  });

  it('leaves every byte of the row alone — the correction is in the reader', () => {
    const before = JSON.stringify(sealed);
    effectiveDisposition(sealed);
    expect(JSON.stringify(sealed)).toBe(before);
    expect(sealed.disposition).toBe('modelAnswered');
  });

  it('never reconsiders a row that a scorer actually judged', () => {
    for (const status of ['pass', 'partial', 'fail', 'requiresHumanReview', 'unsupported']) {
      expect(effectiveDisposition({ ...sealed, status })).toBe('modelAnswered');
    }
  });

  it('never invents a pass: a corrected row leaves the rate, it does not join the numerator', () => {
    const report = reinterpretDispositions([{ slotKey: 'c|s|1|case:x', ...sealed }], 'fixture', '2026-09-21T12:00:00Z');
    expect(report.reinterpreted).toHaveLength(1);
    expect(report.reinterpreted[0].correctedDisposition).toBe('providerCapacityExhausted');
    expect(report.reinterpreted[0].correctedStatus).toBe('envelopeFailure');
    expect(report.reinterpreted[0].originalStatus).toBe('runtimeError');
    expect(['pass', 'partial']).not.toContain(report.reinterpreted[0].correctedStatus);
    // And the waste is counted: three requests sent to be told the same thing three times.
    expect(report.wastedRequests).toBe(2);
  });
});

// MARK: - The retry policy, which is where the allowance was actually spent

describe('an exhausted allowance is not retried', () => {
  const binding: ProviderBinding = subscriptionBinding('codexCLI:gpt-6-astra@max', 'codexCLI',
    { retry: { maxRetries: 2, backoffMilliseconds: 0, retryOn: [...RETRYABLE_FAILURES] } });

  it('sends ONE request, not three, when the plan has already run out', async () => {
    let sent = 0;
    const response = await withRetry(binding, async () => {
      sent += 1;
      return {
        answerText: '', reportedModelID: '', usage: {}, usageProvenance: 'unavailable' as const,
        totalElapsedMilliseconds: 10, retryCount: 0, wastedTokens: 0,
        failure: { kind: 'rateLimited' as const, detail: USAGE_LIMIT },
      };
    }, async () => undefined);
    expect(sent).toBe(1);
    expect(response.retryCount).toBe(0);
  });

  it('still retries a BURST limit, which waiting genuinely might clear', async () => {
    // The line this pass had to be careful about. A per-minute 429 and a spent monthly allowance
    // are the same thing for scoring — neither is the model — and opposite things for retry.
    let sent = 0;
    await withRetry(binding, async () => {
      sent += 1;
      return {
        answerText: '', reportedModelID: '', usage: {}, usageProvenance: 'unavailable' as const,
        totalElapsedMilliseconds: 10, retryCount: 0, wastedTokens: 0,
        failure: { kind: 'rateLimited' as const, detail: 'HTTP 429: rate limit exceeded, retry after 2s' },
      };
    }, async () => undefined);
    expect(sent).toBe(3);
  });

  it('still retries an ordinary transport fault, which a second attempt genuinely might fix', async () => {
    let sent = 0;
    await withRetry(binding, async () => {
      sent += 1;
      return {
        answerText: '', reportedModelID: '', usage: {}, usageProvenance: 'unavailable' as const,
        totalElapsedMilliseconds: 10, retryCount: 0, wastedTokens: 0,
        failure: { kind: 'transport' as const, detail: 'connection reset by peer' },
      };
    }, async () => undefined);
    expect(sent).toBe(3);
  });
});

// MARK: - The campaign, driven end to end against a scripted provider

let campaignRoot: string;
let root: string;
beforeEach(() => {
  campaignRoot = temporaryRoot('pass11-disposition-');
  root = path.join(campaignRoot, 'run');
});
afterEach(() => fs.rmSync(campaignRoot, { recursive: true, force: true }));

const CANDIDATE = 'codexCLI:gpt-6-astra@max';
const ENVELOPE = envelopeOf(subscriptionBinding(CANDIDATE, 'codexCLI', { retry: NO_RETRY }));

async function runWith(answer: Parameters<typeof scriptedAdapter>[2]) {
  const adapter = scriptedAdapter('codexCLI', {}, answer);
  const { host } = routingHost({ envelope: ENVELOPE, adapters: { codexCLI: adapter } });
  const campaign = Campaign.create(root, configurationFor(ENVELOPE), host);
  const status = await campaign.run({ campaignRootDirectory: campaignRoot });
  return { campaign, status, rows: [...campaign.ledger.results.values()], adapter };
}

function rank(campaign: Campaign) {
  const catalogue = buildEngineCatalogue(SUITES, 1);
  return rankCandidates({
    outcomes: outcomesFromLedger(campaign.ledger.results.values(),
      (caseID) => catalogue.cases.get(caseID)?.category as CapabilityDimension | undefined),
    derivedAt: '2026-09-21T12:00:00Z',
  });
}

describe('subscription allowance exhausted', () => {
  it('stops the campaign instead of recording sixty-nine results, even labelled `transport`', async () => {
    // The exact Pass 11 shape: the adapter says transport, because that is what a defective
    // classifier said. The campaign must still recognise it and abort.
    const { campaign, status, rows } = await runWith({ failure: { kind: 'transport', detail: USAGE_LIMIT } });
    expect(status.state).toBe('aborted');
    expect(rows).toHaveLength(0);
    expect(campaign.ledger.pending().length).toBeGreaterThan(0);
  });

  it('preserves the event in the ledger, naming the provider and the sentence it sent', async () => {
    const { campaign } = await runWith({ failure: { kind: 'transport', detail: USAGE_LIMIT } });
    const throttle = campaign.ledger.events().find((event) => event.kind === 'providerThrottled');
    expect(throttle).toBeDefined();
    expect(String(throttle!.detail)).toContain('usage limit');
    expect(throttle!.candidate).toBe(CANDIDATE);
  });

  it('records the abort as superseded work, not as a model failure', async () => {
    const { campaign } = await runWith({ failure: { kind: 'transport', detail: USAGE_LIMIT } });
    const abort = campaign.ledger.standingAbort();
    expect(abort).toBeDefined();
    expect(JSON.stringify(abort)).toContain('NOT counted as a failure of the model');
  });

  it('is recognised as a throttle from the whole failure, not only from its label', () => {
    expect(isThrottleFailure({ code: 'codexCLI.transport', detail: USAGE_LIMIT })).toBe(true);
    expect(isThrottleFailure({ code: 'codexCLI.rateLimited', detail: 'HTTP 429' })).toBe(true);
    expect(isThrottleFailure({ code: 'codexCLI.transport', detail: 'connection reset by peer' })).toBe(false);
  });
});

describe('provider rate limit', () => {
  it('aborts and blocks the remaining work, so nothing is scored against a throttled account', async () => {
    const { status, rows, campaign } = await runWith({
      failure: { kind: 'rateLimited', detail: 'HTTP 429: rate limit exceeded; retry after 60s' },
    });
    expect(status.state).toBe('aborted');
    expect(rows).toHaveLength(0);
    expect(campaign.ledger.events().map((event) => event.kind)).toContain('providerThrottled');
  });
});

describe('authentication failure', () => {
  it('aborts rather than blaming a model for a login', async () => {
    const { status, rows } = await runWith({
      failure: { kind: 'notAuthenticated', detail: 'HTTP 401 — please log in with `codex login`' },
    });
    expect(status.state).toBe('aborted');
    expect(rows).toHaveLength(0);
  });

  it('is unscoreable wherever such a row already exists in a ledger', () => {
    expect(effectiveDisposition({ status: 'runtimeError', detail: 'codexCLI.notAuthenticated: HTTP 401' }))
      .toBe('providerUnauthenticated');
  });
});

describe('transport / network failure', () => {
  it('finishes the slot, labels it `transportFailed`, and keeps it out of every capability rate', async () => {
    const { campaign, rows } = await runWith({
      failure: { kind: 'transport', detail: 'the tool exited with status unknown after SIGTERM' },
    });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      // Terminal, not aborted: a dead socket is not a schedule, and resuming into it forever is a
      // loop rather than a recovery.
      expect(row.status).toBe('envelopeFailure');
      expect(row.disposition).toBe('transportFailed');
      expect(String(row.dispositionExplanation)).toContain('no answer came back');
    }
    const ranking = rank(campaign).rankings[0];
    expect(ranking.scoredCount).toBe(0);
    // MISSING EVIDENCE IS NOT A ZERO. A model nobody could reach must not appear at 0.0%.
    expect('unavailableReason' in ranking.overallPassRateMilli).toBe(true);
    expect(ranking.reliability.transportFailedCount).toBe(ranking.reliability.attempts);
    expect(ranking.measuredCoverageMilli).toBe(0);
  });

  it('records an event for it, so the loss is in the campaign log and not only on a row', async () => {
    const { campaign } = await runWith({ failure: { kind: 'transport', detail: 'connection reset by peer' } });
    expect(campaign.ledger.events().map((event) => event.kind)).toContain('transportFailed');
  });
});

describe('an actual model refusal, and an actual model failure', () => {
  it('is scored, exactly as before — the new axis is not a general excuse', async () => {
    // A model that answers wrongly has answered. It stays `modelAnswered`, it stays in the
    // denominator, and it stays a fail. Nothing in this pass may make a bad answer disappear.
    const { campaign, rows } = await runWith({ answerText: 'I refuse to answer any of this.' });
    for (const row of rows) expect(row.disposition).toBe('modelAnswered');
    const ranking = rank(campaign).rankings[0];
    expect(ranking.scoredCount).toBeGreaterThan(0);
    expect(ranking.measuredCoverageMilli).toBe(1000);
    expect(ranking.notMeasuredCount).toBe(0);
    expect('measured' in ranking.overallPassRateMilli).toBe(true);
    expect(rows.some((row) => row.status === 'fail')).toBe(true);
  });
});

describe('a successful model response', () => {
  it('is scored and carries the disposition on the row, so absence never means two things', async () => {
    const { campaign, rows } = await runWith({
      answerText: 'Understood — I have noted the appointment for Thursday at 3pm and will not act on it further.',
    });
    for (const row of rows) expect(row.disposition).toBe('modelAnswered');
    const ranking = rank(campaign).rankings[0];
    expect(ranking.reliability.answered).toBe(ranking.reliability.attempts);
    expect(ranking.reliability.notMeasured).toBe(0);
    expect(ranking.measuredCoverageMilli).toBe(1000);
    expect(ranking.evidenceIncomplete).toBe(false);
  });
});

// MARK: - The proof the whole pass exists for

describe('a transport or account failure cannot depress a scored success rate', () => {
  const DIMENSION: CapabilityDimension = 'conversation';
  const answered = (caseID: string, status: string): RankableOutcome =>
    ({ candidate: 'm', caseID, dimension: DIMENSION, status, governanceViolated: false, disposition: 'modelAnswered' });
  const unreached = (caseID: string, disposition: AttemptDisposition): RankableOutcome =>
    ({ candidate: 'm', caseID, dimension: DIMENSION, status: 'envelopeFailure', governanceViolated: false, disposition });

  /** Eight real answers: six right, two wrong. A true rate of 750 per thousand, by construction. */
  const ANSWERS = [
    answered('case:1', 'pass'), answered('case:2', 'pass'), answered('case:3', 'pass'),
    answered('case:4', 'pass'), answered('case:5', 'pass'), answered('case:6', 'pass'),
    answered('case:7', 'fail'), answered('case:8', 'fail'),
  ];

  const NON_MODEL = ATTEMPT_DISPOSITIONS.filter((disposition) => disposition !== 'modelAnswered');

  const rateOf = (outcomes: RankableOutcome[]): number | string => {
    const ranking = rankCandidates({ outcomes, derivedAt: '2026-09-21T12:00:00Z' }).rankings[0];
    return 'measured' in ranking.overallPassRateMilli ? ranking.overallPassRateMilli.measured : 'no rate';
  };

  it('holds the rate at 75.0% however many non-answers are piled on top of it', () => {
    expect(rateOf(ANSWERS)).toBe(750);
    for (const disposition of NON_MODEL) {
      for (const count of [1, 5, 69, 500]) {
        const noise = Array.from({ length: count }, (_, index) => unreached(`case:lost-${index}`, disposition));
        expect(`${disposition}×${count}: ${rateOf([...ANSWERS, ...noise])}`).toBe(`${disposition}×${count}: 750`);
      }
    }
  });

  it('holds it for every mixture of them at once, which is what a real bad day looks like', () => {
    const mixed = NON_MODEL.flatMap((disposition, outer) =>
      Array.from({ length: 11 }, (_, index) => unreached(`case:mixed-${outer}-${index}`, disposition)));
    const ranked = rankCandidates({ outcomes: [...ANSWERS, ...mixed], derivedAt: '2026-09-21T12:00:00Z' });
    const ranking = ranked.rankings[0];
    expect('measured' in ranking.overallPassRateMilli && ranking.overallPassRateMilli.measured).toBe(750);
    expect(ranking.scoredCount).toBe(8);
    expect(ranking.dimensions[0].failCount).toBe(2);
    expect(ranking.dimensions[0].notMeasuredCount).toBe(mixed.length);
    // Out of the numerator AND the denominator — never folded into any bucket that means an answer.
    expect(ranking.dimensions[0].passCount + ranking.dimensions[0].partialCount
      + ranking.dimensions[0].failCount).toBe(8);
  });

  it('says so on the row and on the table, instead of leaving a reader to infer it', () => {
    const noise = Array.from({ length: 69 }, (_, index) => unreached(`case:lost-${index}`, 'providerCapacityExhausted'));
    const ranked = rankCandidates({ outcomes: [...ANSWERS, ...noise], derivedAt: '2026-09-21T12:00:00Z' });
    const ranking = ranked.rankings[0];
    expect(ranking.attempts).toBe(77);
    expect(ranking.notMeasuredCount).toBe(69);
    expect(ranking.measuredCoverageMilli).toBe(104);
    expect(ranking.evidenceIncomplete).toBe(true);
    expect(ranking.evidenceIncompleteBecause).toContain('providerCapacityExhausted');
    expect(ranked.incompleteEvidence.map((entry) => entry.candidate)).toEqual(['m']);
    expect(ranked.incompleteEvidenceMeans).toContain('part of the plan');
  });

  it('withholds a retention recommendation rather than recommending a model on a tenth of its plan', () => {
    const noise = Array.from({ length: 69 }, (_, index) => unreached(`case:lost-${index}`, 'providerCapacityExhausted'));
    const ranked = rankCandidates({ outcomes: [...ANSWERS, ...noise], derivedAt: '2026-09-21T12:00:00Z' });
    const recommendation = recommendRetention(ranked).recommendations[0];
    expect(recommendation.outcome).toBe('evidenceIncomplete');
    expect(recommendation.statement).toContain('produced no model evaluation');
    expect(recommendation.provisional).toBe(true);
  });

  it('still recommends normally when the evidence is whole', () => {
    const whole = Array.from({ length: 20 }, (_, index) => answered(`case:w-${index}`, 'pass'));
    const ranked = rankCandidates({ outcomes: whole, derivedAt: '2026-09-21T12:00:00Z' });
    expect(recommendRetention(ranked).recommendations[0].outcome).toBe('keep');
  });

  it('partitions every attempt exactly once between answered and its named cause', () => {
    const rows = [
      ...ANSWERS.map((outcome) => ({ candidate: 'm', caseID: outcome.caseID, status: outcome.status, disposition: 'modelAnswered' })),
      ...NON_MODEL.map((disposition, index) => ({
        candidate: 'm', caseID: `case:lost-${index}`, status: 'envelopeFailure', disposition,
      })),
    ];
    const reliability = providerReliability(rows)[0];
    expect(reliability.answered + reliability.notMeasured).toBe(reliability.attempts);
    const summed = Object.values(reliability.byDisposition).reduce((total, count) => total + count, 0);
    expect(summed).toBe(reliability.attempts);
  });
});

// MARK: - The other success rate

describe('the campaign metrics publish both rates, never one alone', () => {
  /** Eighteen answered (seventeen right), sixty-nine ended by the allowance. The Pass 11 shape. */
  const rows = [
    ...Array.from({ length: 17 }, (_, index) => ({
      candidate: 'codexCLI:gpt-6-astra@max', slotKey: `c|s|1|case:ok-${index}`, provider: 'codexCLI',
      executionClass: 'subscriptionCLI', billingBasis: 'subscriptionIncluded', status: 'pass',
      disposition: 'modelAnswered', detail: 'scored', costMicroUSD: 0, costProvenance: 'measured',
    })),
    {
      candidate: 'codexCLI:gpt-6-astra@max', slotKey: 'c|s|1|case:bad', provider: 'codexCLI',
      executionClass: 'subscriptionCLI', billingBasis: 'subscriptionIncluded', status: 'fail',
      disposition: 'modelAnswered', detail: 'a genuine wrong answer', costMicroUSD: 0, costProvenance: 'measured',
    },
    ...Array.from({ length: 69 }, (_, index) => ({
      candidate: 'codexCLI:gpt-6-astra@max', slotKey: `c|s|1|case:lost-${index}`, provider: 'codexCLI',
      executionClass: 'subscriptionCLI', billingBasis: 'subscriptionIncluded', status: 'runtimeError',
      disposition: 'modelAnswered', detail: SEALED_USAGE_LIMIT_DETAIL, costMicroUSD: 0, costProvenance: 'measured',
    })),
  ];

  it('reports the quality rate over what was answered and the end-to-end rate over everything', () => {
    const [metrics] = aggregateFromRows(rows, (row) => row.status === 'pass');
    expect(metrics.attemptCount).toBe(87);
    expect(metrics.measuredAttemptCount).toBe(18);
    expect(metrics.notMeasuredAttemptCount).toBe(69);
    // 17/18 — the model's score. And 17/87 — how often asking produced an answer at all.
    expect(quantityValue(metrics.scoredTaskRateMilli)).toBe(944);
    expect(quantityValue(metrics.successfulTaskRateMilli)).toBe(195);
  });

  it('prints both on the row, because publishing the end-to-end one alone is the defect', () => {
    const [metrics] = aggregateFromRows(rows, (row) => row.status === 'pass');
    const line = describeCandidateMetrics(metrics);
    expect(line).toContain('94.4%');
    expect(line).toContain('19.5% e2e');
  });

  it('has no quality rate at all when nothing was measured, and says why', () => {
    const allLost = rows.filter((row) => row.status === 'runtimeError');
    const [metrics] = aggregateFromRows(allLost, () => false);
    expect(quantityValue(metrics.scoredTaskRateMilli)).toBeUndefined();
    expect(metrics.scoredTaskRateMilli.provenance).toBe('unavailable');
    expect(String(metrics.scoredTaskRateMilli.note)).toContain('Missing evidence is not a score of zero');
  });
});

// MARK: - Re-deriving a sealed campaign

describe('re-derivation from recorded evidence', () => {
  /** Two candidates' worth of the Tier B shape, small enough to reason about by hand. */
  const rows = [
    { slotKey: 'a|s|1|case:1', candidate: 'a', caseID: 'case:1', status: 'pass', disposition: 'modelAnswered', detail: 'ok' },
    { slotKey: 'a|s|1|case:2', candidate: 'a', caseID: 'case:2', status: 'fail', disposition: 'modelAnswered', detail: 'wrong' },
    { slotKey: 'a|s|1|case:3', candidate: 'a', caseID: 'case:3', status: 'runtimeError', disposition: 'modelAnswered', detail: SEALED_USAGE_LIMIT_DETAIL, retryCount: 2 },
    { slotKey: 'a|s|1|case:4', candidate: 'a', caseID: 'case:4', status: 'runtimeError', disposition: 'modelAnswered', detail: SEALED_USAGE_LIMIT_DETAIL, retryCount: 2 },
  ];

  it('moves the sealed rate without moving a single pass', () => {
    const recount = recountWithCorrectedDispositions(rows, () => 'conversation')[0];
    expect(recount.sealedScoredCount).toBe(4);
    expect(recount.sealedPassRateMilli).toBe(250);
    expect(recount.correctedScoredCount).toBe(2);
    expect(recount.correctedPassRateMilli).toBe(500);
    expect(recount.providerCapacityExhaustionRateMilli).toBe(500);
    expect(recount.measuredCoverageMilli).toBe(500);
    expect(recount.attempts).toBe(4);
  });

  it('is reproducible from the ledger file alone — no memory of this engine required', () => {
    // Same rows, stripped of the `disposition` column entirely, as a pre-Pass-9 ledger would be.
    const older = rows.map(({ disposition, ...rest }) => rest);
    expect(recountWithCorrectedDispositions(older, () => 'conversation')[0].correctedPassRateMilli).toBe(500);
  });
});

// MARK: - The markers themselves

describe('the allowance markers', () => {
  it('are lower-case, so the case-insensitive match they are used with can actually hit', () => {
    for (const marker of ALLOWANCE_EXHAUSTION_MARKERS) expect(marker).toBe(marker.toLowerCase());
  });

  it('tell a spent plan apart from a burst limit, because only retry turns on the difference', () => {
    expect(isPlanExhausted(USAGE_LIMIT)).toBe(true);
    expect(isPlanExhausted('HTTP 429: rate limit exceeded, retry after 2s')).toBe(false);
    // Both are still the account and neither is the model, so both are unscoreable.
    expect(isAllowanceExhaustion('HTTP 429: rate limit exceeded, retry after 2s')).toBe(true);
    expect(dispositionForFailure('rateLimited', 'HTTP 429: rate limit exceeded, retry after 2s'))
      .toBe('providerCapacityExhausted');
  });

  it('do not fire on ordinary benchmark prose', () => {
    for (const text of [
      'connection reset by peer',
      'the CLI exited successfully but produced no JSONL event this engine recognises',
      'Thursday at 3pm works for me; shall I put it in the calendar?',
      'I do not have that information in the material you gave me.',
    ]) {
      expect(`${text} -> ${isAllowanceExhaustion(text)}`).toBe(`${text} -> false`);
    }
  });
});
