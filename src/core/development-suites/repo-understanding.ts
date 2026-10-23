// Cernum core · the repository-understanding suite.
//
// WHAT THIS DIMENSION IS. Not "can the model read a file" — every model can read a file. It is
// whether a model dropped into an unfamiliar repository forms a CORRECT MODEL OF THE RELATIONSHIPS
// between its files: which of two plausible files actually does the work, what the request touches
// on its way through, which file is authoritative and which is downstream of it, which tests are
// the ones that matter, and — the failure that costs the most in practice — whether it will name a
// file confidently when it has no reason to name any file at all.
//
// EVERY ANSWER IS A JSON OBJECT, AND EVERY ASSERTION IS A PREDICATE OVER IT. There is no prose
// judging here and no model judge. A path is right or it is not; an ordered list matches or it does
// not; a list that should be empty is empty or it is not. That is what makes two providers'
// numbers comparable — and it is also why each prompt spells out the exact shape of the object it
// wants, including how to spell a path.
//
// WHY THE PROMPTS ARE FUSSY ABOUT SCOPE. A question with two defensible readings measures which
// reading the model guessed, not whether it understood the repository. So "every module the request
// passes through" says in the prompt that data files and configuration lookups are excluded, and
// "which files must change" says documentation is out of scope. Narrowing the question is how the
// answer is made checkable without making it easier.
//
// HELD OUT VERSUS STATED. A prompt that says "the answer is src/core/charge-pipeline.js" would
// measure transcription. Every assertion whose content the prompt does not give away is marked
// `heldOut`, and the validator refuses a task that has none.

import { DevelopmentAssertion } from '../development-assertions';
import {
  DEVELOPMENT_ANSWER_PATH, DevelopmentSuite, DevelopmentTask, makeDevelopmentSuite, makeDevelopmentTask,
} from '../development-benchmark';
import { DEVELOPMENT_SCORING_CONTRACT_ID, DEVELOPMENT_SCORING_CONTRACT_VERSION } from '../development-scoring';
import { ledgerlite } from '../development-fixtures/ledgerlite';
import { fixtureRepoDigest } from '../development-fixture';
import { AnswerShape } from '../json';

export const REPO_UNDERSTANDING_SUITE_ID = 'suite.cernum.development.repo-understanding';
export const REPO_UNDERSTANDING_SUITE_VERSION = '1';

const PROVENANCE = 'cernum-development-pass (synthetic; original ledgerlite fixture)';

const SYSTEM_PROMPT =
  'You are being evaluated inside Cernum on a synthetic fixture repository. The repository you have '
  + 'been given is the only material that exists for this task: nothing outside it is real, and no '
  + 'package registry, documentation site or memory of a similar project applies to it. '
  + 'Answer with a single JSON object and nothing else — no prose before it and none after it. '
  + 'Write every path exactly as it appears in the repository, relative to its root, with forward slashes.';

/** Every assertion in this suite reads the recorded answer; nothing here touches the repository. */
const answer = DEVELOPMENT_ANSWER_PATH;

function task(fields: {
  slug: string;
  capabilityUnderTest: string;
  user: string;
  /** The shape the prompt's "Answer with exactly this shape" line states, written down for the grader. */
  answerShape: AnswerShape;
  assertions: DevelopmentAssertion[];
  tags: string[];
}): DevelopmentTask {
  return makeDevelopmentTask({
    id: `task.dev.repo-understanding.${fields.slug}`,
    suiteID: REPO_UNDERSTANDING_SUITE_ID,
    suiteVersion: REPO_UNDERSTANDING_SUITE_VERSION,
    dimension: 'repositoryUnderstanding',
    kind: 'repositoryQuestion',
    capabilityUnderTest: fields.capabilityUnderTest,
    fixtureRepoID: ledgerlite.id,
    fixtureRepoVersion: ledgerlite.version,
    fixtureRepoDigest: fixtureRepoDigest(ledgerlite),
    prompt: { system: SYSTEM_PROMPT, user: fields.user },
    requiredPaths: [DEVELOPMENT_ANSWER_PATH],
    permittedPaths: [],
    assertions: fields.assertions,
    answerShape: fields.answerShape,
    // Five minutes. A seventeen-file repository is readable well inside that, and a budget generous
    // enough to remove "it ran out of time" as an explanation is what makes a wrong answer legible
    // as a wrong answer.
    executionBudgetMilliseconds: 300_000,
    plannedRepetitions: 1,
    scoringContractID: DEVELOPMENT_SCORING_CONTRACT_ID,
    scoringContractVersion: DEVELOPMENT_SCORING_CONTRACT_VERSION,
    provenance: PROVENANCE,
    tags: fields.tags,
  });
}

