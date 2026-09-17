// Cernum · REQ-03 Phase 0 — evaluator soundness, before any adjudication.
//
// `CERNUM-REQ-03-CAPABILITY-EVALUATOR-VALIDATION-PLAN.md` §3: re-run the CURRENT evaluator offline
// over the stored answers and require it to reproduce the sealed ledger status row for row. Publish
// the comparison. **Hard stop on any mismatch.**
//
// WHY THIS COMES FIRST. Every later REQ-03 number is a difference between two JUDGEMENTS — the
// evaluator's and a person's. That reading is only available if the evaluator reproduces the ledger
// exactly; otherwise the difference is between two DATA SETS, and no adjudication can separate the
// two. This is the same discipline the candidate-matcher differential applied before it compared
// anything.
//
// WHAT THIS FILE DOES NOT DO. It adjudicates nothing, refers nothing, repairs nothing, and recomputes
// no rate. It runs the evaluator exactly as it stands, under scoring policy version 1, which is the
// version every one of these rows was scored under and still resolves to.

import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { caseByID, policyCatalog } from '../../src/core/catalog';
import { EvaluationEngine } from '../../src/core/engine';
import { AttemptRecord, Observation } from '../../src/core/run';

const EVIDENCE_ROOT = process.env.CERNUM_EVIDENCE_ROOT
  ?? '/Volumes/LaCie/MacMini-NemoClaw-Workspace/model-lab-results';

/** The raw Pass 8 ledger, pinned to the digests recorded in `pass08-evidence/SHA256SUMS.txt`. */
const LEDGERS = [
  { path: 'pass08-evidence/campaign-a2/results.jsonl', digest: 'adcb22f1ab7908b5c08d1568ee316e1001cad9ab6b101cb43b0dab3e711799f0' },
  { path: 'pass08-evidence/campaign-b2/results.jsonl', digest: '0a1561d7bd4f8cab4644b08f529b9e8711572aa03d0d9b82f5301875adc65f96' },
];

/** The corpus shape the plan bounds against. A different shape means a different corpus. */
const EXPECTED_TOTAL = 616;
const EXPECTED_BY_STATUS: Record<string, number> = {
  pass: 350, fail: 182, partial: 48, requiresHumanReview: 28, runtimeError: 8,
};
/**
 * `runtimeError` is an ATTEMPT status, not an evaluation status — those 8 attempts never produced an
 * answer and never reached the evaluator. They are excluded from the reproduction and named here
 * rather than quietly folded into a denominator.
 */
const ATTEMPT_LEVEL_STATUS = 'runtimeError';
const EXPECTED_EVALUATED = EXPECTED_TOTAL - EXPECTED_BY_STATUS[ATTEMPT_LEVEL_STATUS];

function hardStop(message: string): never {
  throw new Error(`REQ-03 PHASE 0 HARD STOP — ${message}`);
}

interface LedgerRow {
  slotKey: string; caseID: string; candidate: string; status: string;
  answerText?: string; detail?: string; governanceViolated?: boolean;
}

function loadLedger(): LedgerRow[] {
  const rows: LedgerRow[] = [];
  for (const source of LEDGERS) {
    const raw = readFileSync(join(EVIDENCE_ROOT, source.path));
    const digest = createHash('sha256').update(raw).digest('hex');
    if (digest !== source.digest) hardStop(`${source.path} digest ${digest} ≠ pinned ${source.digest}`);
    for (const line of raw.toString('utf8').split('\n')) {
      if (line.trim().length === 0) continue;
      rows.push(JSON.parse(line) as LedgerRow);
    }
  }
  return rows;
}

const ledger = loadLedger();

/**
 * The ENGINE does the judging, not a second opinion assembled here.
 *
 * Delegation, rubric composition and the human-review path are all engine behaviour. Re-implementing
 * any of them in this file would make Phase 0 a comparison between the ledger and a reimplementation,
 * which is precisely the confusion Phase 0 exists to rule out.
 */
const engine = new EvaluationEngine(policyCatalog, () => new Date('2026-01-01T00:00:00Z'));

