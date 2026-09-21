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

import { parseJSONObject, parseJSONObjectAfterSingleFence } from './json';
import { AssertionOutcome, evaluateAssertions } from './development-assertions';
import { FixtureRepo, RepoSnapshot, snapshotDigest, snapshotOf } from './development-fixture';
import { DEVELOPMENT_ANSWER_PATH, DevelopmentTask, DevelopmentProvenance } from './development-benchmark';
import { DevelopmentTaskGrade, gradeTask } from './development-scoring';

export interface AnswerReading {
  /** Exactly what the candidate produced, untouched. */
  raw: string;
  /** What was written to the answer path, and therefore what the assertions read. */
  recorded: string;
  /** Would `JSON.parse` take the raw text as an object? The transport-compliance fact. */
  strictlyParsed: boolean;
  /** Does it parse after at most one enclosing fence is removed? The semantic fact. */
  semanticallyParsed: boolean;
  fenceRemoved: boolean;
  /** Why a fence was not removed from text that looked fenced. Absent when there was nothing to do. */
  fenceRefusedBecause?: string;
}

export function readAnswer(rawText: string): AnswerReading {
  const trimmed = rawText.trim();
  const { object, unwrap } = parseJSONObjectAfterSingleFence(rawText);
  const semanticallyParsed = object !== undefined;
  return {
    raw: rawText,
    // A document that does not parse either way is recorded verbatim rather than discarded: an
    // assertion then reports "does not parse as JSON", which is a truthful reading of what happened
    // and leaves the bytes in the evidence for whoever has to look at them.
    recorded: semanticallyParsed ? unwrap.text : trimmed,
    strictlyParsed: parseJSONObject(trimmed) !== undefined,
    semanticallyParsed,
    fenceRemoved: unwrap.fenceRemoved,
    fenceRefusedBecause: unwrap.refusedBecause,
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
): DevelopmentTaskResult {
  const baseline = snapshotOf(repo);
  const answer = readAnswer(answerText);
  const result = new Map(baseline);
  result.set(DEVELOPMENT_ANSWER_PATH, answer.recorded);
  return { ...resultFor(task, baseline, result, {}), ...identity, answer };
}

/** Grade an edit task from the repository the attempt left behind. */
export function gradeRepositoryEdit(
  task: DevelopmentTask, repo: FixtureRepo, finalSnapshot: RepoSnapshot,
  identity: { taskDigest: string; comparabilityKey: string },
  options: { retryDetail?: string } = {},
): DevelopmentTaskResult {
  return { ...resultFor(task, snapshotOf(repo), finalSnapshot, options), ...identity };
}
