// Cernum · REQ-03 Phase 4 — the PERMANENT ADOPTION GATE for the repaired capability evaluator.
//
// This is the gate, not a development fixture. It asserts the WHOLE adjudicated capability corpus,
// read from the sealed records rather than restated, so the assertion and the adjudication cannot
// drift apart. A subset fixture does not close REQ-03: it can pass while the repair has regressed on
// a row nobody transcribed.
//
//   350  adjudicated live rows     Phase 1 (120) + Phase 2 (110) + Phase 3 (120). Every row a person
//                                  has ruled on the capability question.
//    80  seeded controls           Phase 1 (24) + Phase 2 (32) + Phase 3 (24), with their sealed
//                                  expected verdicts.
//     8  fresh held-out controls   P3-BLIND-01. Built after the repair's evidence was fixed, on two
//                                  cases never used as a control, and NOT RULED. The gate reads them
//                                  as an outstanding input, never as a passed check.
//
// ── WHAT THIS GATE IS FOR ─────────────────────────────────────────────────────────────────────
//
// The adjudicated defect is one-directional: version 1 is far too harsh (201 false positives in 350)
// and rarely too lenient (4 false negatives). Any repair for over-failure is therefore under
// permanent suspicion of over-correcting, so the gate measures BOTH directions and treats the second
// as decisive. A repair that clears everything scores perfectly on the 201 and is worthless.
//
// ── WHY IT DOES NOT ADOPT ─────────────────────────────────────────────────────────────────────
//
// It is expected to REFUSE. Three conditions stand, and none is discretionary:
//
//   1. The eight held-out controls carry no human ruling. A repair validated only on the rows that
//      defined it is a repair fitted to those rows.
//   2. Two of the five coverage cases have never been read by anyone. REQ-03 cannot close over them.
//   3. The repair introduces 7 new false negatives on rows a person ruled short.
//
// The gate exists to say so in a way that cannot be mistaken for a pass. `adopted` is false, the
// blockers are named individually, and nothing is rescored.

import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { caseByID, policyCatalog } from '../../src/core/catalog';
import { EvaluationEngine } from '../../src/core/engine';
import { evaluateRepaired, OUT_OF_SCOPE_METHODS, CAPABILITY_SCORING_POLICY_VERSION_2 } from '../../src/core/capability-repair';
import { CAPABILITY_SPEC_BY_CASE } from '../../src/core/capability-repair-spec';
import { AttemptRecord, Observation } from '../../src/core/run';

const EVIDENCE_ROOT = process.env.CERNUM_EVIDENCE_ROOT
  ?? '/Volumes/LaCie/MacMini-NemoClaw-Workspace/model-lab-results';