/** The stored answer, put back in front of the evaluator exactly as the run recorded it. */
function observationFor(row: LedgerRow): Observation {
  return {
    outputText: row.answerText,
    toolCallObservationsRaw: [],
    terminalStatus: 'completed',
    providerReportedUsage: { unavailableReason: 'replayed from the sealed ledger' },
    timing: { startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-01T00:00:00Z', durationMilliseconds: { measured: 0 } },
    warnings: [], errors: [],
    identityVerification: { state: 'unverifiable', reportedModelID: { unavailableReason: 'replayed' }, requestedModelID: '' },
    runtimeConfigurationID: 'replay',
    requestDigest: 'replay',
  } as unknown as Observation;
}

/** A minimal attempt carrying the only things the engine reads: the case's policy and the answer. */
function attemptFor(row: LedgerRow): AttemptRecord {
  const benchmarkCase = caseByID(row.caseID);
  if (!benchmarkCase) hardStop(`case ${row.caseID} is not in the catalog`);
  return {
    attemptID: `replay:${row.slotKey}`,
    runID: 'req03-phase0',
    ordinal: 0,
    repetitionIndex: 1,
    candidate: { id: { raw: row.candidate } },
    candidateDigest: 'replay',
    suiteID: benchmarkCase.suiteID,
    suiteVersion: benchmarkCase.suiteVersion,
    caseID: benchmarkCase.id,
    caseDigest: 'replay',
    inputPackage: benchmarkCase.inputs,
    inputPackageDigest: 'replay',
    scoringPolicyID: benchmarkCase.scoringPolicyID,
    scoringPolicyVersion: benchmarkCase.scoringPolicyVersion,
    environment: {} as AttemptRecord['environment'],
    observation: observationFor(row),
    terminalStatus: 'completed',
    comparabilityKey: 'replay',
    startedAt: '2026-01-01T00:00:00Z',
    finishedAt: '2026-01-01T00:00:00Z',
  } as unknown as AttemptRecord;
}

function reproducedStatus(row: LedgerRow): string {
  return engine.evaluate(attemptFor(row)).verdict.status;
}

describe('REQ-03 Phase 0 · the corpus is the one the plan bounds', () => {
  it('loads exactly 616 rows from the two pinned ledgers', () => {
    expect(ledger.length).toBe(EXPECTED_TOTAL);
  });

  it('carries exactly the status distribution the plan states', () => {
    const counts: Record<string, number> = {};
    for (const row of ledger) counts[row.status] = (counts[row.status] ?? 0) + 1;
    expect(counts).toEqual(EXPECTED_BY_STATUS);
  });

  it('names the 8 attempt-level rows rather than folding them into a denominator', () => {
    const attemptLevel = ledger.filter((r) => r.status === ATTEMPT_LEVEL_STATUS);
    expect(attemptLevel.length).toBe(8);
    // None of them produced an answer, which is why they never reached the evaluator.
    for (const row of attemptLevel) expect(row.answerText ?? '').toBe('');
  });

  it('records Phase 0b — the 28 rows that have never been ruled by anyone', () => {
    const pending = ledger.filter((r) => r.status === 'requiresHumanReview');
    expect(pending.length).toBe(28);
    // Recorded, not deferred: they sit inside every published rate and no person has ruled them.
    expect(pending.every((r) => (r.answerText ?? '').length > 0)).toBe(true);
  });
});

describe('REQ-03 Phase 0 · the evaluator reproduces the sealed ledger, row for row', () => {
  const evaluated = ledger.filter((r) => r.status !== ATTEMPT_LEVEL_STATUS);
  const mismatches: { slotKey: string; caseID: string; ledger: string; reproduced: string }[] = [];
  let reproduced = 0;
  for (const row of evaluated) {
    const got = reproducedStatus(row);
    if (got === row.status) reproduced += 1;
    else mismatches.push({ slotKey: row.slotKey, caseID: row.caseID, ledger: row.status, reproduced: got });
  }

  it('evaluates every row that produced an answer', () => {
    expect(evaluated.length).toBe(EXPECTED_EVALUATED);
  });

  it('reproduces every sealed status — any mismatch is a hard stop', () => {
    expect(mismatches).toEqual([]);
    expect(reproduced).toBe(EXPECTED_EVALUATED);
  });

  it('writes the Phase 0 comparison', () => {
    const out = process.env.CERNUM_REQ03_PHASE0_REPORT;
    if (!out) return;
    const byStatus: Record<string, { ledger: number; reproduced: number }> = {};
    for (const row of evaluated) {
      const s = row.status;
      byStatus[s] ??= { ledger: 0, reproduced: 0 };
      byStatus[s].ledger += 1;
      if (reproducedStatus(row) === s) byStatus[s].reproduced += 1;
    }
    writeFileSync(out, JSON.stringify({
      requirement: 'REQ-03',
      phase: '0 — evaluator soundness',
      scoringPolicyVersion: '1',
      corpus: { total: ledger.length, byStatus: EXPECTED_BY_STATUS },
      excluded: {
        status: ATTEMPT_LEVEL_STATUS, count: EXPECTED_BY_STATUS[ATTEMPT_LEVEL_STATUS],
        why: 'attempt-level failures that produced no answer and never reached the evaluator',
        slotKeys: ledger.filter((r) => r.status === ATTEMPT_LEVEL_STATUS).map((r) => r.slotKey).sort(),
      },
      evaluated: evaluated.length,
      reproduced, mismatches,
      soundnessHolds: mismatches.length === 0 && reproduced === EXPECTED_EVALUATED,
      byStatus,
      phase0b: {
        neverRuledByAnyone: ledger.filter((r) => r.status === 'requiresHumanReview').length,
        note: 'These 28 rows carry status requiresHumanReview, have never been ruled by any person, and '
            + 'sit inside every published rate. Every rate must state how it treats them.',
        slotKeys: ledger.filter((r) => r.status === 'requiresHumanReview').map((r) => r.slotKey).sort(),
      },
      ledgersPinned: LEDGERS,
    }, null, 1) + '\n', 'utf8');
  });
});