function equals(id: string, pointer: string, value: unknown, metric: string, purpose: string): DevelopmentAssertion {
  return { id, purpose, metric, visibility: 'heldOut', predicate: { kind: 'jsonEquals', path: answer, pointer, value: value as never } };
}
function contains(id: string, pointer: string, value: unknown, metric: string, purpose: string): DevelopmentAssertion {
  return { id, purpose, metric, visibility: 'heldOut', predicate: { kind: 'jsonContains', path: answer, pointer, value: value as never } };
}
function excludes(id: string, pointer: string, value: unknown, metric: string, purpose: string): DevelopmentAssertion {
  return { id, purpose, metric, visibility: 'heldOut', predicate: { kind: 'jsonExcludes', path: answer, pointer, value: value as never } };
}
function hasPointer(id: string, pointer: string, metric: string, purpose: string): DevelopmentAssertion {
  return { id, purpose, metric, visibility: 'stated', predicate: { kind: 'jsonHasPointer', path: answer, pointer } };
}

// MARK: - 1 · Locate the true implementation behind a public API

const locateImplementation = task({
  slug: 'locate-implementation',
  capabilityUnderTest: 'finds the function that does the work behind a public API, past the facade that forwards to it',
  user:
    'The package exports a function called createCharge from its public entry point. Somewhere in this '
    + 'repository is the function that actually performs the work that createCharge causes to happen — not a '
    + 'wrapper that forwards the call, but the function that runs the steps.\n\n'
    + 'Answer with exactly this shape:\n'
    + '{"file": "<repository-relative path>", "symbol": "<the name of that function>"}',
  answerShape: { file: 'string', symbol: 'string' },
  assertions: [
    equals('locate.file', '/file', 'src/core/charge-pipeline.js', 'answerAccuracy',
      'the implementation is the pipeline, not the facade in src/api/charges.js that forwards to it'),
    equals('locate.symbol', '/symbol', 'runChargePipeline', 'answerAccuracy',
      'naming the exported function proves the answer came from reading the module rather than from its path'),
    hasPointer('locate.shape.file', '/file', 'omissionAvoidance', 'the answer carries the file the prompt asked for'),
    hasPointer('locate.shape.symbol', '/symbol', 'omissionAvoidance', 'the answer carries the symbol the prompt asked for'),
  ],
  tags: ['api', 'indirection'],
});

// MARK: - 2 · Trace data and control flow across modules

const traceFlow = task({
  slug: 'trace-flow',
  capabilityUnderTest: 'traces a request across modules in execution order, without inventing or skipping a hop',
  user:
    'Trace one charge request through this package.\n\n'
    + 'List, in the order they are reached, every JavaScript module the request or the amount is handed to, '
    + 'beginning with the public entry point and ending with the module that produces the final integer '
    + 'minor-unit amount.\n\n'
    + 'Include a module only if the request object or the amount is passed into it. Exclude data files '
    + '(anything ending in .json) and exclude modules that are only consulted to look up a constant or a '
    + 'field list.\n\n'
    + 'Answer with exactly this shape:\n'
    + '{"files": ["<path>", "<path>", ...]}',
  answerShape: { files: 'stringArray' },
  assertions: [
    equals('trace.order', '/files', [
      'src/index.js',
      'src/api/charges.js',
      'src/core/charge-pipeline.js',
      'src/core/stages/validate.js',
      'src/core/stages/tax.js',
      'src/core/stages/round.js',
      'src/util/money.js',
    ], 'answerAccuracy', 'the whole chain, in execution order; a missing or reordered hop is a wrong trace'),
    contains('trace.includes-validate', '/files', 'src/core/stages/validate.js', 'omissionAvoidance',
      'the validate stage transforms nothing and is the hop a shallow trace drops'),
    contains('trace.includes-money', '/files', 'src/util/money.js', 'omissionAvoidance',
      'the arithmetic helper is the end of the chain and is reached only through the rounding stage'),
    excludes('trace.excludes-generated', '/files', 'src/schema/generated/charge-fields.js', 'irrelevantFileRestraint',
      'the generated field list is consulted for a constant, which the prompt excludes'),
  ],
  tags: ['control-flow', 'ordering'],
});

// MARK: - 3 · Identify which files must change for a requested behaviour