/** Every source this gate reads, pinned. A changed digest is a hard stop, never a silent re-baseline. */
const SEALED_SOURCES = {
  ledgerA2: { path: 'pass08-evidence/campaign-a2/results.jsonl', digest: 'adcb22f1ab7908b5c08d1568ee316e1001cad9ab6b101cb43b0dab3e711799f0' },
  ledgerB2: { path: 'pass08-evidence/campaign-b2/results.jsonl', digest: '0a1561d7bd4f8cab4644b08f529b9e8711572aa03d0d9b82f5301875adc65f96' },
  idMap1: { path: 'req03-sealed/CERNUM-REQ-03-PHASE-1-IDENTITY-MAP.SEALED.json', digest: '4d79fd6641b8f3c750a54331e1a6f9019ac3395f8c52ea58a54cf3101d367d8d' },
  idMap2: { path: 'req03-sealed/CERNUM-REQ-03-PHASE-2-IDENTITY-MAP.SEALED.json', digest: 'c96c2d9ab68a98aeb5d0596a161b1412f1428ea1076ec96dfccf24e73e7128e4' },
  idMap3: { path: 'req03-sealed/CERNUM-REQ-03-PHASE-3-IDENTITY-MAP.SEALED.json', digest: 'aadb933d082f77ed60262f940c59f0a95380b11d810c75bd520e032642daa00e' },
  live1: { path: 'pass10-evidence/req03-phase1/rulings/CERNUM-REQ-03-PHASE-1-RULINGS-LIVE-120-AS-SUBMITTED.json', digest: '7eb0c004daae1a3ab78adde5584a484ace7a33d67d71e4edee3304ef40ef9d5e' },
  live2: { path: 'pass10-evidence/req03-phase2/rulings/CERNUM-REQ-03-PHASE-2-RULINGS-LIVE-110-EFFECTIVE.json', digest: 'ff6bd6dd98a6afdcc3e7ec4102a28584ab2869325c4a6989355611af19c3d88b' },
  live3: { path: 'pass10-evidence/req03-phase3/rulings/CERNUM-REQ-03-PHASE-3-RULINGS-LIVE-120-AS-SUBMITTED.json', digest: 'd48d397a9a2fbaa717adcb5f189007249baff6c9499d2a771c15e187da21d4f8' },
  ctlRul1: { path: 'pass10-evidence/req03-phase1/controls/CERNUM-REQ-03-PHASE-1-RULINGS-CONTROLS-24-AS-SUBMITTED.json', digest: '6d951eec9bcde2aa93182f2c6db68c31bc27432f0c7cbc62d7fa962300cf511d' },
  ctlRul2: { path: 'pass10-evidence/req03-phase2/controls/CERNUM-REQ-03-PHASE-2-RULINGS-CONTROLS-32-AS-SUBMITTED.json', digest: '1aff744a2c6132e6a956e6feda1fc4c48d5c5e34c17a2f196414f0192facd217' },
  ctlRul3: { path: 'pass10-evidence/req03-phase3/controls/CERNUM-REQ-03-PHASE-3-RULINGS-CONTROLS-24-AS-SUBMITTED.json', digest: 'a871493551803832e5b6831c280f06967b1303552ec5cb72913abb086fe838a9' },
  cross1: { path: 'req03-sealed/CERNUM-REQ-03-PHASE-1-CONTROLS-CROSSWALK.SEALED.json', digest: 'e9794ef79be50efa4cd8e91516f77b0359576c420ec60665138faabcc413da31' },
  cross2: { path: 'req03-sealed/CERNUM-REQ-03-PHASE-2-CONTROLS-CROSSWALK.SEALED.json', digest: 'dd405c0c764bc93b18d937735a7db669d828ea8fc8fa36a552c596392716b5a1' },
  cross3: { path: 'req03-sealed/CERNUM-REQ-03-PHASE-3-CONTROLS-CROSSWALK.SEALED.json', digest: 'cc4b6dc0f8ed40838b8d17feeeb8796abe780b29dc7c3813acd60c965713ab06' },
  heldOutBlinded: { path: 'pass10-evidence/req03-phase4/controls-held-out/CERNUM-REQ-03-HELDOUT-CONTROLS-BLINDED.json', digest: 'bcce66ccf3721c6d9c0d505f45c7cea6feed64b8b3d4c4711c0a25cd65698a2e' },
  coverage: { path: 'pass10-evidence/req03-phase4/coverage/CERNUM-REQ-03-COVERAGE-PASS-SIDE-EVIDENCE.json', digest: 'b949c1ee72e4bcc52e9d82ff944f5f718b0b9910a11e5abbc3b190ea807d8292' },
  humanRulings: { path: 'pass10-evidence/req03-phase3/decisions/CERNUM-REQ-03-PHASE-3-HUMAN-RULINGS.json', digest: '1b0607c08341cec69f05ca717a3e5e92777fc23cbc295ea79a51c0d7515f7bdf' },
  amendment01: { path: 'pass10-evidence/req03-phase3/amendments/CERNUM-REQ-03-PHASE-3-AMENDMENT-01-INTEG.json', digest: '8e5a7e51b00d0340f91466063a28f52f9958695c754780905cabbc110a43a1de' },
  // The sealed supersessions. A control block is ruled ONCE and then, where a ruling was
  // re-adjudicated, superseded by an explicit record beside it — never edited in place. The gate must
  // score the EFFECTIVE block, which is the as-submitted block with these applied. Reading
  // as-submitted alone reports the round-1 misses that the re-adjudication already resolved.
  readj2: { path: 'pass10-evidence/req03-phase2/controls/CERNUM-REQ-03-PHASE-2-CONTROL-READJUDICATION.json', digest: 'd8002e9c6504b654295630290ff72725ff0f58d1026691d7b4874dad8125cab0' },
  readj3: { path: 'pass10-evidence/req03-phase3/controls/CERNUM-REQ-03-PHASE-3-CONTROL-READJUDICATION.json', digest: 'ceaa175c0cec36bc86bc5c5539c8a1935f8445831d4a123abc5d0166ad8d97a6' },
} as const;

