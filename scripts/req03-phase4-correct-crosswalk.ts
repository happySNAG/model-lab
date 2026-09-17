// Cernum · REQ-03 Phase 4 — CORRECTION to the held-out control crosswalk.
//
// The builder predicted the version-1 verdict with a Python re-implementation of `containsPhrase`.
// It disagrees with the real engine on two of eight, for a reason that is itself a finding: under
// method `requiredConcepts` version 1 NEVER CONSULTS `criteria.prohibitedConcepts`, and the Python
// model checked them. The expected verdicts are unchanged — they are judgements about the responses,
// not about the matcher — but every field describing what the evaluator does is recomputed here from
// the engine.

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { caseByID, policyCatalog } from '../src/core/catalog';
import { EvaluationEngine } from '../src/core/engine';
import { evaluateRepaired } from '../src/core/capability-repair';
import { CAPABILITY_SPEC_BY_CASE } from '../src/core/capability-repair-spec';
import { attemptFor } from './req03-phase4-measure';

const ROOT = process.env.CERNUM_EVIDENCE_ROOT ?? '/Volumes/LaCie/MacMini-NemoClaw-Workspace/model-lab-results';
const HELDOUT = join(ROOT, 'pass10-evidence/req03-phase4/controls-held-out');
const CROSS = join(ROOT, 'req03-sealed/CERNUM-REQ-03-HELDOUT-CONTROLS-CROSSWALK.SEALED.json');

const blinded = JSON.parse(readFileSync(join(HELDOUT, 'CERNUM-REQ-03-HELDOUT-CONTROLS-BLINDED.json'), 'utf8'));
const cross = JSON.parse(readFileSync(CROSS, 'utf8'));
const byID = new Map<string, any>(blinded.controls.map((c: any) => [c.controlID, c]));
const engine = new EvaluationEngine(policyCatalog, () => new Date('2026-01-01T00:00:00Z'));

let repairTargets = 0;
const corrections: any[] = [];
for (const x of cross.crosswalk) {
  const b = byID.get(x.controlID)!;
  const c = caseByID(b.caseID)!;
  const policy = policyCatalog.policy(c.scoringPolicyID, c.scoringPolicyVersion)!;
  const v1 = engine.evaluate(attemptFor(b.caseID, 'heldout', b.responseText)).verdict.status;
  const v2 = evaluateRepaired(policy, b.caseID, b.responseText).status;
  const was = x.version1EvaluatorVerdict;
  if (was !== v1) corrections.push({ controlID: x.controlID, predicted: was, actual: v1 });
  x.catalogMethod = policy.method;
  x.version1EvaluatorVerdict = v1;
  x.version1EvaluatorDetail = `computed by the engine under scoring policy version ${policy.version}`;
  x.version1EvaluatorAgreesWithExpected = v1 === x.expectedVerdict;
  x.version2EvaluatorVerdict = v2;
  x.version2EvaluatorAgreesWithExpected = v2 === x.expectedVerdict;
  x.caseHasARepairSpecEntry = CAPABILITY_SPEC_BY_CASE.has(b.caseID);
  x.isARepairTarget = v1 !== x.expectedVerdict;
  if (x.isARepairTarget) repairTargets += 1;
}

cross.repairTargets = repairTargets;
cross.version1MatchesExpected = cross.crosswalk.filter((x: any) => x.version1EvaluatorAgreesWithExpected).length;
cross.version2MatchesExpected = cross.crosswalk.filter((x: any) => x.version2EvaluatorAgreesWithExpected).length;
cross.CORRECTION = {
  correctedAt: '2026-09-17T01:10:00Z',
  what: 'Every field describing evaluator behaviour was recomputed from the engine. Expected verdicts unchanged.',
  builderPredictionsThatWereWrong: corrections,
  why: 'The builder used a Python re-implementation of `containsPhrase` that also consulted '
     + '`criteria.prohibitedConcepts`. Under method `requiredConcepts` the version-1 evaluator does not '
     + 'consult them at all.',
  expectedVerdictsAltered: false,
  responseTextAltered: false,
  blindingIntact: 'The blinded packet carries no expected verdict and was not touched.',
};
cross.MECHANISM_FINDING = {
  id: 'P4-MECH-01',
  finding: 'NO CASE IN THE CATALOG ROUTES TO THE prohibitedConcepts EVALUATOR.',
  detail: 'All 44 cases use one of: requiredConcepts, refusalClassification, orderedConstraints, '
        + 'toolSelection, provenanceLabels, uncertaintyLanguage, structuredSchema, exactMatch, '
        + 'caseDelegation, humanReviewRequired. `prohibitedConceptsEvaluator` is unreachable from the '
        + 'sealed catalog, and the `prohibitedConcepts` several policies declare are read only by '
        + '`uncertaintyLanguage`, which exactly one case uses.',
  consequence: 'A control labelled "prohibitedConcepts family" on a requiredConcepts case does not '
             + 'exercise the prohibited mechanism under version 1, because nothing reads it. This is '
             + 'true of these fresh controls AND of the four Phase 3 controls carrying the same label.',
  affectsPhase3: 'Recorded, not acted on. It does not move a Phase 3 rate: those controls calibrate the '
               + 'ADJUDICATOR, and a person ruling on a response is unaffected by which evaluator would '
               + 'have read it.',
  raisedNotResolved: true,
};
writeFileSync(CROSS, JSON.stringify(cross, null, 1) + '\n');

// Re-issue the checksum file over the corrected bytes.
const files = [
  join(HELDOUT, 'CERNUM-REQ-03-HELDOUT-CONTROLS-BLINDED.json'),
  join(HELDOUT, 'CERNUM-REQ-03-HELDOUT-CONTROLS-ANSWER-SHEET-BLANK.json'),
  CROSS,
  join(ROOT, 'req03-sealed/CERNUM-REQ-03-HELDOUT-CONTROLS-IDENTITY-MAP.SEALED.json'),
  join(ROOT, 'req03-sealed/CERNUM-REQ-03-HELDOUT-CONTROLS-SECRET.SEALED.txt'),
];
writeFileSync(join(HELDOUT, 'CERNUM-REQ-03-HELDOUT-CONTROLS-SHA256SUMS.txt'),
  files.map((f) => `${createHash('sha256').update(readFileSync(f)).digest('hex')}  ${f.split('/').pop()}\n`).join(''));

console.log(`corrected ${corrections.length} wrong predictions:`);
for (const c of corrections) console.log(`  ${c.controlID}: builder said ${c.predicted}, engine says ${c.actual}`);
console.log(`repair targets (v1 wrong): ${repairTargets}/8`);
console.log(`v1 matches expected: ${cross.version1MatchesExpected}/8 · v2 matches expected: ${cross.version2MatchesExpected}/8`);
console.log(`P4-MECH-01 recorded in the sealed crosswalk.`);
