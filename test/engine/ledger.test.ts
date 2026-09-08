// The ledger is what makes pause, resume and checkpoint recovery mean something. These tests
// exercise the interruption cases directly — a torn final line, a stale checkpoint, a duplicate
// terminal result — because those are the states a real interruption actually leaves behind, and
// a ledger that is only tested on the happy path has not been tested at all.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ledger, LedgerError, TERMINAL_STATUSES, buildPlan, slotKey } from '../../src/engine/ledger';
import type { PlannableCandidate, PlannableCatalog } from '../../src/engine/ledger';

interface PlanVectors {
  ledgerFormatVersion: number;
  terminalStatuses: string[];
  catalog: PlannableCatalog;
  candidates: PlannableCandidate[];
  slotKeys: string[];
  slots: Record<string, unknown>[];
  planDigest: string;
  slotKeyExamples: { candidate: string; suite: string; pass: number; caseID: string; slotKey: string }[];
}

const vectors = JSON.parse(
  readFixture('ledger-plan-vectors.json'),
) as PlanVectors;

function readFixture(name: string): string {
  return fs.readFileSync(fileURLToPath(new URL(`../../fixtures/parity/engine/${name}`, import.meta.url)), 'utf8');
}

let root: string;
let tick = 0;
const clock = () => `2026-01-01T00:00:${String(tick++).padStart(2, '0')}Z`;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-ledger-'));
  tick = 0;
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function makeLedger(): Ledger {
  return Ledger.create(root, vectors.catalog, vectors.candidates, { campaign: 'test' }, clock);
}

describe('plan parity with the Python harness', () => {
  it('names slots exactly as ledger_v2.slot_key does', () => {
    for (const example of vectors.slotKeyExamples) {
      expect(slotKey(example.candidate, example.suite, example.pass, example.caseID)).toBe(example.slotKey);
    }
  });

  it('produces the same slots, in the same order, as ledger_v2.build_plan', () => {
    const plan = buildPlan(vectors.catalog, vectors.candidates);
    expect(plan.map((slot) => slot.slotKey)).toEqual(vectors.slotKeys);
    expect(plan.length).toBe(vectors.slots.length);
    for (const [index, slot] of plan.entries()) expect(slot).toEqual(vectors.slots[index]);
  });

  it('is candidate-major, so a partial campaign has a contiguous prefix of finished candidates', () => {
    const candidates = buildPlan(vectors.catalog, vectors.candidates).map((slot) => slot.candidate);
    const firstOfSecond = candidates.indexOf(vectors.candidates[1].name);
    expect(candidates.slice(0, firstOfSecond).every((c) => c === vectors.candidates[0].name)).toBe(true);
    expect(candidates.slice(firstOfSecond).every((c) => c === vectors.candidates[1].name)).toBe(true);
  });

  it('computes the same plan digest', () => {
    expect(makeLedger().planDigest()).toBe(vectors.planDigest);
  });

  it("carries the harness's terminal-status set, neither widened nor narrowed", () => {
    expect([...TERMINAL_STATUSES].sort()).toEqual(vectors.terminalStatuses);
  });

  it('declares the same ledger format version', () => {
    makeLedger();
    const plan = JSON.parse(fs.readFileSync(path.join(root, 'plan.json'), 'utf8')) as { ledgerFormatVersion: number };
    expect(plan.ledgerFormatVersion).toBe(vectors.ledgerFormatVersion);
  });
});

describe('the plan is written once and never rewritten', () => {
  it('refuses to recreate a ledger that already has a plan', () => {
    makeLedger();
    expect(() => makeLedger()).toThrow(LedgerError);
  });

  it('writes plan, meta and both append-only files before the first attempt', () => {
    makeLedger();
    for (const name of ['plan.json', 'meta.json', 'results.jsonl', 'events.jsonl']) {
      expect(fs.existsSync(path.join(root, name)), name).toBe(true);
    }
  });
});

describe('exactly one terminal result per slot, ever', () => {
  it('refuses a second terminal result for the same slot', () => {
    const ledger = makeLedger();
    const key = vectors.slotKeys[0];
    ledger.appendResult({ slotKey: key, status: 'pass' });
    expect(() => ledger.appendResult({ slotKey: key, status: 'fail' })).toThrow(/already has a terminal result/);
  });

  it('refuses a status it cannot name', () => {
    const ledger = makeLedger();
    expect(() => ledger.appendResult({ slotKey: vectors.slotKeys[0], status: 'mostlyFine' })).toThrow(/not a terminal status/);
  });

  it('refuses a slot that is not in the plan', () => {
    const ledger = makeLedger();
    expect(() => ledger.appendResult({ slotKey: 'not|in|1|plan', status: 'pass' })).toThrow(/not in the plan/);
  });
});