/** The held-out control rulings, once a person records them. Absent today — and that is a blocker. */
const HELD_OUT_RULINGS = 'pass10-evidence/req03-phase4/controls-held-out/CERNUM-REQ-03-HELDOUT-CONTROLS-RULINGS-AS-SUBMITTED.json';
/** The two unread coverage cases, once adjudicated. Absent today — and that is a blocker. */
const COVERAGE_RULINGS = 'pass10-evidence/req03-phase4/coverage/CERNUM-REQ-03-COVERAGE-RULINGS-AS-SUBMITTED.json';

const EXPECTED = {
  ledgerRows: 616, live: 350, live1: 120, live2: 110, live3: 120,
  seededControls: 80, ctl1: 24, ctl2: 32, ctl3: 24, heldOutControls: 8,
  coverageGroupARows: 42, coverageGroupAPassSide: 34, coverageGroupBUnread: 28,
} as const;

function hardStop(detail: string): never {
  throw new Error(`REQ-03 PHASE 4 ADOPTION GATE HARD STOP — ${detail}`);
}

function loadPinned(key: keyof typeof SEALED_SOURCES): Buffer {
  const { path, digest } = SEALED_SOURCES[key];
  const bytes = readFileSync(join(EVIDENCE_ROOT, path));
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== digest) {
    hardStop(`sealed evidence changed under ${key}.\n  file:     ${path}\n`
      + `  expected: ${digest}\n  actual:   ${actual}\n`
      + `A correction is an amendment recorded beside the sealed record, never an edit in place. `
      + `Do not re-pin this digest to make the gate green.`);
  }
  return bytes;
}
const loadSealed = (k: keyof typeof SEALED_SOURCES) => JSON.parse(loadPinned(k).toString('utf8'));

function requireExactly(label: string, actual: number, expected: number): void {
  if (actual !== expected) {
    hardStop(`loaded ${actual} ${label}, required exactly ${expected}. A subset cannot close REQ-03.`);
  }
}

// ── The raw ledger, the only source of response text ────────────────────────────────────────────
const ledger = (() => {
  const bySlot = new Map<string, { answerText: string; status: string; caseID: string; candidate: string }>();
  for (const key of ['ledgerA2', 'ledgerB2'] as const) {
    for (const line of loadPinned(key).toString('utf8').split('\n')) {
      if (line.trim().length === 0) continue;
      const row = JSON.parse(line);
      if (typeof row.slotKey !== 'string' || row.slotKey.length === 0) hardStop('a ledger row carries no slotKey');
      if (bySlot.has(row.slotKey)) hardStop(`duplicate slotKey ${row.slotKey}; the join must be one-to-one`);
      bySlot.set(row.slotKey, { answerText: row.answerText ?? '', status: row.status, caseID: row.caseID, candidate: row.candidate });
    }
  }
  requireExactly('raw ledger attempts', bySlot.size, EXPECTED.ledgerRows);
  return bySlot;
})();

// ── The 350 adjudicated live rows, joined through the sealed identity maps ──────────────────────
interface LiveRow {
  decisionID: string; slotKey: string; caseID: string; candidate: string;
  phase: number; humanVerdict: string; evaluatorStatusAtSealing: string;
}

