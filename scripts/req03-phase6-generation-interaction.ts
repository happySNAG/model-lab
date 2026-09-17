// Cernum REQ-03 Phase 6 — what happens when Gate D and the narrowed repair are ONE generation.
//
// Phase 5's adoption gate measured the capability repair against version-1 governance. Gate D measured
// the hybrid governance matcher against version-1 capability scoring. Generation 2 carries BOTH. This
// script measures the combination on the 350 adjudicated rows, so the interaction is evidence rather
// than an assumption.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { caseByID, policyCatalog, registeredSuites } from '../src/core/catalog';
import { EvaluationEngine } from '../src/core/engine';
import { evaluateRepaired, OUT_OF_SCOPE_METHODS } from '../src/core/capability-repair';
import { narrowedRepairStatus } from '../src/core/capability-repair-narrowing';
import { bindSuiteToGeneration, SCORING_POLICY_GENERATION_1 as G1 } from '../src/core/campaign-binding';
import { SCORING_POLICY_GENERATION_1, SCORING_POLICY_GENERATION_2 } from '../src/core/capability-generation';
import { AttemptRecord, Observation } from '../src/core/run';

const ROOT = process.env.CERNUM_EVIDENCE_ROOT ?? '/Volumes/LaCie/MacMini-NemoClaw-Workspace/model-lab-results';
const read = (p: string) => readFileSync(join(ROOT, p));
const readJSON = (p: string) => JSON.parse(read(p).toString('utf8'));

const ledger = new Map<string, { answerText: string; caseID: string; candidate: string }>();
for (const p of ['pass08-evidence/campaign-a2/results.jsonl', 'pass08-evidence/campaign-b2/results.jsonl']) {
  for (const line of read(p).toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    ledger.set(r.slotKey, { answerText: r.answerText ?? '', caseID: r.caseID, candidate: r.candidate });
  }
}

interface Row { decisionID: string; caseID: string; candidate: string; answerText: string; sealed: string; human: string }
const live: Row[] = [];
for (const [rul, map] of [
  ['pass10-evidence/req03-phase1/rulings/CERNUM-REQ-03-PHASE-1-RULINGS-LIVE-120-AS-SUBMITTED.json', 'req03-sealed/CERNUM-REQ-03-PHASE-1-IDENTITY-MAP.SEALED.json'],
  ['pass10-evidence/req03-phase2/rulings/CERNUM-REQ-03-PHASE-2-RULINGS-LIVE-110-EFFECTIVE.json', 'req03-sealed/CERNUM-REQ-03-PHASE-2-IDENTITY-MAP.SEALED.json'],
  ['pass10-evidence/req03-phase3/rulings/CERNUM-REQ-03-PHASE-3-RULINGS-LIVE-120-AS-SUBMITTED.json', 'req03-sealed/CERNUM-REQ-03-PHASE-3-IDENTITY-MAP.SEALED.json'],
] as const) {
  const rulings = readJSON(rul).rulings as any[];
  const m = readJSON(map);
  const entries: any[] = Array.isArray(m) ? m : (m.entries ?? m.identities ?? m.rows ?? m.map ?? []);
  const byDecision = new Map(entries.map((e: any) => [e.decisionID ?? e.decisionId, e]));
  for (const r of rulings) {
    const e = byDecision.get(r.decisionID)!;
    const led = ledger.get(e.slotKey)!;
    live.push({ decisionID: r.decisionID, caseID: led.caseID, candidate: led.candidate, answerText: led.answerText,
                sealed: e.evaluatorStatusAtSealing ?? e.evaluatorStatus ?? e.statusAtSealing, human: r.verdict });
  }
}

