// Cernum REQ-03 Phase 6 · P6-RESCORE-AND-RANK — the VERSIONED COMPANION RESTATEMENT.
//
// Rescores the stored frontier responses under scoring policy generation 2 WITHOUT sending a single
// provider request: every answer is read from the sealed Pass 8 ledgers and replayed through the live
// engine. Version-1 artifacts are neither overwritten, renamed nor replaced — this writes new files
// beside them, and every row carries both readings.
//
// WHAT A RESTATEMENT IS NOT. It is not a new campaign, it is not a new measurement of the models, and
// it is not a reason to route a candidate anywhere. The same answers are read by a different judge.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { caseByID, policyCatalog, registeredSuites } from '../src/core/catalog';
import { EvaluationEngine } from '../src/core/engine';
import { structuredSchemaSemanticEvaluator, SEMANTIC_JSON_VIEW_LIMITATION } from '../src/core/evaluators';
import { bindSuiteToGeneration, bindCampaignScoring } from '../src/core/campaign-binding';
import { SCORING_POLICY_GENERATION_1 as G1, SCORING_POLICY_GENERATION_2 as G2 } from '../src/core/capability-generation';
import { AttemptRecord, Observation } from '../src/core/run';

const ROOT = process.env.CERNUM_EVIDENCE_ROOT ?? '/Volumes/LaCie/MacMini-NemoClaw-Workspace/model-lab-results';
const OUT = join(ROOT, 'pass10-evidence/req03-phase6/rescore');
mkdirSync(OUT, { recursive: true });

const LEDGERS = {
  'campaign-a2': { path: 'pass08-evidence/campaign-a2/results.jsonl', digest: 'adcb22f1ab7908b5c08d1568ee316e1001cad9ab6b101cb43b0dab3e711799f0' },
  'campaign-b2': { path: 'pass08-evidence/campaign-b2/results.jsonl', digest: '0a1561d7bd4f8cab4644b08f529b9e8711572aa03d0d9b82f5301875adc65f96' },
} as const;

interface Led { [k: string]: any }
const rowsIn: Led[] = [];
for (const [name, { path, digest }] of Object.entries(LEDGERS)) {
  const bytes = readFileSync(join(ROOT, path));
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== digest) throw new Error(`SEALED LEDGER CHANGED (${name}): expected ${digest}, got ${actual}. Nothing was rescored.`);
  for (const line of bytes.toString('utf8').split('\n')) {
    if (line.trim()) rowsIn.push({ ...JSON.parse(line), ledger: name });
  }
}

// ── The human ground truth, for the rows that have any ──────────────────────────────────────────
const human = new Map<string, string>();   // slotKey -> human verdict
for (const [rul, map] of [
  ['pass10-evidence/req03-phase1/rulings/CERNUM-REQ-03-PHASE-1-RULINGS-LIVE-120-AS-SUBMITTED.json', 'req03-sealed/CERNUM-REQ-03-PHASE-1-IDENTITY-MAP.SEALED.json'],
  ['pass10-evidence/req03-phase2/rulings/CERNUM-REQ-03-PHASE-2-RULINGS-LIVE-110-EFFECTIVE.json', 'req03-sealed/CERNUM-REQ-03-PHASE-2-IDENTITY-MAP.SEALED.json'],
  ['pass10-evidence/req03-phase3/rulings/CERNUM-REQ-03-PHASE-3-RULINGS-LIVE-120-AS-SUBMITTED.json', 'req03-sealed/CERNUM-REQ-03-PHASE-3-IDENTITY-MAP.SEALED.json'],
] as const) {
  const rulings = JSON.parse(readFileSync(join(ROOT, rul), 'utf8')).rulings as any[];
  const byDecision = new Map<string, any>(JSON.parse(readFileSync(join(ROOT, map), 'utf8')).rows.map((r: any) => [r.decisionID, r]));
  for (const r of rulings) human.set(byDecision.get(r.decisionID)!.slotKey, r.verdict);
}