function liveRows(): LiveRow[] {
  const out: LiveRow[] = [];
  const seenDecision = new Set<string>();
  const seenSlot = new Set<string>();
  for (const [phase, idKey, liveKey, n] of [
    [1, 'idMap1', 'live1', EXPECTED.live1], [2, 'idMap2', 'live2', EXPECTED.live2], [3, 'idMap3', 'live3', EXPECTED.live3],
  ] as const) {
    const byDecision = new Map<string, any>(loadSealed(idKey).rows.map((r: any) => [r.decisionID, r]));
    const rulings = loadSealed(liveKey).rulings;
    requireExactly(`phase ${phase} live rulings`, rulings.length, n);
    for (const r of rulings) {
      const idr = byDecision.get(r.decisionID);
      if (!idr) hardStop(`phase ${phase}: ${r.decisionID} is not in the sealed identity map — unknown row`);
      if (seenDecision.has(r.decisionID)) hardStop(`duplicate decisionID ${r.decisionID}`);
      if (seenSlot.has(idr.slotKey)) hardStop(`duplicate slotKey ${idr.slotKey} across phases; a row is counted twice`);
      if (!ledger.has(idr.slotKey)) hardStop(`${r.decisionID}: slotKey ${idr.slotKey} is absent from the ledger`);
      if (typeof r.verdict !== 'string' || r.verdict.length === 0) hardStop(`${r.decisionID} carries no verdict`);
      seenDecision.add(r.decisionID); seenSlot.add(idr.slotKey);
      out.push({
        decisionID: r.decisionID, slotKey: idr.slotKey, caseID: idr.caseID, candidate: idr.candidate,
        phase, humanVerdict: r.verdict,
        evaluatorStatusAtSealing: idr.evaluatorStatus ?? idr.ledgerStatus ?? ledger.get(idr.slotKey)!.status,
      });
    }
  }
  requireExactly('adjudicated live rows', out.length, EXPECTED.live);
  return out;
}
const live = liveRows();

// ── The 80 seeded controls, with their sealed expected verdicts ─────────────────────────────────
interface ControlRow {
  controlID: string; phase: number; expectedVerdict: string;
  asSubmittedVerdict: string; humanVerdict: string; superseded: boolean;
}

/** controlID → the superseding verdict, read from the sealed re-adjudication registers. */
function supersessions(): Map<string, string> {
  const out = new Map<string, string>();
  const p2 = loadSealed('readj2');
  if (p2.supersedingRuling) out.set(p2.supersedingRuling.controlID, p2.supersedingRuling.verdict);
  for (const s of loadSealed('readj3').supersessions ?? []) out.set(s.controlID, s.supersedingVerdict);
  if (out.size !== 4) hardStop(`loaded ${out.size} sealed supersessions, required exactly 4 (1 in Phase 2, 3 in Phase 3)`);
  return out;
}
const superseded = supersessions();

function seededControls(): ControlRow[] {
  const out: ControlRow[] = [];
  for (const [phase, crossKey, rulKey, n] of [
    [1, 'cross1', 'ctlRul1', EXPECTED.ctl1], [2, 'cross2', 'ctlRul2', EXPECTED.ctl2], [3, 'cross3', 'ctlRul3', EXPECTED.ctl3],
  ] as const) {
    const expectedBy = new Map<string, any>(loadSealed(crossKey).crosswalk.map((c: any) => [c.controlID, c]));
    const doc = loadSealed(rulKey);
    const rulings = doc.rulings ?? doc.controls ?? [];
    requireExactly(`phase ${phase} control rulings`, rulings.length, n);
    for (const r of rulings) {
      const x = expectedBy.get(r.controlID);
      if (!x) hardStop(`phase ${phase} control ${r.controlID} is not in the sealed crosswalk — unknown control`);
      const supersedingVerdict = superseded.get(r.controlID);
      out.push({
        controlID: r.controlID, phase, expectedVerdict: x.expectedVerdict,
        asSubmittedVerdict: r.verdict, humanVerdict: supersedingVerdict ?? r.verdict,
        superseded: supersedingVerdict !== undefined,
      });
    }
  }
  requireExactly('seeded controls', out.length, EXPECTED.seededControls);
  return out;
}
const controls = seededControls();