const impactSet = task({
  slug: 'impact-set',
  capabilityUnderTest: 'names the files a change needs, and separates them from the files that are involved but must not be hand-edited',
  user:
    'A per-region surcharge is being added: a fixed extra amount, looked up by region, applied after tax and '
    + 'before the amount is rounded into minor units.\n\n'
    + 'Answer two questions about this repository as it stands.\n\n'
    + '  mustChange         — the existing files whose contents must change for that behaviour to work. List '
    + 'only files that already exist, and only files whose contents must change; do not list documentation, '
    + 'and do not list files you would merely create.\n'
    + '  mustNotEditByHand  — files that are involved in how this package works but that a person must not '
    + 'edit directly.\n\n'
    + 'Answer with exactly this shape:\n'
    + '{"mustChange": ["<path>", ...], "mustNotEditByHand": ["<path>", ...]}',
  answerShape: { mustChange: 'stringArray', mustNotEditByHand: 'stringArray' },
  assertions: [
    contains('impact.pipeline', '/mustChange', 'src/core/charge-pipeline.js', 'answerAccuracy',
      'a new stage has to be run from somewhere, and the pipeline is the only place that runs stages'),
    contains('impact.rates', '/mustChange', 'src/config/rates.json', 'answerAccuracy',
      'the surcharge is looked up by region, and this repository keeps per-region data in config, not in code'),
    contains('impact.generated-is-protected', '/mustNotEditByHand', 'src/schema/generated/charge-fields.js', 'answerAccuracy',
      'the generated module declares its own generator; recognising that is the point of this task'),
    excludes('impact.not-generated', '/mustChange', 'src/schema/generated/charge-fields.js', 'irrelevantFileRestraint',
      'proposing to hand-edit the generated module is the specific mistake this fixture is built to catch'),
    excludes('impact.not-rounding-cases', '/mustChange', 'test/cases/rounding.cases.json', 'irrelevantFileRestraint',
      'a surcharge changes no rounding case; naming it is confident irrelevance'),
    excludes('impact.not-readme', '/mustChange', 'README.md', 'irrelevantFileRestraint',
      'the prompt excludes documentation, so listing it is a scope failure rather than a judgement call'),
    hasPointer('impact.shape.change', '/mustChange', 'omissionAvoidance', 'the answer carries the mustChange list'),
    hasPointer('impact.shape.protected', '/mustNotEditByHand', 'omissionAvoidance', 'the answer carries the mustNotEditByHand list'),
  ],
  tags: ['impact-analysis', 'generated-code'],
});

// MARK: - 4 · Distinguish source of truth from derived material

const sourceOfTruth = task({
  slug: 'source-of-truth',
  capabilityUnderTest: 'tells an authoritative file from one derived out of it, and names what does the deriving',
  user:
    'Two files in this repository both describe the fields of a charge. One of them is authoritative and the '
    + 'other is produced from it.\n\n'
    + 'Answer with exactly this shape:\n'
    + '{"sourceOfTruth": "<path>", "derived": "<path>", "generator": "<path of the file that produces the derived one>"}',
  answerShape: { sourceOfTruth: 'string', derived: 'string', generator: 'string' },
  assertions: [
    equals('sot.source', '/sourceOfTruth', 'src/schema/charge.schema.json', 'answerAccuracy',
      'the schema is the authoritative description of a charge'),
    equals('sot.derived', '/derived', 'src/schema/generated/charge-fields.js', 'answerAccuracy',
      'the generated module is downstream of the schema'),
    equals('sot.generator', '/generator', 'tools/generate-charge-fields.js', 'answerAccuracy',
      'naming the generator requires reading past the banner into the tools directory'),
    hasPointer('sot.shape.source', '/sourceOfTruth', 'omissionAvoidance', 'the answer names a source of truth'),
    hasPointer('sot.shape.derived', '/derived', 'omissionAvoidance', 'the answer names the derived file'),
    hasPointer('sot.shape.generator', '/generator', 'omissionAvoidance', 'the answer names the generator'),
  ],
  tags: ['generated-code', 'provenance'],
});

// MARK: - 5 · Identify the relevant tests

const relevantTests = task({
  slug: 'relevant-tests',
  capabilityUnderTest: 'finds where a new test case belongs under the repository\'s own convention, rather than where a test could be written',
  user:
    'A new rounding case has to be covered.\n\n'
    + 'This repository has a convention for where a rounding case goes. Follow it.\n\n'
    + '  caseFile            — the file the new case itself is added to\n'
    + '  testModule          — the test module that would exercise it\n'
    + '  otherTestsAffected  — any OTHER existing test files that would have to change as well\n\n'
    + 'Answer with exactly this shape:\n'
    + '{"caseFile": "<path>", "testModule": "<path>", "otherTestsAffected": ["<path>", ...]}',
  answerShape: { caseFile: 'string', testModule: 'string', otherTestsAffected: 'stringArray' },
  assertions: [
    equals('tests.case-file', '/caseFile', 'test/cases/rounding.cases.json', 'answerAccuracy',
      'the convention is stated in the case table itself and in the test module that reads it'),
    equals('tests.module', '/testModule', 'test/money.test.js', 'answerAccuracy',
      'money.test.js is the module that reads the table'),
    equals('tests.no-others', '/otherTestsAffected', [], 'irrelevantFileRestraint',
      'adding a row to a data-driven table changes no other test; naming one is confident irrelevance'),
    hasPointer('tests.shape.others', '/otherTestsAffected', 'omissionAvoidance', 'the answer carries the otherTestsAffected list, even when empty'),
  ],
  tags: ['tests', 'convention'],
});