const engine = new EvaluationEngine(policyCatalog, () => new Date('2026-01-01T00:00:00Z'));
const obs = (t: string) => ({ outputText: t, toolCallObservationsRaw: [], terminalStatus: 'completed',
  providerReportedUsage: { unavailableReason: 'replay' },
  timing: { startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-01T00:00:00Z', durationMilliseconds: { measured: 0 } },
  warnings: [], errors: [], identityVerification: { state: 'unverifiable', reportedModelID: { unavailableReason: 'replay' }, requestedModelID: '' },
  runtimeConfigurationID: 'replay', requestDigest: 'replay' } as unknown as Observation);

function bound(caseID: string, gen: string) {
  const suite = registeredSuites.find((s) => s.cases.some((c) => c.id.raw === caseID))!;
  return bindSuiteToGeneration(suite, gen, policyCatalog).cases.find((c) => c.id.raw === caseID)!;
}
function attempt(caseID: string, candidate: string, text: string, gen: string): AttemptRecord {
  const c = bound(caseID, gen);
  return { attemptID: 'r', runID: 'r', ordinal: 0, repetitionIndex: 1, candidate: { id: { raw: candidate } }, candidateDigest: 'r',
    suiteID: c.suiteID, suiteVersion: c.suiteVersion, caseID: c.id, caseDigest: 'r', inputPackage: c.inputs, inputPackageDigest: 'r',
    scoringPolicyID: c.scoringPolicyID, scoringPolicyVersion: c.scoringPolicyVersion, environment: {} as any, observation: obs(text),
    terminalStatus: 'completed', comparabilityKey: 'r', startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:00:00Z' } as unknown as AttemptRecord;
}

const rows = live.map((r) => {
  const g1v = engine.evaluate(attempt(r.caseID, r.candidate, r.answerText, SCORING_POLICY_GENERATION_1)).verdict;
  const g2v = engine.evaluate(attempt(r.caseID, r.candidate, r.answerText, SCORING_POLICY_GENERATION_2)).verdict;
  const policy = policyCatalog.policy(caseByID(r.caseID)!.scoringPolicyID, SCORING_POLICY_GENERATION_1)!;
  const inScope = !OUT_OF_SCOPE_METHODS.has(policy.method);
  const rep = inScope ? evaluateRepaired(policy, r.caseID, r.answerText).status : g1v.status;
  const capOnly = narrowedRepairStatus(r.caseID, g1v.status as any, rep as any).status;
  return { ...r, g1: g1v.status, g1gov: g1v.governance.state, g2: g2v.status, g2gov: g2v.governance.state, capOnly, governed: policy.hardGovernance?.ruleID };
});

const capVsGen2 = rows.filter((r) => r.capOnly !== r.g2);
const govChanged = rows.filter((r) => r.g1gov !== r.g2gov);
const byCase = new Map<string, number>();
for (const r of capVsGen2) byCase.set(r.caseID, (byCase.get(r.caseID) ?? 0) + 1);
const byRule = new Map<string, number>();
for (const r of govChanged) byRule.set(r.governed ?? 'none', (byRule.get(r.governed ?? 'none') ?? 0) + 1);

function rate(pick: (r: typeof rows[0]) => string) {
  let fp = 0, fn = 0, ok = 0, held = 0;
  for (const r of rows) {
    const s = pick(r);
    if (s === 'requiresHumanReview') { held += 1; continue; }
    const ep = s === 'pass', hp = r.human === 'pass';
    if (ep === hp) ok += 1; else if (!ep && hp) fp += 1; else fn += 1;
  }
  const n = rows.length - held;
  return { scored: n, withheldForHumanReview: held, agree: ok, falsePositive: fp, falseNegative: fn,
           falsePositivePercent: n ? Number(((100 * fp) / n).toFixed(2)) : 0 };
}

console.log(JSON.stringify({
  artifact: 'CERNUM-REQ-03-PHASE-6-GENERATION-INTERACTION',
  rowsMeasured: rows.length,
  finding: 'Generation 2 carries BOTH adopted corrections. Neither adoption gate measured the combination.',
  capabilityRepairOnly_vs_generation2: {
    rowsThatDiffer: capVsGen2.length,
    byCase: [...byCase].map(([c, n]) => ({ caseID: c, rows: n })),
    allDifferencesAre: [...new Set(capVsGen2.map((r) => `${r.capOnly} -> ${r.g2}`))],
  },
  governanceOutcomeChanges_generation1_to_2: {
    rowsThatDiffer: govChanged.length,
    byRule: [...byRule].map(([r, n]) => ({ ruleID: r, rows: n })),
    transitions: [...new Set(govChanged.map((r) => `${r.g1gov} -> ${r.g2gov}`))],
  },
  rates: {
    generation1: rate((r) => r.g1),
    capabilityRepairOnly_asPhase5Measured: rate((r) => r.capOnly),
    generation2_asRouted: rate((r) => r.g2),
  },
}, null, 2));