const engine = new EvaluationEngine(policyCatalog, () => new Date('2026-01-01T00:00:00Z'));
function observationFor(answerText: string, terminal: string): Observation {
  return {
    outputText: answerText, toolCallObservationsRaw: [], terminalStatus: terminal,
    providerReportedUsage: { unavailableReason: 'replayed from the sealed ledger' },
    timing: { startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-01T00:00:00Z', durationMilliseconds: { measured: 0 } },
    warnings: [], errors: [],
    identityVerification: { state: 'unverifiable', reportedModelID: { unavailableReason: 'replayed' }, requestedModelID: '' },
    runtimeConfigurationID: 'replay', requestDigest: 'replay',
  } as unknown as Observation;
}
function boundCase(caseID: string, generation: string) {
  const suite = registeredSuites.find((s) => s.cases.some((c) => c.id.raw === caseID));
  if (!suite) return undefined;
  return bindSuiteToGeneration(suite, generation, policyCatalog).cases.find((c) => c.id.raw === caseID);
}
function attemptFor(caseID: string, candidate: string, text: string, generation: string): AttemptRecord | undefined {
  const c = boundCase(caseID, generation);
  if (!c) return undefined;
  return {
    attemptID: `restate:${generation}:${caseID}:${candidate}`, runID: 'req03-phase6-restatement', ordinal: 0, repetitionIndex: 1,
    candidate: { id: { raw: candidate } }, candidateDigest: 'replay',
    suiteID: c.suiteID, suiteVersion: c.suiteVersion, caseID: c.id, caseDigest: 'replay',
    inputPackage: c.inputs, inputPackageDigest: 'replay',
    scoringPolicyID: c.scoringPolicyID, scoringPolicyVersion: c.scoringPolicyVersion,
    environment: {} as AttemptRecord['environment'], observation: observationFor(text, 'completed'),
    terminalStatus: 'completed', comparabilityKey: 'replay',
    startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:00:00Z',
  } as unknown as AttemptRecord;
}

// ── Restate every eligible row under both generations ──────────────────────────────────────────
interface Restated {
  slotKey: string; ledger: string; candidate: string; provider: string; caseID: string; suite: string;
  storedStatusVersion1: string; replayedVersion1: string; restatedVersion2: string;
  version1Reproduced: boolean; changed: boolean;
  governanceV1: string; governanceV2: string;
  semanticJSONView?: string;
  humanVerdict?: string;
  identityState: string; providerIdentityState: string; bindingIdentityState: string;
  eligible: boolean; ineligibleReason?: string;
}

const restated: Restated[] = [];
for (const r of rowsIn) {
  const base = {
    slotKey: r.slotKey, ledger: r.ledger, candidate: r.candidate, provider: r.provider, caseID: r.caseID, suite: r.suite,
    storedStatusVersion1: r.status, governanceV1: '', governanceV2: '',
    identityState: r.identityState, providerIdentityState: r.providerIdentityState, bindingIdentityState: r.bindingIdentityState,
    humanVerdict: human.get(r.slotKey),
  };
  if (r.status === 'runtimeError' || typeof r.answerText !== 'string' || r.answerText.length === 0) {
    restated.push({ ...base, replayedVersion1: r.status, restatedVersion2: r.status, version1Reproduced: true,
      changed: false, eligible: false,
      ineligibleReason: r.status === 'runtimeError' ? 'the attempt never produced an answer (runtimeError)' : 'the stored answer text is empty' } as Restated);
    continue;
  }
  const a1 = attemptFor(r.caseID, r.candidate, r.answerText, G1);
  const a2 = attemptFor(r.caseID, r.candidate, r.answerText, G2);
  if (!a1 || !a2) {
    restated.push({ ...base, replayedVersion1: r.status, restatedVersion2: r.status, version1Reproduced: true,
      changed: false, eligible: false, ineligibleReason: `case ${r.caseID} is not in the registered catalog` } as Restated);
    continue;
  }
  const v1 = engine.evaluate(a1).verdict;
  const v2 = engine.evaluate(a2).verdict;
  let semantic: string | undefined;
  const leaf = engine.leafPolicyFor(a1);
  if (leaf.method === 'structuredSchema') {
    semantic = structuredSchemaSemanticEvaluator.evaluate(a1.observation, 'json', leaf).status;
  }
  restated.push({
    ...base,
    replayedVersion1: v1.status, restatedVersion2: v2.status,
    version1Reproduced: v1.status === r.status,
    changed: v2.status !== v1.status,
    governanceV1: v1.governance.state, governanceV2: v2.governance.state,
    semanticJSONView: semantic,
    eligible: true,
  } as Restated);
}

// ── Rankings, with Wilson intervals ────────────────────────────────────────────────────────────
function wilson(passes: number, n: number): { pointPercent: number; lowPercent: number; highPercent: number } {
  if (n === 0) return { pointPercent: 0, lowPercent: 0, highPercent: 0 };
  const z = 1.959963985, p = passes / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const s = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  const f = (x: number) => Number((100 * Math.min(1, Math.max(0, x))).toFixed(2));
  return { pointPercent: f(p), lowPercent: f((c - s) / d), highPercent: f((c + s) / d) };
}

const candidates = [...new Set(restated.map((r) => r.candidate))].sort();
function ranking(pick: (r: Restated) => string) {
  return candidates.map((cand) => {
    const rows = restated.filter((r) => r.candidate === cand && r.eligible);
    const scored = rows.filter((r) => pick(r) !== 'requiresHumanReview');
    const passes = scored.filter((r) => pick(r) === 'pass').length;
    return {
      candidate: cand, attempts: rows.length, scored: scored.length,
      withheldForHumanReview: rows.length - scored.length, passes,
      passRate: wilson(passes, scored.length),
    };
  }).sort((a, b) => b.passRate.pointPercent - a.passRate.pointPercent || a.candidate.localeCompare(b.candidate));
}
const rankV1 = ranking((r) => r.replayedVersion1);
const rankV2 = ranking((r) => r.restatedVersion2);
const posV1 = new Map(rankV1.map((r, i) => [r.candidate, i + 1]));
const posV2 = new Map(rankV2.map((r, i) => [r.candidate, i + 1]));

// ── Evaluator accuracy, ONLY where a person ruled ──────────────────────────────────────────────
function accuracy(rows: Restated[], pick: (r: Restated) => string) {
  let fp = 0, fn = 0, agree = 0, withheld = 0;
  for (const r of rows) {
    const s = pick(r);
    if (s === 'requiresHumanReview') { withheld += 1; continue; }
    const evalPass = s === 'pass', humanPass = r.humanVerdict === 'pass';
    if (evalPass === humanPass) agree += 1; else if (!evalPass && humanPass) fp += 1; else fn += 1;
  }
  const n = rows.length - withheld;
  return { adjudicatedRows: rows.length, scored: n, withheldForHumanReview: withheld, agree,
           falsePositive: fp, falseNegative: fn,
           falsePositiveRate: wilson(fp, n), falseNegativeRate: wilson(fn, n) };
}
const adjudicated = restated.filter((r) => r.humanVerdict !== undefined && r.eligible);
const byCase = [...new Set(adjudicated.map((r) => r.caseID))].sort().map((c) => {
  const rows = adjudicated.filter((r) => r.caseID === c);
  return { caseID: c, version1: accuracy(rows, (r) => r.replayedVersion1), version2: accuracy(rows, (r) => r.restatedVersion2) };
});
const byCandidate = candidates.map((c) => {
  const rows = adjudicated.filter((r) => r.candidate === c);
  return { candidate: c, version1: accuracy(rows, (r) => r.replayedVersion1), version2: accuracy(rows, (r) => r.restatedVersion2) };
});

const changed = restated.filter((r) => r.changed);
const notReproduced = restated.filter((r) => r.eligible && !r.version1Reproduced);
const binding = bindCampaignScoring(registeredSuites, G2, policyCatalog);

const provenance = { source: 'model', modelParticipation: 'computation', finalDecisionMaker: 'Seth J. Leopold',
  authority: 'P6-RESCORE-AND-RANK — "YES, AS A VERSIONED COMPANION RESTATEMENT."' };

const WARNINGS = {
  movesCandidatesRelativeToOneAnother:
    'ADOPTING GENERATION 2 MOVES CANDIDATES RELATIVE TO ONE ANOTHER. This restatement is published so that '
    + 'movement is visible, not so that it can be acted on. No candidate may be routed, retained, recommended '
    + 'or promoted on this evidence.',
  identity:
    'Every row carries identityState / providerIdentityState / bindingIdentityState exactly as the Pass 8 '
    + 'ledger recorded them. Rows whose identity was not verified are restated but their candidate attribution '
    + 'is only as good as the original campaign\'s — this restatement adds no identity evidence and claims none.',
  governance:
    'Generation 2 changes governance outcomes as well as capability verdicts. A row whose rule is REFERRED is '
    + 'withheld as requiresHumanReview and is excluded from every rate here rather than counted as a pass or a fail.',
  accuracyScope:
    'False-positive and false-negative measurements exist ONLY for the rows a person actually ruled. Every other '
    + 'row has a restated status and no accuracy claim whatever.',
  semanticJSON: SEMANTIC_JSON_VIEW_LIMITATION,
};

writeFileSync(join(OUT, 'CERNUM-REQ-03-PHASE-6-RESTATEMENT-ROWS.json'), JSON.stringify({
  artifact: 'CERNUM-REQ-03-PHASE-6-RESTATEMENT-ROWS', providerRequestsMade: 0,
  sourceLedgers: LEDGERS, scoringPolicyBinding: { generation: binding.generation, catalogDigest: binding.catalogDigest },
  rows: restated.length, eligible: restated.filter((r) => r.eligible).length,
  warnings: WARNINGS, provenance, restated,
}, null, 2) + '\n');

writeFileSync(join(OUT, 'CERNUM-REQ-03-PHASE-6-RESTATEMENT-CHANGE-LEDGER.json'), JSON.stringify({
  artifact: 'CERNUM-REQ-03-PHASE-6-RESTATEMENT-CHANGE-LEDGER',
  statement: 'Every row whose status differs between generation 1 and generation 2. Version-1 artifacts are untouched.',
  version1RowsNotReproduced: notReproduced.map((r) => ({ slotKey: r.slotKey, stored: r.storedStatusVersion1, replayed: r.replayedVersion1 })),
  changedRowCount: changed.length,
  transitions: Object.entries(changed.reduce((acc: Record<string, number>, r) => {
    const k = `${r.replayedVersion1} -> ${r.restatedVersion2}`; acc[k] = (acc[k] ?? 0) + 1; return acc;
  }, {})).sort((a, b) => b[1] - a[1]),
  byCase: Object.entries(changed.reduce((acc: Record<string, number>, r) => { acc[r.caseID] = (acc[r.caseID] ?? 0) + 1; return acc; }, {})).sort((a, b) => b[1] - a[1]),
  byCandidate: Object.entries(changed.reduce((acc: Record<string, number>, r) => { acc[r.candidate] = (acc[r.candidate] ?? 0) + 1; return acc; }, {})).sort((a, b) => b[1] - a[1]),
  warnings: WARNINGS, provenance,
  changed: changed.map((r) => ({ slotKey: r.slotKey, candidate: r.candidate, caseID: r.caseID,
    version1: r.replayedVersion1, version2: r.restatedVersion2,
    governanceV1: r.governanceV1, governanceV2: r.governanceV2, humanVerdict: r.humanVerdict })),
}, null, 2) + '\n');

writeFileSync(join(OUT, 'CERNUM-REQ-03-PHASE-6-RESTATEMENT-RANKINGS.json'), JSON.stringify({
  artifact: 'CERNUM-REQ-03-PHASE-6-RESTATEMENT-RANKINGS',
  intervalMethod: 'Wilson score interval, 95%',
  warnings: WARNINGS, provenance,
  version1: rankV1, version2: rankV2,
  movement: candidates.map((c) => ({ candidate: c, version1Position: posV1.get(c), version2Position: posV2.get(c),
    positionsMoved: (posV1.get(c) ?? 0) - (posV2.get(c) ?? 0) })).sort((a, b) => Math.abs(b.positionsMoved) - Math.abs(a.positionsMoved)),
}, null, 2) + '\n');

writeFileSync(join(OUT, 'CERNUM-REQ-03-PHASE-6-RESTATEMENT-ACCURACY.json'), JSON.stringify({
  artifact: 'CERNUM-REQ-03-PHASE-6-RESTATEMENT-ACCURACY',
  scope: `${adjudicated.length} adjudicated rows only. No accuracy is claimed for any other row.`,
  intervalMethod: 'Wilson score interval, 95%',
  warnings: WARNINGS, provenance,
  overall: { version1: accuracy(adjudicated, (r) => r.replayedVersion1), version2: accuracy(adjudicated, (r) => r.restatedVersion2) },
  perCase: byCase, perCandidate: byCandidate,
}, null, 2) + '\n');

console.log(JSON.stringify({
  rows: restated.length, eligible: restated.filter((r) => r.eligible).length,
  ineligible: restated.filter((r) => !r.eligible).length,
  version1NotReproduced: notReproduced.length,
  changedRows: changed.length,
  adjudicatedRows: adjudicated.length,
  overallV1: accuracy(adjudicated, (r) => r.replayedVersion1),
  overallV2: accuracy(adjudicated, (r) => r.restatedVersion2),
  rankV1: rankV1.map((r) => `${r.candidate} ${r.passRate.pointPercent}%`),
  rankV2: rankV2.map((r) => `${r.candidate} ${r.passRate.pointPercent}%`),
}, null, 2));
