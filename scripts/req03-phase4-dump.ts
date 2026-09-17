import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { caseByID, policyCatalog } from '../src/core/catalog';
import { EvaluationEngine } from '../src/core/engine';
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
const want = process.argv[2];   // method filter

for (const a of adjudicated) {
  const c = caseByID(a.caseID)!;
  const policy = policyCatalog.policy(c.scoringPolicyID, c.scoringPolicyVersion)!;
  if (want && policy.method !== want) continue;
  const led = ledger.get(a.slotKey);
  const v1 = engine.evaluate(attemptFor(a.caseID, a.candidate, led.answerText ?? '')).verdict.status;
  if (!(v1 !== 'pass' && a.verdict === 'pass')) continue;   // false positives only
  console.log(`\n### ${a.caseID}  [${a.decisionID}] v1=${v1} human=pass`);
  console.log(`ANSWER: ${JSON.stringify((led.answerText ?? '').slice(0, 420))}`);
}
