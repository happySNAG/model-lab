// REQ-03 Phase 5 — probe: does each case's OWN declared prohibited criterion separate the
// over-corrected rows from the rows the repair correctly improved? Read-only; writes nothing.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { caseByID, policyCatalog } from '../src/core/catalog';
import { EvaluationEngine } from '../src/core/engine';
import { evaluateRepaired, repairedProhibitedConcept } from '../src/core/capability-repair';
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
for (const caseID of ['case:emotional-understanding:non-diagnostic', 'case:conversation:no-invented-continuity']) {
  const c = caseByID(caseID)!;
  const policy = policyCatalog.policy(c.scoringPolicyID, c.scoringPolicyVersion)!;
  console.log('\n===', caseID);
  for (const p of policy.criteria.prohibitedConcepts) console.log('  prohibited', p.label, JSON.stringify(p.anyOf));
  for (const a of adjudicated.filter((r: any) => r.caseID === caseID)) {
    const text = ledger.get(a.slotKey)?.answerText ?? '';
    const v1 = engine.evaluate(attemptFor(a.caseID, a.candidate, text)).verdict.status;
    const v2 = evaluateRepaired(policy, a.caseID, text).status;
    const hits: string[] = [];
    for (const p of policy.criteria.prohibitedConcepts) {
      const e = repairedProhibitedConcept(p, text, true);
      if (e.present) hits.push(`${p.label}:${e.form}`);
    }
    const oc = a.verdict !== 'pass' && v1 !== 'pass' && v2 === 'pass';
    console.log(`  ${a.decisionID} human=${a.verdict} v1=${v1} v2=${v2} ${oc ? 'OVERCORRECTION' : ''} prohibitedHits=${JSON.stringify(hits)}`);
  }
}
