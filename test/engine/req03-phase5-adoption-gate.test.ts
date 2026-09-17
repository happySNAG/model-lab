// Cernum · REQ-03 Phase 5 — the PERMANENT ADOPTION GATE for the NARROWED capability repair.
//
// This is the gate, not a development fixture. It asserts the WHOLE adjudicated capability corpus and
// every applicable control, read from the sealed records rather than restated, so the assertion and
// the adjudication cannot drift apart. A subset fixture does not close REQ-03.
//
//   350  adjudicated live rows     Phase 1 (120) + Phase 2 (110) + Phase 3 (120).
//    80  seeded controls           Phase 1 (24) + Phase 2 (32) + Phase 3 (24), sealed expected verdicts.
//     8  fresh held-out controls   P3-BLIND-01. Built after the repair's evidence was fixed, on two
//                                  cases never used as a control — and now RULED, and scored against
//                                  the sealed crosswalk. Anything below 8/8 quarantines everything.
//    28  coverage rulings          P3-COVERAGE-01/02. A census of two cases whose evaluator never
//                                  emits pass or fail. They close a coverage gap; they are NOT rows
//                                  in any evaluator-accuracy rate, and are never pooled into one.
//
// ── WHAT CHANGED SINCE PHASE 4 ──────────────────────────────────────────────────────────────────
//
// Phase 4 refused adoption on three blockers. Each was answered by a person, not by this model:
//   P4-BLOCK-HELDOUT       — 8 rulings recorded, sealed, and calibrated 8/8 against the sealed crosswalk.
//   P4-BLOCK-COVERAGE      — 28 rulings recorded and sealed; both requirement statements adopted verbatim.
//   P4-BLOCK-OVERCORRECTION— ruled NARROW THE REPAIR. `capability-repair-narrowing.ts` withdraws the
//                            repair for the two affected cases, which holds all seven rows short of
//                            `pass` exactly as the person ruled, and concedes twelve improved rows to
//                            do it. The concession is measured here, not asserted.
//
// The gate still fails closed, and it still measures BOTH directions. The repair being narrowed does
// not make over-correction less interesting; it makes it the thing this gate exists to verify is gone.

import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { caseByID, policyCatalog } from '../../src/core/catalog';
import { EvaluationEngine } from '../../src/core/engine';
import { evaluateRepaired, OUT_OF_SCOPE_METHODS, CAPABILITY_SCORING_POLICY_VERSION_2 } from '../../src/core/capability-repair';
import { CAPABILITY_SPEC_BY_CASE } from '../../src/core/capability-repair-spec';
import {
  narrowedRepairStatus, NARROWED_CASES, NARROWING_ID, NARROWING_AUTHORITY,
  PROTECTED_ROWS, CONCEDED_ROWS, isNarrowedCase, CAPABILITY_SCORING_POLICY_ADOPTION,
} from '../../src/core/capability-repair-narrowing';
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
  coverageEvidence: { path: 'pass10-evidence/req03-phase4/coverage/CERNUM-REQ-03-COVERAGE-PASS-SIDE-EVIDENCE.json', digest: 'b949c1ee72e4bcc52e9d82ff944f5f718b0b9910a11e5abbc3b190ea807d8292' },
  coveragePacket: { path: 'pass10-evidence/req03-phase4/coverage/CERNUM-REQ-03-COVERAGE-REVIEW-PACKET.json', digest: '7a0e77c454dc59ea3cf11d8bcb5510fceff05d1db2b4742dca6eb7e1086a01ab' },
  humanRulings: { path: 'pass10-evidence/req03-phase3/decisions/CERNUM-REQ-03-PHASE-3-HUMAN-RULINGS.json', digest: '1b0607c08341cec69f05ca717a3e5e92777fc23cbc295ea79a51c0d7515f7bdf' },
  amendment01: { path: 'pass10-evidence/req03-phase3/amendments/CERNUM-REQ-03-PHASE-3-AMENDMENT-01-INTEG.json', digest: '8e5a7e51b00d0340f91466063a28f52f9958695c754780905cabbc110a43a1de' },
  readj2: { path: 'pass10-evidence/req03-phase2/controls/CERNUM-REQ-03-PHASE-2-CONTROL-READJUDICATION.json', digest: 'd8002e9c6504b654295630290ff72725ff0f58d1026691d7b4874dad8125cab0' },
  readj3: { path: 'pass10-evidence/req03-phase3/controls/CERNUM-REQ-03-PHASE-3-CONTROL-READJUDICATION.json', digest: 'ceaa175c0cec36bc86bc5c5539c8a1935f8445831d4a123abc5d0166ad8d97a6' },
  // ── Phase 5. The rulings that answer the three Phase 4 blockers. ──────────────────────────────
  heldOutCrosswalk: { path: 'req03-sealed/CERNUM-REQ-03-HELDOUT-CONTROLS-CROSSWALK.SEALED.json', digest: '87869d914842e77cd3ed916b663f0d2fd002560b1fd52b9ac48bf40cd976ceb7' },
  heldOutRulings: { path: 'pass10-evidence/req03-phase5/rulings/CERNUM-REQ-03-PHASE-5-RULINGS-CONTROLS-8-AS-SUBMITTED.json', digest: 'a8ca26290092ea3dade0946fe74d424f430f6e68c15b86bde0681ea8489b6dab' },
  coverageRulings: { path: 'pass10-evidence/req03-phase5/rulings/CERNUM-REQ-03-PHASE-5-RULINGS-COVERAGE-28-AS-SUBMITTED.json', digest: 'a9fb1c21eb4c5d8fccec0f19b5c1a979acc17aa847e14729a866b7d87c4644ca' },
  phase5Manifest: { path: 'pass10-evidence/req03-phase5/rulings/CERNUM-REQ-03-PHASE-5-RULINGS-MANIFEST.json', digest: '3b8fc7d96598e511d4a7b122245a3ad25739255cb3be0cd220b1adcce9f47e62' },
  requirementAdoptions: { path: 'pass10-evidence/req03-phase5/adoption/CERNUM-REQ-03-PHASE-5-REQUIREMENT-ADOPTIONS.json', digest: 'be1a4539603548ee6df90fec2c0c8d6373fc8e24336b3bc08a6b4749434c818a' },
} as const;

