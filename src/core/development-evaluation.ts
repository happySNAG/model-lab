// Model Lab core · turning a development attempt into a graded result.
//
// ONE PATH FOR BOTH DIMENSIONS. A repository-understanding attempt produces a JSON answer and a
// multi-file-editing attempt produces a changed repository, but both are graded by the same
// predicate language over the same pair of snapshots. The only difference is how the RESULT snapshot
// is built: an edit task's result is read back out of the disposable workspace, and a question
// task's result is the baseline with the candidate's answer written into the reserved answer path.
//
// WHY THE ANSWER BECOMES A FILE. Because the alternative is a second evaluator, and a second
// evaluator is a second place for a subtle disagreement about what "held" means to live. The answer
// path is reserved by the validator, so nothing in a fixture can collide with it.
//
// THE TWO READINGS OF A JSON ANSWER ARE KEPT APART, exactly as `json.ts` keeps them apart for the
// text benchmark. A model that wraps a correct object in a markdown fence has produced something
// `JSON.parse` refuses and something a human would call a correct answer. Pass 6 measured that one
// convention producing an entire apparent ordering. So the strict reading is recorded as a fact
// about the integration, the semantic reading is what the assertions judge, and neither is quietly
// substituted for the other.
//
// CONTRACT 2 ADDS A THIRD READING, AND KEEPS THE FIRST ONE ON THE RECORD. `dev-cohort-2` showed one
// candidate prefacing a correct object with a sentence of narration on 6 of 14 attempts; every one
// scored zero under contract 1. The terminal-object reading accepts exactly that shape and nothing
// looser (see `extractTerminalJSONObject`), every accepted object must have the task's declared
// shape, and `strictlyParsed` stays false on such an answer — so a report can say both "it knew" and
// "it did not follow the output instruction", which are two different facts about a candidate.

import {
  AnswerShape, answerShapeViolations, extractTerminalJSONObject, parseJSONObject, parseJSONObjectAfterSingleFence,
} from './json';
import { AssertionOutcome, evaluateAssertions } from './development-assertions';
import { FixtureRepo, RepoSnapshot, snapshotDigest, snapshotOf } from './development-fixture';
import { DEVELOPMENT_ANSWER_PATH, DevelopmentTask, DevelopmentProvenance } from './development-benchmark';
import {
  ANSWER_READING_RULES_BY_CONTRACT_VERSION, AnswerReadingRules, DEVELOPMENT_SCORING_CONTRACT_VERSION,
  DevelopmentTaskGrade, gradeTask,
} from './development-scoring';

/** Which reading produced the object the assertions judged. */
export type AnswerReadingKind =
  /** The whole reply was the object. The only reading that is also transport-compliant. */
  | 'strict'
  /** One fence enclosing the whole reply was removed. */
  | 'singleFence'
  /** Prose, then one terminal object (contract 2 onward). */
  | 'terminalObject'
  /** No reading produced an acceptable object. */
  | 'none';

export interface AnswerReading {
  /** Exactly what the candidate produced, untouched. */
  raw: string;
  /** What was written to the answer path, and therefore what the assertions read. */
  recorded: string;
  /** Would `JSON.parse` take the raw text as an object? THE COMPLIANCE FACT, never relaxed. */
  strictlyParsed: boolean;
  /**
   * Did the grading contract accept an object as the answer, by any of its readings and with the
   * task's shape? Under contract 1 this was exactly "parses after at most one enclosing fence".
   */
  semanticallyParsed: boolean;
  fenceRemoved: boolean;
  /** Why a fence was not removed from text that looked fenced. Absent when there was nothing to do. */
  fenceRefusedBecause?: string;
  /** The rules this answer was read under — a function of the contract version. */
  rules: AnswerReadingRules;
  /** Which reading produced the judged object, or `none`. */
  reading: AnswerReadingKind;
  /** True when the object was found only by terminal extraction: prose came before it. */
  terminalObjectExtracted: boolean;
  /** Why terminal extraction found nothing. Absent when it succeeded or was never attempted. */
  terminalExtractionRefusedBecause?: string;
  /** Whether the read object has the task's declared shape. Absent with no object or no shape. */
  shapeValid?: boolean;
  shapeViolations: string[];
  /**
   * Why the grading contract refused an object it did read. Set only for a shape refusal: every
   * assertion then fails with this reason, rather than with a misleading "does not parse".
   */
  refusedBecause?: string;
}

export interface ReadAnswerOptions {
  /** The shape the task declares. Without one, no shape is checked. */
  shape?: AnswerShape;
  /** The contract version whose reading rules apply. The current contract when absent. */
  contractVersion?: string;
}

export function answerReadingRulesFor(contractVersion: string): AnswerReadingRules {
  const rules = ANSWER_READING_RULES_BY_CONTRACT_VERSION[contractVersion];
  if (rules === undefined) throw new Error(`no answer reading rules are registered for contract version ${contractVersion}`);
  return rules;
}

