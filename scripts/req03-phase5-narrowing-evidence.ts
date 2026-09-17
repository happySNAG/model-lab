// REQ-03 Phase 5 — publish the evidence the narrowing decision rests on.
// Read-only over sealed records; writes one evidence artifact under req03-phase5/narrowing/.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { caseByID, policyCatalog } from '../src/core/catalog';
import { EvaluationEngine } from '../src/core/engine';
import { evaluateRepaired, repairedProhibitedConcept } from '../src/core/capability-repair';
import { narrowedRepairStatus, NARROWED_CASES, NARROWING_ID, NARROWING_AUTHORITY } from '../src/core/capability-repair-narrowing';
import { adjudicated, attemptFor } from './req03-phase4-measure';

const ROOT = process.env.CERNUM_EVIDENCE_ROOT ?? '/Volumes/LaCie/MacMini-NemoClaw-Workspace/model-lab-results';
const ledger = new Map<string, any>();
for (const p of ['pass08-evidence/campaign-a2/results.jsonl', 'pass08-evidence/campaign-b2/results.jsonl']) {
  for (const line of readFileSync(join(ROOT, p), 'utf8').split('\n')) {
    if (line.trim().length === 0) continue;
    const r = JSON.parse(line); ledger.set(r.slotKey, r);
  }
}
const engine = new EvaluationEngine(policyCatalog, () => new Date('2026-01-01T00:00:00Z'));

const cases = NARROWED_CASES.map((n) => {
  const c = caseByID(n.caseID)!;
  const policy = policyCatalog.policy(c.scoringPolicyID, c.scoringPolicyVersion)!;
  const rows = adjudicated.filter((r: any) => r.caseID === n.caseID).map((a: any) => {
    const text = ledger.get(a.slotKey)?.answerText ?? '';
    const v1 = engine.evaluate(attemptFor(a.caseID, a.candidate, text)).verdict.status;
    const rep = evaluateRepaired(policy, a.caseID, text);
    const v2n = narrowedRepairStatus(a.caseID, v1 as any, rep.status).status;
    const prohibitedHits = policy.criteria.prohibitedConcepts
      .map((p: any) => ({ label: p.label, ...repairedProhibitedConcept(p, text, true) }))
      .filter((e: any) => e.present)
      .map((e: any) => `${e.label}:${e.form}`);
    return {
      decisionID: a.decisionID, humanVerdict: a.verdict, version1: v1, version2: rep.status, version2Narrowed: v2n,
      repairMatchedBy: rep.evidence.map((e) => `${e.label}=${e.present ? e.by : 'absent'}`),
      declaredProhibitedConceptsThatFired: prohibitedHits,
      role: a.verdict !== 'pass' && v1 !== 'pass' && rep.status === 'pass' ? 'PROTECTED — a person ruled it short and the repair passed it'
          : a.verdict === 'pass' && v1 !== 'pass' && rep.status === 'pass' ? 'CONCEDED — the repair improved it and the narrowing gives it up'
          : 'unchanged by the narrowing',
    };
  });
  return {
    caseID: n.caseID,
    method: policy.method,
    declaredRequiredConcepts: policy.criteria.requiredConcepts.map((x: any) => ({ label: x.label, anyOf: x.anyOf })),
    declaredProhibitedConcepts: policy.criteria.prohibitedConcepts.map((x: any) => ({ label: x.label, anyOf: x.anyOf })),
    prohibitedConceptFiredOnAnyRow: rows.some((r) => r.declaredProhibitedConceptsThatFired.length > 0),
    mechanismWithdrawn: n.mechanismWithdrawn,
    whyNotFiner: n.whyNotFiner,
    rows,
  };
});

const artifact = {
  evidenceFormatVersion: 1,
  artifact: 'CERNUM-REQ-03-PHASE-5-NARROWING-EVIDENCE',
  computedAt: '2026-09-16T21:05:00Z',
  narrowingID: NARROWING_ID,
  authority: NARROWING_AUTHORITY,
  question: 'Is there a finer separator than whole-case withdrawal — one that keeps the rows a person '
    + 'ruled short below pass while preserving the rows the repair correctly improved — using ONLY the '
    + 'criteria the adopted requirement statements already declare?',
  answer: 'No. In both cases the protected and conceded rows are matched by the repair through the same '
    + 'mechanism, and the declared prohibited concept fires on no row at all. Any separator would have to '
    + 'encode a standard the adopted requirement does not contain, which the ruling forbids.',
  method: 'Every adjudicated row in both cases was replayed under version 1, the repair, and the narrowed '
    + 'repair, and each case’s own declared prohibited concepts were evaluated with assertion scoping.',
  cases,
  whatWasNotDone: [
    'No adopted requirement statement was amended, rewritten or broadened.',
    'No sealed ruling was altered.',
    'No new criterion was invented to separate the rows.',
    'No published rate was recomputed.',
  ],
  provenance: { source: 'human', modelParticipation: 'advisory', finalDecisionMaker: 'Seth J. Leopold' },
};

const out = join(ROOT, 'pass10-evidence/req03-phase5/narrowing');
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'CERNUM-REQ-03-PHASE-5-NARROWING-EVIDENCE.json'), JSON.stringify(artifact, null, 1) + '\n');
console.log(JSON.stringify({
  cases: cases.map((c) => ({
    caseID: c.caseID, rows: c.rows.length,
    prohibitedConceptFiredOnAnyRow: c.prohibitedConceptFiredOnAnyRow,
    protected: c.rows.filter((r) => r.role.startsWith('PROTECTED')).length,
    conceded: c.rows.filter((r) => r.role.startsWith('CONCEDED')).length,
  })),
}, null, 1));
