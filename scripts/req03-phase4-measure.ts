// Cernum · REQ-03 Phase 4 — what the version-1 evaluator does against the whole adjudicated corpus.
//
// A measurement, not a repair. It reads the 350 adjudicated rows from the sealed records, replays the
// CURRENT evaluator over each, and prints the disagreement per case so the repair is derived from
// ground truth rather than from a guess about where the defect lives.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { caseByID, policyCatalog } from '../src/core/catalog';
import { EvaluationEngine } from '../src/core/engine';
import { AttemptRecord, Observation } from '../src/core/run';

const ROOT = process.env.CERNUM_EVIDENCE_ROOT
  ?? '/Volumes/LaCie/MacMini-NemoClaw-Workspace/model-lab-results';

function hardStop(m: string): never { throw new Error(`REQ-03 PHASE 4 MEASURE HARD STOP — ${m}`); }

const LEDGERS = [
  { path: 'pass08-evidence/campaign-a2/results.jsonl', digest: 'adcb22f1ab7908b5c08d1568ee316e1001cad9ab6b101cb43b0dab3e711799f0' },
  { path: 'pass08-evidence/campaign-b2/results.jsonl', digest: '0a1561d7bd4f8cab4644b08f529b9e8711572aa03d0d9b82f5301875adc65f96' },
];

interface LedgerRow { slotKey: string; caseID: string; candidate: string; status: string; answerText?: string }

const ledger = new Map<string, LedgerRow>();
for (const s of LEDGERS) {
  const raw = readFileSync(join(ROOT, s.path));
  if (createHash('sha256').update(raw).digest('hex') !== s.digest) hardStop(`${s.path} digest changed`);
  for (const line of raw.toString('utf8').split('\n')) {
    if (line.trim().length === 0) continue;
    const r = JSON.parse(line) as LedgerRow;
    if (ledger.has(r.slotKey)) hardStop(`duplicate slotKey ${r.slotKey}`);
    ledger.set(r.slotKey, r);
  }
}
if (ledger.size !== 616) hardStop(`${ledger.size} ledger rows, expected 616`);

const engine = new EvaluationEngine(policyCatalog, () => new Date('2026-01-01T00:00:00Z'));

export function observationFor(answerText: string): Observation {
  return {
    outputText: answerText, toolCallObservationsRaw: [], terminalStatus: 'completed',
    providerReportedUsage: { unavailableReason: 'replayed from the sealed ledger' },
    timing: { startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-01T00:00:00Z', durationMilliseconds: { measured: 0 } },
    warnings: [], errors: [],
    identityVerification: { state: 'unverifiable', reportedModelID: { unavailableReason: 'replayed' }, requestedModelID: '' },
    runtimeConfigurationID: 'replay', requestDigest: 'replay',
  } as unknown as Observation;
}

export function attemptFor(caseID: string, candidate: string, answerText: string): AttemptRecord {
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

// ── The 350 adjudicated rows, read from the sealed records ──────────────────────────────────────
interface Adjudicated { decisionID: string; slotKey: string; caseID: string; candidate: string; phase: number; verdict: string }

function phaseRows(phase: number, rulingsRel: string): Adjudicated[] {
  const idmap = JSON.parse(readFileSync(join(ROOT, `req03-sealed/CERNUM-REQ-03-PHASE-${phase}-IDENTITY-MAP.SEALED.json`), 'utf8'));
  const slot = new Map<string, any>(idmap.rows.map((r: any) => [r.decisionID, r]));
  const rul = JSON.parse(readFileSync(join(ROOT, `pass10-evidence/${rulingsRel}`), 'utf8'));
  return rul.rulings.map((r: any) => {
    const idr = slot.get(r.decisionID);
    if (!idr) hardStop(`phase ${phase}: ${r.decisionID} has no sealed identity row`);
    return { decisionID: r.decisionID, slotKey: idr.slotKey, caseID: idr.caseID, candidate: idr.candidate, phase, verdict: r.verdict };
  });
}

export const adjudicated: Adjudicated[] = [
  ...phaseRows(1, 'req03-phase1/rulings/CERNUM-REQ-03-PHASE-1-RULINGS-LIVE-120-AS-SUBMITTED.json'),
  ...phaseRows(2, 'req03-phase2/rulings/CERNUM-REQ-03-PHASE-2-RULINGS-LIVE-110-EFFECTIVE.json'),
  ...phaseRows(3, 'req03-phase3/rulings/CERNUM-REQ-03-PHASE-3-RULINGS-LIVE-120-AS-SUBMITTED.json'),
];
if (adjudicated.length !== 350) hardStop(`${adjudicated.length} adjudicated rows, expected 350`);

if (process.argv[1]?.endsWith('req03-phase4-measure.ts')) {
  const perCase = new Map<string, { n: number; agree: number; fp: number; fn: number; method: string; rows: any[] }>();
  for (const a of adjudicated) {
    const led = ledger.get(a.slotKey);
    if (!led) hardStop(`${a.decisionID}: slotKey absent from the ledger`);
    const v1 = engine.evaluate(attemptFor(a.caseID, a.candidate, led.answerText ?? '')).verdict.status;
    const humanPass = a.verdict === 'pass';
    const evalPass = v1 === 'pass';
    const e = perCase.get(a.caseID) ?? { n: 0, agree: 0, fp: 0, fn: 0, method: caseByID(a.caseID)!.scoringPolicyID, rows: [] };
    e.n += 1;
    if (evalPass === humanPass) e.agree += 1;
    else if (!evalPass && humanPass) e.fp += 1;   // evaluator wrongly withheld a pass
    else e.fn += 1;                               // evaluator wrongly gave a pass
    e.rows.push({ decisionID: a.decisionID, v1, human: a.verdict });
    perCase.set(a.caseID, e);
  }
  let FP = 0, FN = 0, N = 0;
  const broken: string[] = [];
  console.log('case'.padEnd(52) + '  n  agree   FP   FN');
  for (const [cid, e] of [...perCase.entries()].sort()) {
    N += e.n; FP += e.fp; FN += e.fn;
    if (e.fp + e.fn > 0) broken.push(cid);
    console.log(`${cid.padEnd(52)}${String(e.n).padStart(3)}${String(e.agree).padStart(7)}${String(e.fp).padStart(5)}${String(e.fn).padStart(5)}`);
  }
  console.log(`\nTOTAL ${N} rows · agree ${N - FP - FN} · evaluator withheld a deserved pass ${FP} · evaluator gave an undeserved pass ${FN}`);
  console.log(`cases needing repair: ${broken.length} of ${perCase.size}`);
}