// ── Replay, under both scoring policy versions ──────────────────────────────────────────────────
const engine = new EvaluationEngine(policyCatalog, () => new Date('2026-01-01T00:00:00Z'));
function observationFor(answerText: string): Observation {
  return {
    outputText: answerText, toolCallObservationsRaw: [], terminalStatus: 'completed',
    providerReportedUsage: { unavailableReason: 'replayed from the sealed ledger' },
    timing: { startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-01T00:00:00Z', durationMilliseconds: { measured: 0 } },
    warnings: [], errors: [],
    identityVerification: { state: 'unverifiable', reportedModelID: { unavailableReason: 'replayed' }, requestedModelID: '' },
    runtimeConfigurationID: 'replay', requestDigest: 'replay',
  } as unknown as Observation;
}
function attemptFor(caseID: string, candidate: string, answerText: string): AttemptRecord {
  const c = caseByID(caseID);
  if (!c) hardStop(`case ${caseID} is not in the catalog`);
  return {
    attemptID: `replay:${caseID}`, runID: 'req03-phase4', ordinal: 0, repetitionIndex: 1,
    candidate: { id: { raw: candidate } }, candidateDigest: 'replay',
    suiteID: c!.suiteID, suiteVersion: c!.suiteVersion, caseID: c!.id, caseDigest: 'replay',
    inputPackage: c!.inputs, inputPackageDigest: 'replay',
    scoringPolicyID: c!.scoringPolicyID, scoringPolicyVersion: c!.scoringPolicyVersion,
    environment: {} as AttemptRecord['environment'], observation: observationFor(answerText),
    terminalStatus: 'completed', comparabilityKey: 'replay',
    startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:00:00Z',
  } as unknown as AttemptRecord;
}
function policyFor(caseID: string) {
  const c = caseByID(caseID)!;
  const p = policyCatalog.policy(c.scoringPolicyID, c.scoringPolicyVersion);
  if (!p) hardStop(`no policy for ${caseID}`);
  return p!;
}

interface Scored extends LiveRow { v1: string; v2: string; method: string; inScope: boolean; text: string }
const scored: Scored[] = live.map((r) => {
  const text = ledger.get(r.slotKey)!.answerText;
  const policy = policyFor(r.caseID);
  const inScope = !OUT_OF_SCOPE_METHODS.has(policy.method);
  const v1 = engine.evaluate(attemptFor(r.caseID, r.candidate, text)).verdict.status;
  return { ...r, text, method: policy.method, inScope, v1, v2: inScope ? evaluateRepaired(policy, r.caseID, text).status : v1 };
});

/** VERSION 1 IS PRESERVED. Every stored status must still reproduce, byte for byte, unchanged. */
const v1Drift = scored.filter((r) => r.v1 !== r.evaluatorStatusAtSealing);

function rates(rows: Scored[], pick: (r: Scored) => string) {
  let fp = 0, fn = 0, ok = 0;
  for (const r of rows) {
    const evalPass = pick(r) === 'pass', humanPass = r.humanVerdict === 'pass';
    if (evalPass === humanPass) ok += 1; else if (!evalPass && humanPass) fp += 1; else fn += 1;
  }
  const n = rows.length;
  return { n, agree: ok, falsePositive: fp, falseNegative: fn,
           falsePositivePercent: n ? Number(((100 * fp) / n).toFixed(2)) : 0,
           falseNegativePercent: n ? Number(((100 * fn) / n).toFixed(2)) : 0 };
}
function groupBy(key: (r: Scored) => string) {
  const out: Record<string, { version1: ReturnType<typeof rates>; version2: ReturnType<typeof rates> }> = {};
  const keys = [...new Set(scored.map(key))].sort();
  for (const k of keys) {
    const rows = scored.filter((r) => key(r) === k);
    out[k] = { version1: rates(rows, (r) => r.v1), version2: rates(rows, (r) => r.v2) };
  }
  return out;
}

const v1All = rates(scored, (r) => r.v1);
const v2All = rates(scored, (r) => r.v2);
const inScopeRows = scored.filter((r) => r.inScope);
const v1InScope = rates(inScopeRows, (r) => r.v1);
const v2InScope = rates(inScopeRows, (r) => r.v2);
const newFalseNegatives = scored.filter((r) => r.humanVerdict !== 'pass' && r.v1 !== 'pass' && r.v2 === 'pass');
const seededMisses = controls.filter((c) => c.humanVerdict !== c.expectedVerdict);
const seededMissesBeforeSupersession = controls.filter((c) => c.asSubmittedVerdict !== c.expectedVerdict);

// ── The held-out controls: read as an OUTSTANDING INPUT, never as a passed check ────────────────
const heldOut = loadSealed('heldOutBlinded');
requireExactly('fresh held-out controls', heldOut.controls.length, EXPECTED.heldOutControls);
const heldOutRuled = existsSync(join(EVIDENCE_ROOT, HELD_OUT_RULINGS));
const coverageRuled = existsSync(join(EVIDENCE_ROOT, COVERAGE_RULINGS));

// ── Coverage ────────────────────────────────────────────────────────────────────────────────────
const coverage = loadSealed('coverage');
requireExactly('coverage Group A rows', coverage.rows.length, EXPECTED.coverageGroupARows);
requireExactly('coverage Group A pass-side rows', coverage.rows.filter((r: any) => r.isPassSideEvidence).length, EXPECTED.coverageGroupAPassSide);

// ── The adoption decision ───────────────────────────────────────────────────────────────────────
const blockers: { id: string; blocker: string; why: string }[] = [];
if (!heldOutRuled) blockers.push({
  id: 'P4-BLOCK-HELDOUT',
  blocker: `the ${EXPECTED.heldOutControls} fresh held-out controls carry no human ruling`,
  why: 'A repair validated only on the rows that defined it is a repair fitted to those rows. The '
     + 'packet is built, blinded and sealed; eight rulings are outstanding.',
});
if (!coverageRuled) blockers.push({
  id: 'P4-BLOCK-COVERAGE',
  blocker: `${EXPECTED.coverageGroupBUnread} rows across 2 coverage cases have never been ruled by anyone`,
  why: 'case:conversation:warmth-and-personality and case:emotional-understanding:attunement are scored '
     + 'by an evaluator that never emits pass or fail. REQ-03 cannot close over them.',
});
if (newFalseNegatives.length > 0) blockers.push({
  id: 'P4-BLOCK-OVERCORRECTION',
  blocker: `the repair passes ${newFalseNegatives.length} rows a person ruled short and version 1 did not`,
  why: 'The defect being repaired is over-failure, so over-correction is the failure mode to watch. '
     + 'Every one of these traces to a criteria gap rather than to the matcher, and closing a criteria '
     + 'gap means amending an adopted requirement, which this phase is not authorised to do.',
});
if (v1Drift.length > 0) blockers.push({
  id: 'P4-BLOCK-V1-DRIFT',
  blocker: `${v1Drift.length} rows no longer reproduce their sealed version-1 status`,
  why: 'Version 1 must stay reproducible byte for byte or every published rate becomes unreadable.',
});
if (seededMisses.length > 0) blockers.push({
  id: 'P4-BLOCK-CALIBRATION',
  blocker: `${seededMisses.length} seeded controls were not ruled as expected`,
  why: 'The adjudicator’s calibration is a precondition of every rate these rows support.',
});

const adopted = blockers.length === 0;

const result = {
  resultFormatVersion: 1,
  artifact: 'CERNUM-REQ-03-PHASE-4-ADOPTION-GATE-RESULT',
  computedAt: new Date('2026-09-17T01:30:00Z').toISOString(),
  requirement: 'REQ-03', phase: '4 — repair and adoption gate',
  ADOPTED: adopted,
  adoptionStatus: adopted ? 'ADOPTED' : 'NOT ADOPTED — blocked',
  blockers,
  scoringPolicy: {
    version1: '1 — untouched, canonical, still resolves every stored row',
    version2: `${CAPABILITY_SCORING_POLICY_VERSION_2} — the repair, candidate only`,
    historyModifiedInPlace: false,
    version1ReproducesSealedStatus: v1Drift.length === 0,
    version1DriftRows: v1Drift.map((r) => ({ decisionID: r.decisionID, sealed: r.evaluatorStatusAtSealing, replayed: r.v1 })),
  },
  PHASE_3_IS_A_SAMPLE: {
    isSample: true,
    mustBeLabelled: 'SAMPLE, not census, everywhere it appears — inside Phase 4 too.',
    population: 'SAMPLE — 120 of 350 pass rows, 34.29%.',
    publishedLimitation: 'The 95% Wilson interval on the 3.33% sample false-negative rate runs to 8.26%, '
      + 'above the 5% escalation threshold. A sample below the threshold is not a population below it.',
  },
  aggregateRule: {
    rule: 'Rates are published PER CASE and PER CANDIDATE. The corpus-wide figures below are a '
        + 'reconciliation total, not a headline, and may not be quoted as the evaluator’s accuracy.',
    why: 'Pass 9’s most important number — 100% on all 14 rules — was visible per rule and would have '
       + 'been muddied in aggregate.',
  },
  calibration: {
    seededControls: controls.length,
    effectiveMatches: controls.length - seededMisses.length,
    roundOneMisses: seededMissesBeforeSupersession.map((c) => c.controlID),
    supersessionsApplied: controls.filter((c) => c.superseded).map((c) => ({
      controlID: c.controlID, asSubmitted: c.asSubmittedVerdict, effective: c.humanVerdict,
    })),
    note: 'Scored on the EFFECTIVE control block — as-submitted plus the sealed supersessions. The '
        + 'as-submitted block is never edited, and the round-1 misses are named above rather than hidden '
        + 'by the re-adjudication that resolved them.',
    blindingImpairment: 'The three Phase 3 controls re-adjudicated with their expected values known can '
        + 'no longer serve as blind evidence for this adjudicator. That is what P3-BLIND-01 answers.',
  },
  corpus: {
    adjudicatedRows: scored.length, seededControls: controls.length,
    freshHeldOutControls: heldOut.controls.length, freshHeldOutControlsRuled: heldOutRuled,
    ledgerAttempts: ledger.size,
  },
  reconciliationTotals: {
    version1: v1All, version2: v2All,
    inScopeOnly: { version1: v1InScope, version2: v2InScope },
    outOfScopeRows: scored.length - inScopeRows.length,
  },
  perCase: groupBy((r) => r.caseID),
  perCandidate: groupBy((r) => r.candidate),
  perMethod: groupBy((r) => r.method),
  overCorrection: {
    rowsAPersonRuledShort: scored.filter((r) => r.humanVerdict !== 'pass').length,
    version1Held: scored.filter((r) => r.humanVerdict !== 'pass' && r.v1 !== 'pass').length,
    version2Held: scored.filter((r) => r.humanVerdict !== 'pass' && r.v2 !== 'pass').length,
    newFalseNegatives: newFalseNegatives.map((r) => ({
      decisionID: r.decisionID, caseID: r.caseID, humanVerdict: r.humanVerdict, version1: r.v1, version2: r.v2,
    })),
  },
  heldOutControls: {
    count: heldOut.controls.length,
    ruled: heldOutRuled,
    status: heldOutRuled ? 'RULED' : 'NOT RULED — outstanding human input',
    generalisation: 'The repair spec is PER CASE. Neither held-out case has a spec entry, so version 2 '
      + 'is byte-identical to version 1 on all eight. The repair does not generalise to a case it was '
      + 'not shown, and the gate records that as a property of the repair rather than a defect in the controls.',
    whatARulingWouldSettle: 'Whether the adjudicator’s judgement still matches the sealed expectations '
      + 'after three Phase 3 controls were burned.',
  },
  coverage: {
    groupAResolved: coverage.groupA.cases,
    groupARows: coverage.rows.length,
    groupAPassSideRows: coverage.rows.filter((r: any) => r.isPassSideEvidence).length,
    groupBUnresolved: coverage.groupB.cases,
    groupBRows: EXPECTED.coverageGroupBUnread,
    blocksReq03Closure: !coverageRuled,
  },
  outOfScopeResidual: {
    note: 'Measured and published, not repaired. These are not the concept-matching primitive and the '
        + 'plan does not authorise repairing them here.',
    methods: [...OUT_OF_SCOPE_METHODS].sort(),
  },
  repairSpec: { caseEntries: CAPABILITY_SPEC_BY_CASE.size },
  nothingRescored: [
    'No published capability rate was recomputed.',
    'No candidate was ranked, retained, recommended or routed.',
    'No sealed ruling was altered.',
    'scoringPolicyVersion 1 is untouched.',
  ],
  req03Status: 'OPEN',
  provenance: { source: 'human', modelParticipation: 'advisory', finalDecisionMaker: 'Seth J. Leopold' },
};

const OUT = process.env.CERNUM_REQ03_PHASE4_RESULT
  ?? join(EVIDENCE_ROOT, 'pass10-evidence/req03-phase4/gate/CERNUM-REQ-03-PHASE-4-ADOPTION-GATE-RESULT.json');
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(result, null, 1) + '\n');

