import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalize } from '../src/core/text';
import { adjudicated } from './req03-phase4-measure';
const ROOT = process.env.CERNUM_EVIDENCE_ROOT ?? '/Volumes/LaCie/MacMini-NemoClaw-Workspace/model-lab-results';
const ledger = new Map<string, any>();
for (const p of ['pass08-evidence/campaign-a2/results.jsonl', 'pass08-evidence/campaign-b2/results.jsonl'])
  for (const line of readFileSync(join(ROOT, p), 'utf8').split('\n')) { if (line.trim()) { const r = JSON.parse(line); ledger.set(r.slotKey, r); } }
const FORMS: Record<string, string[]> = { backup: ['back up', 'backup'], migrate: ['migrate', 'migration'], verify: ['verify', 'check', 'confirm'] };
for (const id of ['P2-f1c807facb1b', 'P2-4c7fa325b91e']) {
  const a = adjudicated.find((x) => x.decisionID === id)!;
  const h = normalize(ledger.get(a.slotKey).answerText ?? '');
  console.log(`\n=== ${id}  (normalized length ${h.length})`);
  for (const [label, forms] of Object.entries(FORMS)) {
    const at: number[] = [];
    for (const f of forms) { let i = 0; for (;;) { const k = h.indexOf(normalize(f), i); if (k < 0) break; at.push(k); i = k + 1; } }
    console.log(`  ${label.padEnd(8)} at ${[...new Set(at)].sort((x, y) => x - y).join(', ')}`);
  }
  console.log('  TAIL:', JSON.stringify(h.slice(-300)));
}