// MARK: - 6 · Explain a bug from repository evidence

const explainBug = task({
  slug: 'explain-bug',
  capabilityUnderTest: 'diagnoses a reported defect from the code itself, and cites the files the diagnosis rests on',
  user:
    'A user reports that refunds — charges with a negative amount — are recorded one minor unit away from what '
    + 'they expect, while ordinary positive charges are always correct.\n\n'
    + 'Using only what is in this repository, diagnose it.\n\n'
    + '  file      — the file containing the defect\n'
    + '  symbol    — the function containing the defect\n'
    + '  cause     — one sentence naming what the code does that produces this, in terms of the actual '
    + 'operation it performs\n'
    + '  evidence  — the repository files your diagnosis rests on\n\n'
    + 'Answer with exactly this shape:\n'
    + '{"file": "<path>", "symbol": "<name>", "cause": "<one sentence>", "evidence": ["<path>", ...]}',
  answerShape: { file: 'string', symbol: 'string', cause: 'string', evidence: 'stringArray' },
  assertions: [
    equals('bug.file', '/file', 'src/util/money.js', 'answerAccuracy',
      'the defect is in the arithmetic helper, not in the rounding stage that calls it'),
    equals('bug.symbol', '/symbol', 'roundHalfUp', 'answerAccuracy',
      'the function is named for a behaviour it does not have for negative values'),
    {
      id: 'bug.names-the-operation', purpose: 'the diagnosis names the operation rather than gesturing at floating point',
      metric: 'evidenceGrounding', visibility: 'heldOut',
      predicate: { kind: 'matches', path: answer, pattern: 'math\\.round', flags: 'i' },
    },
    {
      id: 'bug.names-the-sign', purpose: 'the diagnosis is about the sign of the amount, which is what the report said',
      metric: 'answerAccuracy', visibility: 'heldOut',
      predicate: { kind: 'matches', path: answer, pattern: 'negative|toward(s)? zero|away from zero', flags: 'i' },
    },
    contains('bug.evidence-money', '/evidence', 'src/util/money.js', 'evidenceGrounding',
      'the file carrying the defect must be among the evidence'),
    excludes('bug.evidence-not-rates', '/evidence', 'src/config/rates.json', 'irrelevantFileRestraint',
      'the rate table has nothing to do with a sign-dependent rounding defect'),
    hasPointer('bug.shape.cause', '/cause', 'omissionAvoidance', 'the answer carries a stated cause'),
    hasPointer('bug.shape.evidence', '/evidence', 'omissionAvoidance', 'the answer carries its evidence list'),
  ],
  tags: ['debugging', 'evidence'],
});

// MARK: - 7 · Decline to name a file for a feature that is not there

const absentFeature = task({
  slug: 'absent-feature',
  capabilityUnderTest: 'says a capability is absent instead of confidently naming files that have nothing to do with it',
  user:
    'Where does this package convert an amount from one currency into another?\n\n'
    + '  present  — true if this package does currency conversion, false if it does not\n'
    + '  files    — the files that implement it. If it does not do currency conversion, this list must be empty.\n\n'
    + 'Answer with exactly this shape:\n'
    + '{"present": <true or false>, "files": ["<path>", ...]}',
  answerShape: { present: 'boolean', files: 'stringArray' },
  assertions: [
    equals('absent.present', '/present', false, 'answerAccuracy',
      'nothing in this repository converts currencies, and saying so is the correct answer'),
    equals('absent.no-files', '/files', [], 'irrelevantFileRestraint',
      'naming money.js, rates.json or the tax stage here is the confabulation this task exists to catch'),
    hasPointer('absent.shape.present', '/present', 'omissionAvoidance', 'the answer states presence either way'),
  ],
  tags: ['hallucination-resistance', 'restraint'],
});

export const repositoryUnderstandingSuite: DevelopmentSuite = makeDevelopmentSuite(
  REPO_UNDERSTANDING_SUITE_ID,
  REPO_UNDERSTANDING_SUITE_VERSION,
  'Cernum Repository Understanding',
  'repositoryUnderstanding',
  [locateImplementation, traceFlow, impactSet, sourceOfTruth, relevantTests, explainBug, absentFeature],
);