describe('resume', () => {
  it('returns the pending slots in plan order and never re-offers a terminal one', () => {
    const ledger = makeLedger();
    for (const key of vectors.slotKeys.slice(0, 3)) ledger.appendResult({ slotKey: key, status: 'pass' });
    const reopened = Ledger.open(root, clock);
    expect(reopened.pending().map((slot) => slot.slotKey)).toEqual(vectors.slotKeys.slice(3));
    expect(reopened.results.size).toBe(3);
  });

  it('resumes across a process boundary with the log, not the checkpoint, as truth', () => {
    const ledger = makeLedger();
    ledger.appendResult({ slotKey: vectors.slotKeys[0], status: 'pass' });
    ledger.writeCheckpoint();
    // A second attempt lands, then the process dies before the checkpoint is rewritten.
    ledger.appendResult({ slotKey: vectors.slotKeys[1], status: 'fail' });

    const reopened = Ledger.open(root, clock);
    expect(reopened.results.size).toBe(2);
    const drift = reopened.anomalies.find((a) => a.kind === 'checkpointDrift');
    expect(drift).toBeDefined();
    expect(drift?.checkpointSaid).toBe(1);
    expect(drift?.logSays).toBe(2);
  });

  it('reports checkpoint drift rather than silently correcting it', () => {
    const ledger = makeLedger();
    ledger.appendResult({ slotKey: vectors.slotKeys[0], status: 'pass' });
    fs.writeFileSync(path.join(root, 'checkpoint.json'), JSON.stringify({ terminalCount: 99 }), 'utf8');
    const reopened = Ledger.open(root, clock);
    expect(reopened.anomalies.map((a) => a.kind)).toContain('checkpointDrift');
    expect(reopened.results.size).toBe(1);
  });

  it('notes an unreadable checkpoint instead of throwing', () => {
    const ledger = makeLedger();
    ledger.appendResult({ slotKey: vectors.slotKeys[0], status: 'pass' });
    fs.writeFileSync(path.join(root, 'checkpoint.json'), '{not json', 'utf8');
    expect(Ledger.open(root, clock).anomalies.map((a) => a.kind)).toContain('unreadableCheckpoint');
  });
});

describe('crash recovery', () => {
  it('truncates a torn final line and re-offers that slot', () => {
    const ledger = makeLedger();
    ledger.appendResult({ slotKey: vectors.slotKeys[0], status: 'pass' });
    // The interruption landed mid-write: a partial line with no newline.
    fs.appendFileSync(path.join(root, 'results.jsonl'), '{"slotKey":"' + vectors.slotKeys[1] + '","stat');

    const reopened = Ledger.open(root, clock);
    expect(reopened.results.size).toBe(1);
    expect(reopened.anomalies.map((a) => a.kind)).toContain('repairedTornWrite');
    expect(reopened.pending()[0].slotKey).toBe(vectors.slotKeys[1]);
    // The file is repaired on disk, so the next append lands on a clean boundary.
    reopened.appendResult({ slotKey: vectors.slotKeys[1], status: 'pass' });
    expect(Ledger.open(root, clock).results.size).toBe(2);
  });

  it('refuses to guess when a corrupt line is not the last one', () => {
    const ledger = makeLedger();
    ledger.appendResult({ slotKey: vectors.slotKeys[0], status: 'pass' });
    ledger.appendResult({ slotKey: vectors.slotKeys[1], status: 'pass' });
    const file = path.join(root, 'results.jsonl');
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines[0] = '{corrupt';
    fs.writeFileSync(file, lines.join('\n'), 'utf8');
    expect(() => Ledger.open(root, clock)).toThrow(/is not the last line; refusing to guess/);
  });

  it('keeps the first record for a slot and records the duplicate as an anomaly', () => {
    const ledger = makeLedger();
    ledger.appendResult({ slotKey: vectors.slotKeys[0], status: 'pass' });
    fs.appendFileSync(path.join(root, 'results.jsonl'),
      JSON.stringify({ slotKey: vectors.slotKeys[0], status: 'fail', seq: 1, recordedAt: 'x' }) + '\n');
    const reopened = Ledger.open(root, clock);
    expect(reopened.results.get(vectors.slotKeys[0])?.status).toBe('pass');
    const anomaly = reopened.anomalies.find((a) => a.kind === 'duplicateTerminalResult');
    expect(anomaly).toMatchObject({ kept: 'pass', discarded: 'fail' });
  });

  it('records a result for a slot the plan does not contain as an anomaly, not a crash', () => {
    makeLedger();
    fs.appendFileSync(path.join(root, 'results.jsonl'),
      JSON.stringify({ slotKey: 'ghost|slot|1|x', status: 'pass', seq: 0, recordedAt: 'x' }) + '\n');
    const reopened = Ledger.open(root, clock);
    expect(reopened.anomalies.map((a) => a.kind)).toContain('unknownSlot');
    expect(reopened.results.size).toBe(0);
  });
});