export function readAnswer(rawText: string, options: ReadAnswerOptions = {}): AnswerReading {
  const rules = answerReadingRulesFor(options.contractVersion ?? DEVELOPMENT_SCORING_CONTRACT_VERSION);
  const trimmed = rawText.trim();
  const strictlyParsed = parseJSONObject(trimmed) !== undefined;
  const { object: fencedObject, unwrap } = parseJSONObjectAfterSingleFence(rawText);

  let object = fencedObject;
  let text = unwrap.text;
  let reading: AnswerReadingKind = object === undefined ? 'none' : strictlyParsed ? 'strict' : 'singleFence';
  let terminalObjectExtracted = false;
  let terminalExtractionRefusedBecause: string | undefined;
  if (object === undefined && rules === 'strictSingleFenceOrTerminalObject') {
    const extraction = extractTerminalJSONObject(rawText);
    if (extraction.object !== undefined) {
      object = extraction.object;
      text = extraction.text;
      reading = 'terminalObject';
      terminalObjectExtracted = true;
    } else {
      terminalExtractionRefusedBecause = extraction.refusedBecause;
    }
  }

  // THE SHAPE IS CHECKED ON EVERY READING, not only the permissive one. One rule for "this is the
  // answer" whichever way it was reached; a terminal object held to a stricter bar than a bare one
  // would make the reading, not the answer, decide the grade. Contract 1 checked no shape.
  const shapeViolations = object !== undefined && options.shape !== undefined && rules !== 'strictOrSingleFence'
    ? answerShapeViolations(object, options.shape) : [];
  const shapeValid = object === undefined || options.shape === undefined || rules === 'strictOrSingleFence'
    ? undefined : shapeViolations.length === 0;
  const accepted = object !== undefined && shapeValid !== false;

  return {
    raw: rawText,
    // A document that does not parse either way is recorded verbatim rather than discarded: an
    // assertion then reports "does not parse as JSON", which is a truthful reading of what happened
    // and leaves the bytes in the evidence for whoever has to look at them. A shape refusal records
    // the object it refused, so the evidence shows what was rejected.
    recorded: object !== undefined ? text : trimmed,
    strictlyParsed,
    semanticallyParsed: accepted,
    fenceRemoved: unwrap.fenceRemoved,
    fenceRefusedBecause: unwrap.refusedBecause,
    rules,
    reading: accepted ? reading : 'none',
    terminalObjectExtracted: accepted && terminalObjectExtracted,
    terminalExtractionRefusedBecause,
    shapeValid,
    shapeViolations,
    refusedBecause: shapeValid === false
      ? `the answer object does not have the shape the task states: ${shapeViolations.join('; ')}` : undefined,
  };
}

export interface DevelopmentTaskResult {
  taskID: string;
  suiteID: string;
  dimension: DevelopmentTask['dimension'];
  taskDigest: string;
  comparabilityKey: string;
  baselineSnapshotDigest: string;
  resultSnapshotDigest: string;
  outcomes: AssertionOutcome[];
  grade: DevelopmentTaskGrade;
  /** Present on a `repositoryQuestion` task; absent on an edit task, which produces no answer text. */
  answer?: AnswerReading;
  /**
   * Filled in by the engine, which knows the commit, the machine and the clock. Absent here on
   * purpose: the portable core has no business reading a machine.
   */
  provenance?: DevelopmentProvenance;
}

function resultFor(task: DevelopmentTask, baseline: RepoSnapshot, result: RepoSnapshot,
                   options: { retryDetail?: string }): Omit<DevelopmentTaskResult, 'taskDigest' | 'comparabilityKey'> {
  const outcomes = evaluateAssertions(task.assertions, { baseline, result });
  return {
    taskID: task.id,
    suiteID: task.suiteID,
    dimension: task.dimension,
    baselineSnapshotDigest: snapshotDigest(baseline),
    resultSnapshotDigest: snapshotDigest(result),
    outcomes,
    grade: gradeTask(task.dimension, outcomes, options),
  };
}

/**
 * Grade a read-only repository question from the candidate's answer text.
 *
 * The repository itself is NOT re-read: a question task is read-only by construction, so the result
 * snapshot is the baseline plus the answer. Whether the candidate nevertheless wrote to the
 * workspace is a separate question, and `gradeRepositoryEdit` is the function that asks it.
 */
export function gradeRepositoryQuestion(
  task: DevelopmentTask, repo: FixtureRepo, answerText: string,
  identity: { taskDigest: string; comparabilityKey: string },
  options: { contractVersion?: string } = {},
): DevelopmentTaskResult {
  const baseline = snapshotOf(repo);
  const answer = readAnswer(answerText, { shape: task.answerShape, contractVersion: options.contractVersion });
  const result = new Map(baseline);
  result.set(DEVELOPMENT_ANSWER_PATH, answer.recorded);
  if (answer.refusedBecause === undefined) {
    return { ...resultFor(task, baseline, result, {}), ...identity, answer };
  }
  // REFUSED ON SHAPE: the object parsed, but it is not the answer the task asked for, so nothing in
  // it is judged. Every assertion fails and says why, and the grade is computed from those outcomes
  // by the same `gradeTask` as every other answer.
  const outcomes = evaluateAssertions(task.assertions, { baseline, result })
    .map((outcome) => ({ ...outcome, held: false, detail: answer.refusedBecause! }));
  return {
    taskID: task.id,
    suiteID: task.suiteID,
    dimension: task.dimension,
    baselineSnapshotDigest: snapshotDigest(baseline),
    resultSnapshotDigest: snapshotDigest(result),
    outcomes,
    grade: gradeTask(task.dimension, outcomes, {}),
    ...identity,
    answer,
  };
}

/** Grade an edit task from the repository the attempt left behind. */
export function gradeRepositoryEdit(
  task: DevelopmentTask, repo: FixtureRepo, finalSnapshot: RepoSnapshot,
  identity: { taskDigest: string; comparabilityKey: string },
  options: { retryDetail?: string } = {},
): DevelopmentTaskResult {
  return { ...resultFor(task, snapshotOf(repo), finalSnapshot, options), ...identity };
}
