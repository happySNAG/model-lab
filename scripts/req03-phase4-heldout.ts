import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { caseByID, policyCatalog } from '../src/core/catalog';
import { EvaluationEngine } from '../src/core/engine';
import { evaluateRepaired } from '../src/core/capability-repair';
import { CAPABILITY_SPEC_BY_CASE } from '../src/core/capability-repair-spec';
import { attemptFor } from './req03-phase4-measure';

const ROOT = process.env.CERNUM_EVIDENCE_ROOT ?? '/Volumes/LaCie/MacMini-NemoClaw-Workspace/model-lab-results';
const blinded = JSON.parse(readFileSync(join(ROOT, 'pass10-evidence/req03-phase4/controls-held-out/CERNUM-REQ-03-HELDOUT-CONTROLS-BLINDED.json'), 'utf8'));
const cross = JSON.parse(readFileSync(join(ROOT, 'req03-sealed/CERNUM-REQ-03-HELDOUT-CONTROLS-CROSSWALK.SEALED.json'), 'utf8'));
const expected = new Map<string, any>(cross.crosswalk.map((c: any) => [c.controlID, c]));
const engine = new EvaluationEngine(policyCatalog, () => new Date('2026-01-01T00:00:00Z'));

console.log('HELD-OUT CONTROLS · does the repair generalize to cases it was never shown?\n');
console.log('control'.padEnd(16) + 'family'.padEnd(20) + 'variant'.padEnd(20) + 'expect  v1      v2      spec?');
let v1ok = 0, v2ok = 0;
for (const b of blinded.controls) {
  const x = expected.get(b.controlID)!;
  const c = caseByID(b.caseID)!;
  const policy = policyCatalog.policy(c.scoringPolicyID, c.scoringPolicyVersion)!;
  const v1 = engine.evaluate(attemptFor(b.caseID, 'heldout', b.responseText)).verdict.status;
  const v2 = evaluateRepaired(policy, b.caseID, b.responseText).status;
  const hasSpec = CAPABILITY_SPEC_BY_CASE.has(b.caseID);
  if (v1 === x.expectedVerdict) v1ok += 1;
  if (v2 === x.expectedVerdict) v2ok += 1;
  console.log(`${b.controlID.padEnd(16)}${x.mechanismFamily.padEnd(20)}${(x.controlFamily + '/' + x.variant).padEnd(20)}${x.expectedVerdict.padEnd(8)}${v1.padEnd(8)}${v2.padEnd(8)}${hasSpec ? 'yes' : 'NO'}`);
}
console.log(`\n  v1 matches the sealed expectation on ${v1ok}/8`);
console.log(`  v2 matches the sealed expectation on ${v2ok}/8`);
console.log(`\n  NOTE: these expectations are the PACKET AUTHOR'S, not the adjudicator's. Eight human`);
console.log(`  rulings are outstanding, and until they are recorded this is a measurement of the repair`);
console.log(`  against a proposed answer key — not a passed held-out check.`);