describe('abort', () => {
  it('blocks slots, then supersedes the abort on resume without deleting it', () => {
    const ledger = makeLedger();
    const blocked = vectors.slotKeys.slice(4);
    ledger.recordAbort('free space below floor', { freeGiB: 12, floorGiB: 15 }, 'preAttempt', blocked);
    expect(ledger.standingAbort()?.blockedSlotCount).toBe(blocked.length);

    ledger.clearAbort('the operator freed 40 GiB and resumed');
    expect(ledger.standingAbort()).toBeUndefined();
    const past = ledger.pastAborts();
    expect(past).toHaveLength(1);
    expect(past[0].supersededBecause).toBe('the operator freed 40 GiB and resumed');
    expect(past[0].blockedSlotKeys).toEqual([...blocked].sort());
  });

  it('records the abort in the event trace', () => {
    const ledger = makeLedger();
    ledger.recordAbort('residency', { resident: 1 }, 'candidateTransition', []);
    expect(ledger.events().map((e) => e.kind)).toContain('abort');
  });
});

describe('reconciliation', () => {
  it('balances when every slot is terminal or blocked, exactly once', () => {
    const ledger = makeLedger();
    for (const key of vectors.slotKeys.slice(0, 10)) ledger.appendResult({ slotKey: key, status: 'pass' });
    ledger.recordAbort('stopped', {}, 'preAttempt', vectors.slotKeys.slice(10));
    const reconciliation = Ledger.open(root, clock).reconcile();
    expect(reconciliation.terminal).toBe(10);
    expect(reconciliation.blocked).toBe(vectors.slotKeys.length - 10);
    expect(reconciliation.unaccounted).toBe(0);
    expect(reconciliation.balances).toBe(true);
    expect(reconciliation.complete).toBe(false);
  });

  it("counts an interrupted campaign's untouched slots as unaccounted, and still balances", () => {
    const ledger = makeLedger();
    for (const key of vectors.slotKeys.slice(0, 3)) ledger.appendResult({ slotKey: key, status: 'pass' });
    const reconciliation = ledger.reconcile();
    expect(reconciliation.unaccounted).toBe(vectors.slotKeys.length - 3);
    expect(reconciliation.balances).toBe(true);
  });

  it('refuses to balance when a slot is both terminal and blocked', () => {
    const ledger = makeLedger();
    ledger.appendResult({ slotKey: vectors.slotKeys[0], status: 'pass' });
    ledger.recordAbort('overlap', {}, 'preAttempt', [vectors.slotKeys[0]]);
    const reconciliation = ledger.reconcile();
    expect(reconciliation.overlapBlockedAndTerminal).toBe(1);
    expect(reconciliation.balances).toBe(false);
  });

  it('reports it complete only when every slot is terminal', () => {
    const ledger = makeLedger();
    for (const key of vectors.slotKeys) ledger.appendResult({ slotKey: key, status: 'pass' });
    const reconciliation = ledger.reconcile();
    expect(reconciliation.complete).toBe(true);
    expect(reconciliation.byStatus).toEqual({ pass: vectors.slotKeys.length });
  });
});

describe('checkpoint', () => {
  it('summarises progress and names the candidates that are wholly finished', () => {
    const ledger = makeLedger();
    const first = vectors.candidates[0].name;
    for (const slot of ledger.plan.filter((s) => s.candidate === first)) ledger.appendResult({ slotKey: slot.slotKey, status: 'pass' });
    const checkpoint = ledger.writeCheckpoint({ note: 'paused by the operator' });
    expect(checkpoint.candidatesComplete).toEqual([first]);
    expect(checkpoint.remaining).toBe(vectors.slotKeys.length - checkpoint.terminalCount);
    expect(checkpoint.note).toBe('paused by the operator');
    expect(ledger.readCheckpoint()?.terminalCount).toBe(checkpoint.terminalCount);
  });
});
