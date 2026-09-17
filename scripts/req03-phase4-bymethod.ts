import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
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

const byMethod = new Map<string, { n: number; fp: number; fn: number; cases: Set<string> }>();
for (const a of adjudicated) {
  const led = ledger.get(a.slotKey);
  const c = caseByID(a.caseID)!;
  const policy = policyCatalog.policy(c.scoringPolicyID, c.scoringPolicyVersion)!;
  const v1 = engine.evaluate(attemptFor(a.caseID, a.candidate, led.answerText ?? '')).verdict.status;
  const key = policy.method;
  const e = byMethod.get(key) ?? { n: 0, fp: 0, fn: 0, cases: new Set<string>() };
  e.n += 1;
  if (v1 !== 'pass' && a.verdict === 'pass') { e.fp += 1; e.cases.add(a.caseID); }
  if (v1 === 'pass' && a.verdict !== 'pass') { e.fn += 1; e.cases.add(a.caseID); }
  byMethod.set(key, e);
}
console.log('method'.padEnd(26) + '  n   FP   FN  cases-with-error');
for (const [m, e] of [...byMethod.entries()].sort((a, b) => b[1].fp - a[1].fp)) {
  console.log(`${m.padEnd(26)}${String(e.n).padStart(4)}${String(e.fp).padStart(5)}${String(e.fn).padStart(5)}  ${e.cases.size}`);
}
