// REQ-03 Phase 5 — evidence for the narrowed repair. Read-only analysis; writes nothing.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { caseByID, policyCatalog } from '../src/core/catalog';
import { EvaluationEngine } from '../src/core/engine';
import { evaluateRepaired } from '../src/core/capability-repair';
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
const CASES = ['case:emotional-understanding:non-diagnostic', 'case:conversation:no-invented-continuity'];

for (const caseID of CASES) {
  const c = caseByID(caseID)!;
  const policy = policyCatalog.policy(c.scoringPolicyID, c.scoringPolicyVersion)!;
  console.log('\n================================================================');
  console.log(caseID, '| method:', policy.method);
  console.log('required:', policy.criteria.requiredConcepts.map((x: any) => x.label + ' :: ' + JSON.stringify(x.anyOf)).join('\n          '));
  console.log('prohibited:', JSON.stringify(policy.criteria.prohibitedConcepts.map((x: any) => x.label)));
  for (const a of adjudicated.filter((r: any) => r.caseID === caseID)) {
    const text = ledger.get(a.slotKey)?.answerText ?? '';
    const v1 = engine.evaluate(attemptFor(a.caseID, a.candidate, text)).verdict.status;
    const rep = evaluateRepaired(policy, a.caseID, text);
    const flip = a.verdict !== 'pass' && v1 !== 'pass' && rep.status === 'pass';
    console.log(`\n--- ${a.decisionID} human=${a.verdict} v1=${v1} v2=${rep.status}${flip ? '  <<< OVERCORRECTION' : ''}`);
    for (const e of rep.evidence) {
      console.log(`    evid ${e.label}: present=${e.present} by=${e.by} form=${JSON.stringify(e.form ?? null)}`);
      if (e.sentence) console.log(`         sentence: ${JSON.stringify(e.sentence)}`);
    }
    console.log('    TEXT: ' + JSON.stringify(text.slice(0, 700)));
  }
}
