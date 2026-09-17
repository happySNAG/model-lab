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
const engine = new EvaluationEngine(policyCatalog, () => new Date('2026-01-01T00:00:00Z'));

interface Row { caseID: string; method: string; v1: string; v2: string; human: string; decisionID: string; inScope: boolean }
const rows: Row[] = [];
for (const a of adjudicated) {
  const led = ledger.get(a.slotKey);
  const c = caseByID(a.caseID)!;
  const policy = policyCatalog.policy(c.scoringPolicyID, c.scoringPolicyVersion)!;
  const text = led.answerText ?? '';
  const v1 = engine.evaluate(attemptFor(a.caseID, a.candidate, text)).verdict.status;
  const inScope = !OUT_OF_SCOPE_METHODS.has(policy.method);
  const v2 = inScope ? evaluateRepaired(policy, a.caseID, text).status : v1;
  rows.push({ caseID: a.caseID, method: policy.method, v1, v2, human: a.verdict, decisionID: a.decisionID, inScope });
}

function tally(pick: (r: Row) => string, only?: (r: Row) => boolean) {
  const rs = only ? rows.filter(only) : rows;
  let fp = 0, fn = 0, ok = 0;
  for (const r of rs) {
    const ep = pick(r) === 'pass', hp = r.human === 'pass';
    if (ep === hp) ok += 1; else if (!ep && hp) fp += 1; else fn += 1;
  }
  return { n: rs.length, ok, fp, fn };
}

const inScope = (r: Row) => r.inScope;
console.log('ALL 350 ROWS');
console.log('  v1', JSON.stringify(tally((r) => r.v1)));
console.log('  v2', JSON.stringify(tally((r) => r.v2)));
console.log('\nIN-SCOPE ROWS ONLY (the concept-matching primitive)');
console.log('  v1', JSON.stringify(tally((r) => r.v1, inScope)));
console.log('  v2', JSON.stringify(tally((r) => r.v2, inScope)));

console.log('\nOVER-CORRECTION CHECK — rows a person did NOT pass');
const rejected = rows.filter((r) => r.human !== 'pass');
const v1Held = rejected.filter((r) => r.v1 !== 'pass').length;
const v2Held = rejected.filter((r) => r.v2 !== 'pass').length;
const newlyLeaked = rejected.filter((r) => r.v1 !== 'pass' && r.v2 === 'pass');
console.log(`  ${rejected.length} rows a person ruled short. v1 held ${v1Held}, v2 holds ${v2Held}.`);
console.log(`  NEW false negatives introduced by the repair: ${newlyLeaked.length}`);
for (const r of newlyLeaked) console.log(`    ${r.decisionID} ${r.caseID} human=${r.human} v1=${r.v1} v2=${r.v2}`);

console.log('\nPER CASE (in-scope cases that moved)');
const byCase = new Map<string, Row[]>();
for (const r of rows) { const a = byCase.get(r.caseID) ?? []; a.push(r); byCase.set(r.caseID, a); }
console.log('case'.padEnd(52) + '  n  v1FP v1FN  v2FP v2FN');
let residual: string[] = [];
for (const [cid, rs] of [...byCase.entries()].sort()) {
  const t1 = tally((r) => r.v1, (r) => r.caseID === cid);
  const t2 = tally((r) => r.v2, (r) => r.caseID === cid);
  if (t1.fp + t1.fn + t2.fp + t2.fn === 0) continue;
  if (t2.fp + t2.fn > 0) residual.push(`${cid} (FP ${t2.fp}, FN ${t2.fn}, ${rs[0].inScope ? 'in scope' : 'OUT OF SCOPE'})`);
  console.log(`${cid.padEnd(52)}${String(t1.n).padStart(3)}${String(t1.fp).padStart(6)}${String(t1.fn).padStart(5)}${String(t2.fp).padStart(6)}${String(t2.fn).padStart(5)}`);
}
console.log('\nRESIDUAL after the repair:');
for (const r of residual) console.log('  ' + r);
