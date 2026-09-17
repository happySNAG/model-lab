// Cernum · REQ-03 Phase 5 — the narrowing itself, tested away from the corpus.
//
// The adoption gate proves what the narrowing does to 350 real rows. This file proves the rule is
// what it claims to be: case-scoped, explicit, and inert everywhere it was not ruled.

import { describe, expect, it } from 'vitest';
import {
  narrowedRepairStatus, isNarrowedCase, narrowingFor, NARROWED_CASES, NARROWING_ID,
  PROTECTED_ROWS, CONCEDED_ROWS, CAPABILITY_SCORING_POLICY_ADOPTION,
} from '../../src/core/capability-repair-narrowing';
import { CAPABILITY_SPEC_BY_CASE } from '../../src/core/capability-repair-spec';

const NARROWED = 'case:emotional-understanding:non-diagnostic';
const ALSO_NARROWED = 'case:conversation:no-invented-continuity';
const UNTOUCHED = 'case:planning:ordered-steps';

describe('REQ-03 Phase 5 · the narrowing is case-scoped', () => {
  it('names exactly the two cases the ruling covers', () => {
    expect(NARROWED_CASES.map((n) => n.caseID).sort()).toEqual([ALSO_NARROWED, NARROWED].sort());
    expect(isNarrowedCase(NARROWED)).toBe(true);
    expect(isNarrowedCase(ALSO_NARROWED)).toBe(true);
    expect(isNarrowedCase(UNTOUCHED)).toBe(false);
  });

  it('returns version 1 inside a narrowed case, for every status version 2 could reach', () => {
    for (const [v1, v2] of [['partial', 'pass'], ['fail', 'pass'], ['pass', 'pass'], ['fail', 'partial']] as const) {
      const r = narrowedRepairStatus(NARROWED, v1, v2);
      expect(r.status).toBe(v1);
      expect(r.narrowed).toBe(true);
      expect(r.why).toContain(NARROWING_ID);
    }
  });

  it('returns version 2 untouched outside a narrowed case — the repair still stands everywhere else', () => {
    for (const [v1, v2] of [['partial', 'pass'], ['fail', 'pass'], ['fail', 'partial']] as const) {
      const r = narrowedRepairStatus(UNTOUCHED, v1, v2);
      expect(r.status).toBe(v2);
      expect(r.narrowed).toBe(false);
    }
  });

  it('cannot be more lenient than version 1 in a narrowed case', () => {
    // The whole point: no row in a narrowed case may reach `pass` that version 1 withheld.
    for (const caseID of [NARROWED, ALSO_NARROWED]) {
      expect(narrowedRepairStatus(caseID, 'partial', 'pass').status).not.toBe('pass');
      expect(narrowedRepairStatus(caseID, 'fail', 'pass').status).not.toBe('pass');
    }
  });
});

describe('REQ-03 Phase 5 · the narrowing states its own cost', () => {
  it('protects seven rows and concedes twelve, named individually', () => {
    expect(PROTECTED_ROWS.length).toBe(7);
    expect(CONCEDED_ROWS.length).toBe(12);
    expect(new Set([...PROTECTED_ROWS, ...CONCEDED_ROWS]).size).toBe(19);
  });

  it('records, per case, why no finer separator was available', () => {
    for (const n of NARROWED_CASES) {
      expect(n.whyNotFiner.length).toBeGreaterThan(40);
      expect(n.mechanismWithdrawn.length).toBeGreaterThan(10);
      expect(n.protectsRows.length).toBeGreaterThan(0);
    }
    expect(narrowingFor(NARROWED)!.concedesRows.length).toBe(3);
    expect(narrowingFor(ALSO_NARROWED)!.concedesRows.length).toBe(9);
  });

  it('leaves the Phase 4 repair spec intact, so Phase 4 stays reproducible', () => {
    // The narrowing withdraws the repair at evaluation time. It does not delete the spec entries,
    // because Phase 4's published measurement must keep reproducing byte for byte.
    for (const n of NARROWED_CASES) expect(CAPABILITY_SPEC_BY_CASE.has(n.caseID)).toBe(true);
  });
});

describe('REQ-03 Phase 5 · adoption is prospective and unrouted', () => {
  it('adopts version 2 without rescoring history or touching the live path', () => {
    expect(CAPABILITY_SCORING_POLICY_ADOPTION.adoptedVersion).toBe('2');
    expect(CAPABILITY_SCORING_POLICY_ADOPTION.narrowingID).toBe(NARROWING_ID);
    expect(CAPABILITY_SCORING_POLICY_ADOPTION.prospectiveOnly).toBe(true);
    expect(CAPABILITY_SCORING_POLICY_ADOPTION.historicalRowsRescored).toBe(false);
    expect(CAPABILITY_SCORING_POLICY_ADOPTION.wiredIntoLiveEvaluationPath).toBe(false);
    expect(CAPABILITY_SCORING_POLICY_ADOPTION.wiringRequiresSeparateApproval).toBe(true);
  });
});