const EXPECTED = {
  ledgerRows: 616, live: 350, live1: 120, live2: 110, live3: 120,
  seededControls: 80, ctl1: 24, ctl2: 32, ctl3: 24, heldOutControls: 8,
  coverageGroupARows: 42, coverageGroupAPassSide: 34, coverageRulings: 28,
  coverageCases: ['case:conversation:warmth-and-personality', 'case:emotional-understanding:attunement'],
  permittedVerdicts: ['pass', 'partial', 'fail', 'indeterminate', 'evidenceInsufficient'],
} as const;

function hardStop(detail: string): never {
  throw new Error(`REQ-03 PHASE 5 ADOPTION GATE HARD STOP — ${detail}`);
}

function loadPinned(key: keyof typeof SEALED_SOURCES): Buffer {
  const { path, digest } = SEALED_SOURCES[key];
  const full = join(EVIDENCE_ROOT, path);
  if (!existsSync(full)) hardStop(`sealed evidence is absent: ${path}`);
  const bytes = readFileSync(full);
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

// ── The 8 fresh held-out controls, RULED, scored against the sealed crosswalk ───────────────────
interface HeldOutRow {
  controlID: string; caseID: string; expectedVerdict: string; ruledVerdict: string;
  controlFamily: string; variant: string; match: boolean;
}

const heldOut = (() => {
  const blinded = loadSealed('heldOutBlinded');
  requireExactly('fresh held-out controls', blinded.controls.length, EXPECTED.heldOutControls);

  const manifest = loadSealed('phase5Manifest');
  if (!manifest.validation.allGatesPassed) hardStop('the Phase 5 rulings did not pass their import gates');
  if (!manifest.seals.sealedSeparately) hardStop('the coverage and control blocks were not sealed separately');

  const doc = loadSealed('heldOutRulings');
  const rulings = doc.rulings ?? [];
  requireExactly('held-out control rulings', rulings.length, EXPECTED.heldOutControls);

  // The rulings must still be exactly what was sealed before the crosswalk was opened.
  const canonical = JSON.stringify(rulings.map((r: any) => [r.controlID, r.positionInControlBlock, r.caseID, r.verdict, r.rationale]));
  if (createHash('sha256').update(canonical).digest('hex') !== manifest.seals.controlRulingBlockSeal) {
    hardStop('the held-out control rulings changed after sealing — the calibration would be meaningless');
  }

  const expectedBy = new Map<string, any>(loadSealed('heldOutCrosswalk').crosswalk.map((c: any) => [c.controlID, c]));
  if (expectedBy.size !== EXPECTED.heldOutControls) hardStop(`the held-out crosswalk carries ${expectedBy.size} entries`);
  const blindedIDs = new Set(blinded.controls.map((c: any) => c.controlID));

  const rows: HeldOutRow[] = [];
  const seen = new Set<string>();
  for (const r of rulings) {
    if (seen.has(r.controlID)) hardStop(`duplicate held-out controlID ${r.controlID}`);
    if (!blindedIDs.has(r.controlID)) hardStop(`held-out ${r.controlID} is not in the blinded packet — unknown control`);
    const x = expectedBy.get(r.controlID);
    if (!x) hardStop(`held-out ${r.controlID} is not in the sealed crosswalk — unknown control`);
    if (!EXPECTED.permittedVerdicts.includes(r.verdict)) hardStop(`held-out ${r.controlID} carries verdict ${r.verdict}`);
    if (typeof r.rationale !== 'string' || r.rationale.trim().length === 0) hardStop(`held-out ${r.controlID} carries no rationale`);
    seen.add(r.controlID);
    rows.push({
      controlID: r.controlID, caseID: r.caseID, expectedVerdict: x.expectedVerdict, ruledVerdict: r.verdict,
      controlFamily: x.controlFamily, variant: x.variant, match: r.verdict === x.expectedVerdict,
    });
  }
  requireExactly('held-out controls scored', rows.length, EXPECTED.heldOutControls);
  return rows;
})();
const heldOutMisses = heldOut.filter((h) => !h.match);
const heldOutCalibrated = heldOutMisses.length === 0;

// ── The 28 coverage rulings — a coverage census, never an accuracy rate ─────────────────────────
const coverage = (() => {
  const packet = loadSealed('coveragePacket');
  const byID = new Map<string, any>(packet.rows.map((r: any) => [r.decisionID, r]));
  const doc = loadSealed('coverageRulings');
  const rulings = doc.rulings ?? [];
  requireExactly('coverage rulings', rulings.length, EXPECTED.coverageRulings);

  const manifest = loadSealed('phase5Manifest');
  const canonical = JSON.stringify(rulings.map((r: any) => [r.decisionID, r.batchNumber, r.positionInPacket, r.caseID, r.verdict, r.rationale]));
  if (createHash('sha256').update(canonical).digest('hex') !== manifest.seals.coverageRulingBlockSeal) {
    hardStop('the coverage rulings changed after sealing');
  }

  const seen = new Set<string>();
  const byCase: Record<string, Record<string, number>> = {};
  for (const r of rulings) {
    if (seen.has(r.decisionID)) hardStop(`duplicate coverage decisionID ${r.decisionID}`);
    const row = byID.get(r.decisionID);
    if (!row) hardStop(`coverage ${r.decisionID} is not in the sealed packet — unknown row`);
    if (row.caseID !== r.caseID) hardStop(`coverage ${r.decisionID} case changed: ${row.caseID} vs ${r.caseID}`);
    if (!EXPECTED.permittedVerdicts.includes(r.verdict)) hardStop(`coverage ${r.decisionID} carries verdict ${r.verdict}`);
    if (typeof r.rationale !== 'string' || r.rationale.trim().length === 0) hardStop(`coverage ${r.decisionID} carries no rationale`);
    seen.add(r.decisionID);
    byCase[r.caseID] ??= {};
    byCase[r.caseID][r.verdict] = (byCase[r.caseID][r.verdict] ?? 0) + 1;
  }
  for (const c of EXPECTED.coverageCases) {
    const n = rulings.filter((r: any) => r.caseID === c).length;
    if (n !== 14) hardStop(`coverage case ${c} carries ${n} rulings, required exactly 14 — this is a census`);
  }

  // The two requirement statements a person adopted, verbatim, pinned to the packet text.
  const adoptions = loadSealed('requirementAdoptions');
  if (adoptions.adoptedRequirements.length !== 2) hardStop('expected exactly two adopted requirement statements');
  for (const a of adoptions.adoptedRequirements) {
    if (!EXPECTED.coverageCases.includes(a.caseID)) hardStop(`unexpected adopted requirement for ${a.caseID}`);
    if (a.adoptionStatus !== 'ADOPTED' || a.rewritten || a.broadened) hardStop(`${a.caseID} requirement was not adopted verbatim`);
    const inPacket = packet.rows.find((r: any) => r.caseID === a.caseID)?.capabilityRequirement?.requirement;
    if (inPacket !== a.requirement) hardStop(`${a.caseID} adopted requirement does not match the packet text byte for byte`);
  }
  return { rulings, byCase, adoptions };
})();
const coverageRuled = coverage.rulings.length === EXPECTED.coverageRulings;

const coverageEvidence = loadSealed('coverageEvidence');
requireExactly('coverage Group A rows', coverageEvidence.rows.length, EXPECTED.coverageGroupARows);
requireExactly('coverage Group A pass-side rows', coverageEvidence.rows.filter((r: any) => r.isPassSideEvidence).length, EXPECTED.coverageGroupAPassSide);

// ── Replay, under version 1, the repair, and the narrowed repair ────────────────────────────────
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
    attemptID: `replay:${caseID}`, runID: 'req03-phase5', ordinal: 0, repetitionIndex: 1,
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

interface Scored extends LiveRow { v1: string; v2: string; v2n: string; narrowed: boolean; method: string; inScope: boolean }
const scored: Scored[] = live.map((r) => {
  const text = ledger.get(r.slotKey)!.answerText;
  const policy = policyFor(r.caseID);
  const inScope = !OUT_OF_SCOPE_METHODS.has(policy.method);
  const v1 = engine.evaluate(attemptFor(r.caseID, r.candidate, text)).verdict.status;
  const v2 = inScope ? evaluateRepaired(policy, r.caseID, text).status : v1;
  const n = narrowedRepairStatus(r.caseID, v1 as any, v2 as any);
  return { ...r, method: policy.method, inScope, v1, v2, v2n: n.status, narrowed: n.narrowed };
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
  const out: Record<string, { version1: ReturnType<typeof rates>; version2: ReturnType<typeof rates>; version2Narrowed: ReturnType<typeof rates> }> = {};
  for (const k of [...new Set(scored.map(key))].sort()) {
    const rows = scored.filter((r) => key(r) === k);
    out[k] = { version1: rates(rows, (r) => r.v1), version2: rates(rows, (r) => r.v2), version2Narrowed: rates(rows, (r) => r.v2n) };
  }
  return out;
}

const inScopeRows = scored.filter((r) => r.inScope);
const v1All = rates(scored, (r) => r.v1);
const v2All = rates(scored, (r) => r.v2);
const v2nAll = rates(scored, (r) => r.v2n);
const v1InScope = rates(inScopeRows, (r) => r.v1);
const v2InScope = rates(inScopeRows, (r) => r.v2);
const v2nInScope = rates(inScopeRows, (r) => r.v2n);

/** The failure mode this gate exists to watch: a row a person ruled short that the repair passes. */
const newFalseNegativesUnnarrowed = scored.filter((r) => r.humanVerdict !== 'pass' && r.v1 !== 'pass' && r.v2 === 'pass');
const newFalseNegativesNarrowed = scored.filter((r) => r.humanVerdict !== 'pass' && r.v1 !== 'pass' && r.v2n === 'pass');

/** What the narrowing did, measured from the rows rather than taken from the module. */
const narrowingProtected = scored.filter((r) => r.narrowed && r.v2 === 'pass' && r.v2n !== 'pass' && r.humanVerdict !== 'pass');
const narrowingConceded = scored.filter((r) => r.narrowed && r.v2 === 'pass' && r.v2n !== 'pass' && r.humanVerdict === 'pass');
const narrowingHeldAtVersion1 = scored.filter((r) => r.narrowed && r.v2n !== r.v1);

const seededMisses = controls.filter((c) => c.humanVerdict !== c.expectedVerdict);
const seededMissesBeforeSupersession = controls.filter((c) => c.asSubmittedVerdict !== c.expectedVerdict);

// ── The adoption decision ───────────────────────────────────────────────────────────────────────
const blockers: { id: string; blocker: string; why: string }[] = [];
if (!heldOutCalibrated) blockers.push({
  id: 'P5-BLOCK-HELDOUT-CALIBRATION',
  blocker: `${heldOutMisses.length} of ${EXPECTED.heldOutControls} held-out controls were not ruled as expected`,
  why: 'The adjudicator’s calibration on cases never used as a control is what makes the coverage '
     + 'rulings and the narrowing decision readable at all. Below 8/8 everything is quarantined.',
});
if (!coverageRuled) blockers.push({
  id: 'P4-BLOCK-COVERAGE',
  blocker: '28 rows across 2 coverage cases have never been ruled by anyone',
  why: 'REQ-03 cannot close over cases nobody has read.',
});
if (newFalseNegativesNarrowed.length > 0) blockers.push({
  id: 'P4-BLOCK-OVERCORRECTION',
  blocker: `the repair still passes ${newFalseNegativesNarrowed.length} rows a person ruled short and version 1 did not`,
  why: 'The defect being repaired is over-failure, so over-correction is the failure mode to watch. '
     + 'The narrowing was ruled precisely to remove these.',
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
  artifact: 'CERNUM-REQ-03-PHASE-5-ADOPTION-GATE-RESULT',
  computedAt: new Date('2026-09-16T21:00:00Z').toISOString(),
  requirement: 'REQ-03', phase: '5 — narrowed repair, held-out validation, coverage closure, adoption',
  ADOPTED: adopted,
  adoptionStatus: adopted ? 'ADOPTED — prospectively, scoringPolicyVersion 2 narrowed' : 'NOT ADOPTED — blocked',
  blockers,
  scoringPolicy: {
    version1: '1 — untouched, canonical, still resolves every stored row',
    version2: `${CAPABILITY_SCORING_POLICY_VERSION_2} — the repair, as Phase 4 measured it`,
    version2Narrowed: `${CAPABILITY_SCORING_POLICY_VERSION_2} + ${NARROWING_ID} — the form being adopted`,
    narrowingAuthority: NARROWING_AUTHORITY,
    historyModifiedInPlace: false,
    version1ReproducesSealedStatus: v1Drift.length === 0,
    version1DriftRows: v1Drift.map((r) => ({ decisionID: r.decisionID, sealed: r.evaluatorStatusAtSealing, replayed: r.v1 })),
    adoption: CAPABILITY_SCORING_POLICY_ADOPTION,
    prospectiveOnly: 'Adoption governs attempts scored after it. No stored row is rescored, and the '
      + 'repair is NOT wired into the live evaluation path — that is a routing change and needs its own approval.',
  },
  PHASE_3_IS_A_SAMPLE: {
    isSample: true,
    mustBeLabelled: 'SAMPLE, not census, everywhere it appears — inside Phase 5 too.',
    population: 'SAMPLE — 120 of 350 pass rows, 34.29%.',
    publishedLimitation: 'The 95% Wilson interval on the 3.33% sample false-negative rate runs to 8.26%, '
      + 'above the 5% escalation threshold. A sample below the threshold is not a population below it.',
  },
  aggregateRule: {
    rule: 'Rates are published PER CASE and PER CANDIDATE. The corpus-wide figures below are a '
        + 'reconciliation total, not a headline, and may not be quoted as the evaluator’s accuracy.',
  },
  calibration: {
    seededControls: controls.length,
    effectiveMatches: controls.length - seededMisses.length,
    roundOneMisses: seededMissesBeforeSupersession.map((c) => c.controlID),
    supersessionsApplied: controls.filter((c) => c.superseded).map((c) => ({
      controlID: c.controlID, asSubmitted: c.asSubmittedVerdict, effective: c.humanVerdict,
    })),
    heldOut: {
      count: heldOut.length,
      correct: heldOut.length - heldOutMisses.length,
      calibrated: heldOutCalibrated,
      threshold: '8/8 — anything less quarantines the packet',
      crosswalkOpenedAfterRulingsSealed: true,
      mismatches: heldOutMisses,
      byControlFamily: ['knownGood', 'knownBad'].map((f) => ({
        family: f, n: heldOut.filter((h) => h.controlFamily === f).length,
        correct: heldOut.filter((h) => h.controlFamily === f && h.match).length,
      })),
      difficultVariantsIncluded: heldOut.filter((h) => h.variant !== 'plain').map((h) => h.controlID),
      whatItSettles: 'The adjudicator’s judgement still matches the sealed expectations on two cases '
        + 'never used as a control, after three Phase 3 controls were burned.',
    },
  },
  corpus: {
    adjudicatedRows: scored.length, seededControls: controls.length,
    freshHeldOutControls: heldOut.length, freshHeldOutControlsRuled: true,
    coverageRulings: coverage.rulings.length, ledgerAttempts: ledger.size,
    totalHumanDecisionsRead: scored.length + controls.length + heldOut.length + coverage.rulings.length,
  },
  reconciliationTotals: {
    version1: v1All, version2: v2All, version2Narrowed: v2nAll,
    inScopeOnly: { version1: v1InScope, version2: v2InScope, version2Narrowed: v2nInScope },
    outOfScopeRows: scored.length - inScopeRows.length,
  },
  perCase: groupBy((r) => r.caseID),
  perCandidate: groupBy((r) => r.candidate),
  perMethod: groupBy((r) => r.method),
  narrowing: {
    id: NARROWING_ID,
    authority: NARROWING_AUTHORITY,
    cases: NARROWED_CASES.map((n) => ({
      caseID: n.caseID, mechanismWithdrawn: n.mechanismWithdrawn, whyNotFiner: n.whyNotFiner,
      protects: n.protectsRows.length, concedes: n.concedesRows.length,
    })),
    criteriaAmended: false,
    requirementStatementsAltered: false,
    protectedRowsMeasured: narrowingProtected.map((r) => ({
      decisionID: r.decisionID, caseID: r.caseID, humanVerdict: r.humanVerdict, version1: r.v1, version2: r.v2, narrowed: r.v2n,
    })),
    concededRowsMeasured: narrowingConceded.map((r) => ({
      decisionID: r.decisionID, caseID: r.caseID, humanVerdict: r.humanVerdict, version1: r.v1, version2: r.v2, narrowed: r.v2n,
    })),
    costStatedPlainly: `The narrowing holds ${narrowingProtected.length} rows short of pass as the person ruled, `
      + `and gives up ${narrowingConceded.length} rows the repair had correctly improved to do it. `
      + 'Both numbers are published; neither is netted against the other.',
    severityCaveat: 'Five of the seven protected rows return to version 1’s `partial`, which is the human '
      + 'verdict exactly. Two — P2-88f4d2bb6d92 and P2-028210924f0e — return to version 1’s `fail` where the '
      + 'human said `partial`: that case declares a single required concept, so version 1 can emit only pass '
      + 'or fail and no narrowing can invent a partial. They are held short of pass, as ruled, at version 1’s '
      + 'severity. That is a pre-existing version-1 severity disagreement, not a new over-correction.',
  },
  overCorrection: {
    rowsAPersonRuledShort: scored.filter((r) => r.humanVerdict !== 'pass').length,
    version1Held: scored.filter((r) => r.humanVerdict !== 'pass' && r.v1 !== 'pass').length,
    version2Held: scored.filter((r) => r.humanVerdict !== 'pass' && r.v2 !== 'pass').length,
    version2NarrowedHeld: scored.filter((r) => r.humanVerdict !== 'pass' && r.v2n !== 'pass').length,
    newFalseNegativesUnnarrowed: newFalseNegativesUnnarrowed.map((r) => r.decisionID),
    newFalseNegativesNarrowed: newFalseNegativesNarrowed.map((r) => r.decisionID),
  },
  coverage: {
    groupAResolved: coverageEvidence.groupA.cases,
    groupARows: coverageEvidence.rows.length,
    groupAPassSideRows: coverageEvidence.rows.filter((r: any) => r.isPassSideEvidence).length,
    groupBCases: EXPECTED.coverageCases,
    groupBRows: coverage.rulings.length,
    groupBVerdictsByCase: coverage.byCase,
    requirementStatementsAdopted: coverage.adoptions.adoptedRequirements.map((a: any) => ({
      caseID: a.caseID, adoptionStatus: a.adoptionStatus, requirementSha256: a.requirementSha256,
      rewritten: a.rewritten, broadened: a.broadened,
    })),
    blockersClosedByTheseRulings: ['P3-COVERAGE-01', 'P3-COVERAGE-02', 'P3-BLIND-01'],
    blockersNotClosedByTheseRulings: {
      'P4-MECH-01': 'No catalog case routes to the prohibitedConcepts evaluator. Untouched by these rulings.',
      'P4-PARITY-01': 'The stale parity fixture is a pre-existing working-tree condition. Untouched.',
    },
    isNotAFalseNegativeMeasurement: 'The evaluator for these two cases never emits pass or fail, so there '
      + 'is no machine verdict to be wrong. These 28 rulings close a coverage gap. They are NOT pooled into '
      + 'the Phase 3 false-negative numerator or denominator, and they are not rows in any rate above.',
    blocksReq03Closure: false,
  },
  outOfScopeResidual: {
    note: 'Measured and published, not repaired.',
    methods: [...OUT_OF_SCOPE_METHODS].sort(),
  },
  repairSpec: { caseEntries: CAPABILITY_SPEC_BY_CASE.size, narrowedCases: NARROWED_CASES.length },
  nothingRescored: [
    'No published capability rate was recomputed.',
    'No candidate was ranked, retained, recommended or routed.',
    'No sealed ruling was altered.',
    'No adopted requirement statement was amended.',
    'scoringPolicyVersion 1 is untouched.',
  ],
  req03Status: adopted ? 'OPEN — adoption gate passed; closure is a separate human decision' : 'OPEN',
  provenance: { source: 'human', modelParticipation: 'advisory', finalDecisionMaker: 'Seth J. Leopold' },
};

const OUT = process.env.CERNUM_REQ03_PHASE5_RESULT
  ?? join(EVIDENCE_ROOT, 'pass10-evidence/req03-phase5/gate/CERNUM-REQ-03-PHASE-5-ADOPTION-GATE-RESULT.json');
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(result, null, 1) + '\n');

describe('REQ-03 Phase 5 · the gate reads the whole sealed record, not a subset', () => {
  it('loads exactly 616 ledger attempts, one-to-one by slotKey', () => {
    expect(ledger.size).toBe(EXPECTED.ledgerRows);
  });
  it('loads exactly 350 adjudicated live rows, no duplicate and no unknown row', () => {
    expect(live.length).toBe(EXPECTED.live);
    expect(new Set(live.map((r) => r.decisionID)).size).toBe(EXPECTED.live);
    expect(new Set(live.map((r) => r.slotKey)).size).toBe(EXPECTED.live);
  });
  it('loads exactly 80 seeded controls, 8 held-out controls and 28 coverage rulings', () => {
    expect(controls.length).toBe(EXPECTED.seededControls);
    expect(heldOut.length).toBe(EXPECTED.heldOutControls);
    expect(coverage.rulings.length).toBe(EXPECTED.coverageRulings);
  });
  it('reads 466 human decisions in total, every one from a sealed record', () => {
    expect(result.corpus.totalHumanDecisionsRead).toBe(350 + 80 + 8 + 28);
  });
});

describe('REQ-03 Phase 5 · held-out validation', () => {
  it('calibrates the adjudicator 8/8 on two cases never used as a control', () => {
    expect(heldOutMisses).toEqual([]);
    expect(heldOutCalibrated).toBe(true);
  });
  it('includes the difficult variants, not only the plain ones', () => {
    expect(heldOut.filter((h) => h.variant !== 'plain').length).toBe(4);
    expect(heldOut.filter((h) => h.variant !== 'plain' && h.match).length).toBe(4);
  });
  it('scores both control families', () => {
    expect(heldOut.filter((h) => h.controlFamily === 'knownGood').length).toBe(4);
    expect(heldOut.filter((h) => h.controlFamily === 'knownBad').length).toBe(4);
  });
  it('scores the effective seeded control block — as-submitted plus the four sealed supersessions', () => {
    expect(superseded.size).toBe(4);
    expect(seededMissesBeforeSupersession.length).toBe(4);
    expect(seededMisses).toEqual([]);
  });
});

describe('REQ-03 Phase 5 · version 1 is preserved', () => {
  it('reproduces every sealed version-1 status — any drift is a hard stop', () => {
    expect(v1Drift.map((r) => r.decisionID)).toEqual([]);
  });
  it('does not modify scoring policy history in place, and adopts prospectively only', () => {
    expect(result.scoringPolicy.historyModifiedInPlace).toBe(false);
    expect(CAPABILITY_SCORING_POLICY_ADOPTION.prospectiveOnly).toBe(true);
    expect(CAPABILITY_SCORING_POLICY_ADOPTION.historicalRowsRescored).toBe(false);
    expect(CAPABILITY_SCORING_POLICY_ADOPTION.wiredIntoLiveEvaluationPath).toBe(false);
  });
});

describe('REQ-03 Phase 5 · the narrowed repair, measured in both directions', () => {
  it('holds every one of the seven rows a person ruled short', () => {
    expect(newFalseNegativesUnnarrowed.length).toBe(7);
    expect(newFalseNegativesNarrowed).toEqual([]);
    expect(narrowingProtected.map((r) => r.decisionID).sort()).toEqual([...PROTECTED_ROWS].sort());
  });
  it('publishes what the narrowing conceded rather than netting it away', () => {
    expect(narrowingConceded.map((r) => r.decisionID).sort()).toEqual([...CONCEDED_ROWS].sort());
    expect(narrowingConceded.length).toBe(12);
  });
  it('returns the two narrowed cases to version 1 exactly, and touches no other case', () => {
    expect(narrowingHeldAtVersion1).toEqual([]);
    for (const r of scored) expect(r.narrowed).toBe(isNarrowedCase(r.caseID));
    for (const r of scored.filter((x) => !x.narrowed)) expect(r.v2n).toBe(r.v2);
  });
  it('keeps every in-scope false positive the repair removed outside the narrowed cases', () => {
    expect(v1InScope.falsePositive).toBe(180);
    expect(v2InScope.falsePositive).toBe(0);
    expect(v2nInScope.falsePositive).toBe(12);
    expect(v2nInScope.falseNegative).toBeLessThan(v2InScope.falseNegative);
  });
  it('amends no adopted criteria', () => {
    expect(result.narrowing.criteriaAmended).toBe(false);
    expect(result.narrowing.requirementStatementsAltered).toBe(false);
  });
  it('publishes rates per case and per candidate, never only in aggregate', () => {
    expect(Object.keys(result.perCandidate).length).toBe(10);
    expect(Object.keys(result.perCase).length).toBeGreaterThan(1);
  });
});

describe('REQ-03 Phase 5 · coverage', () => {
  it('closes both Group B cases with a census of 14 rulings each', () => {
    for (const c of EXPECTED.coverageCases) {
      expect(coverage.rulings.filter((r: any) => r.caseID === c).length).toBe(14);
    }
  });
  it('adopts both requirement statements verbatim', () => {
    for (const a of coverage.adoptions.adoptedRequirements) {
      expect(a.adoptionStatus).toBe('ADOPTED');
      expect(a.rewritten).toBe(false);
      expect(a.broadened).toBe(false);
    }
  });
  it('never pools the coverage rulings into an accuracy rate', () => {
    expect(scored.some((r) => EXPECTED.coverageCases.includes(r.caseID as any))).toBe(false);
    expect(result.reconciliationTotals.version2Narrowed.n).toBe(EXPECTED.live);
  });
  it('closes only the blockers these rulings actually resolve', () => {
    expect(result.coverage.blockersClosedByTheseRulings).toEqual(['P3-COVERAGE-01', 'P3-COVERAGE-02', 'P3-BLIND-01']);
    expect(Object.keys(result.coverage.blockersNotClosedByTheseRulings)).toEqual(['P4-MECH-01', 'P4-PARITY-01']);
  });
});

describe('REQ-03 Phase 5 · the adoption decision', () => {
  it('adopts only when every blocking condition is answered', () => {
    expect(blockers).toEqual([]);
    expect(adopted).toBe(true);
  });
  it('does not close REQ-03 by itself, and ranks nothing', () => {
    expect(result.req03Status).toContain('OPEN');
    expect(result.nothingRescored).toContain('No candidate was ranked, retained, recommended or routed.');
  });
});