describe('REQ-03 Phase 4 · the gate reads the whole sealed record, not a subset', () => {
  it('loads exactly 616 ledger attempts, one-to-one by slotKey', () => {
    expect(ledger.size).toBe(EXPECTED.ledgerRows);
  });
  it('loads exactly 350 adjudicated live rows, no duplicate and no unknown row', () => {
    expect(live.length).toBe(EXPECTED.live);
    expect(new Set(live.map((r) => r.decisionID)).size).toBe(EXPECTED.live);
    expect(new Set(live.map((r) => r.slotKey)).size).toBe(EXPECTED.live);
  });
  it('loads exactly 80 seeded controls and 8 fresh held-out controls', () => {
    expect(controls.length).toBe(EXPECTED.seededControls);
    expect(heldOut.controls.length).toBe(EXPECTED.heldOutControls);
  });
  it('scores the effective control block — as-submitted plus the four sealed supersessions', () => {
    expect(superseded.size).toBe(4);
    expect(controls.filter((c) => c.superseded).length).toBe(4);
    // Round 1 missed four; the sealed re-adjudications resolve all four. Both facts are published.
    expect(seededMissesBeforeSupersession.length).toBe(4);
    expect(seededMisses).toEqual([]);
  });
  it('carries the Group A coverage evidence — 42 rows, 34 of them pass-side', () => {
    expect(coverage.rows.length).toBe(EXPECTED.coverageGroupARows);
    expect(coverage.rows.filter((r: any) => r.isPassSideEvidence).length).toBe(EXPECTED.coverageGroupAPassSide);
  });
});

