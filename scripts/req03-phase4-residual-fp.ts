import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { caseByID, policyCatalog } from '../src/core/catalog';
import { EvaluationEngine } from '../src/core/engine';
import { evaluateRepaired, OUT_OF_SCOPE_METHODS } from '../src/core/capability-repair';
import { adjudicated, attemptFor } from './req03-phase4-measure';
const ROOT = process.env.CERNUM_EVIDENCE_ROOT ?? '/Volumes/LaCie/MacMini-NemoClaw-Workspace/model-lab-results';
const ledger = new Map<string, any>();
for (const p of ['pass08-evidence/campaign-a2/results.jsonl', 'pass08-evidence/campaign-b2/results.jsonl'])
  for (const line of readFileSync(join(ROOT, p), 'utf8').split('\n')) { if (line.trim()) { const r = JSON.parse(line); ledger.set(r.slotKey, r); } }
const engine = new EvaluationEngine(policyCatalog, () => new Date('2026-01-01T00:00:00Z'));
for (const a of adjudicated) {
  const c = caseByID(a.caseID)!;
  const policy = policyCatalog.policy(c.scoringPolicyID, c.scoringPolicyVersion)!;
  if (OUT_OF_SCOPE_METHODS.has(policy.method)) continue;
  const text = ledger.get(a.slotKey).answerText ?? '';
  const rep = evaluateRepaired(policy, a.caseID, text);
  if (!(a.verdict === 'pass' && rep.status !== 'pass')) continue;
  console.log(`\n=== ${a.decisionID} ${a.caseID} human=pass v2=${rep.status}`);
  console.log(`V2: ${rep.detail}`);
  console.log(`ANSWER: ${JSON.stringify(text.slice(0, 300))}`);
}
