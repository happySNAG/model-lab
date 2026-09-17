import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { caseByID, policyCatalog } from '../src/core/catalog';
import { EvaluationEngine } from '../src/core/engine';
import { evaluateRepaired, OUT_OF_SCOPE_METHODS } from '../src/core/capability-repair';
import { adjudicated, attemptFor } from './req03-phase4-measure';

const ROOT = process.env.CERNUM_EVIDENCE_ROOT ?? '/Volumes/LaCie/MacMini-NemoClaw-Workspace/model-lab-results';
const ledger = new Map<string, any>();
for (const p of ['pass08-evidence/campaign-a2/results.jsonl', 'pass08-evidence/campaign-b2/results.jsonl']) {
  for (const line of readFileSync(join(ROOT, p), 'utf8').split('\n')) {
    if (line.trim().length === 0) continue;
    const r = JSON.parse(line); ledger.set(r.slotKey, r);
  }
}
// the human rationales
const rationale = new Map<string, string>();
for (const f of ['req03-phase1/rulings/CERNUM-REQ-03-PHASE-1-RULINGS-LIVE-120-AS-SUBMITTED.json',
                 'req03-phase2/rulings/CERNUM-REQ-03-PHASE-2-RULINGS-LIVE-110-EFFECTIVE.json',
                 'req03-phase3/rulings/CERNUM-REQ-03-PHASE-3-RULINGS-LIVE-120-AS-SUBMITTED.json']) {
  for (const r of JSON.parse(readFileSync(join(ROOT, 'pass10-evidence', f), 'utf8')).rulings) rationale.set(r.decisionID, r.rationale);
}
const engine = new EvaluationEngine(policyCatalog, () => new Date('2026-01-01T00:00:00Z'));

for (const a of adjudicated) {
  const led = ledger.get(a.slotKey);
  const c = caseByID(a.caseID)!;
  const policy = policyCatalog.policy(c.scoringPolicyID, c.scoringPolicyVersion)!;
  const text = led.answerText ?? '';
  if (OUT_OF_SCOPE_METHODS.has(policy.method)) continue;
  const v1 = engine.evaluate(attemptFor(a.caseID, a.candidate, text)).verdict.status;
  const rep = evaluateRepaired(policy, a.caseID, text);
  if (!(a.verdict !== 'pass' && v1 !== 'pass' && rep.status === 'pass')) continue;
  console.log(`\n=== ${a.decisionID} ${a.caseID}  human=${a.verdict} v1=${v1} v2=pass`);
  console.log(`HUMAN SAID: ${rationale.get(a.decisionID)}`);
  console.log(`V2 SAID:    ${rep.detail}`);
  for (const e of rep.evidence) if (e.present) console.log(`   matched '${e.label}' by ${e.by}: ${JSON.stringify(e.form)}${e.sentence ? ` in ${JSON.stringify(e.sentence.slice(0,110))}` : ''}`);
  console.log(`ANSWER: ${JSON.stringify(text.slice(0, 330))}`);
}