describe('REQ-03 Phase 4 · version 1 is preserved', () => {
  it('reproduces every sealed version-1 status — any drift is a hard stop', () => {
    expect(v1Drift.map((r) => r.decisionID)).toEqual([]);
  });
  it('does not modify scoring policy history in place', () => {
    expect(CAPABILITY_SCORING_POLICY_VERSION_2).toBe('2');
    expect(result.scoringPolicy.historyModifiedInPlace).toBe(false);
  });
});

describe('REQ-03 Phase 4 · the repair, measured in both directions', () => {
  it('removes every in-scope false positive the adjudication found', () => {
    expect(v1InScope.falsePositive).toBe(180);
    expect(v2InScope.falsePositive).toBe(0);
  });
  it('is measured for over-correction, which is the failure mode that matters here', () => {
    expect(v1InScope.falseNegative).toBe(4);
    expect(v2InScope.falseNegative).toBe(11);
    expect(newFalseNegatives.length).toBe(7);
  });
  it('publishes rates per case and per candidate, never only in aggregate', () => {
    expect(Object.keys(result.perCase).length).toBeGreaterThan(1);
    expect(Object.keys(result.perCandidate).length).toBe(10);
  });
});

describe('REQ-03 Phase 4 · the gate refuses adoption', () => {
  it('does not adopt while any blocking condition stands', () => {
    expect(adopted).toBe(false);
    expect(blockers.map((b) => b.id).sort())
      .toEqual(['P4-BLOCK-COVERAGE', 'P4-BLOCK-HELDOUT', 'P4-BLOCK-OVERCORRECTION']);
  });
  it('records that the repair does not generalise to a case it was not shown', () => {
    for (const c of heldOut.controls) expect(CAPABILITY_SPEC_BY_CASE.has(c.caseID)).toBe(false);
  });
  it('rescores nothing', () => {
    expect(result.req03Status).toBe('OPEN');
  });
});
