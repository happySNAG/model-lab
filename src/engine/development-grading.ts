// Benchmark engine · turning what an attempt left behind into a graded development result.
//
// THE GRADE IS A STATEMENT ABOUT BYTES THAT WERE READ BACK OUT OF THE WORKSPACE, and both dimensions
// are graded that way. `development-evaluation.ts` already provides the two entry points and one
// predicate language behind them; this module's whole job is to decide WHICH BYTES each one is
// handed, stamp the provenance on the result, and refuse to produce a grade at all when nothing was
// measured.
//
// WHERE A READ-ONLY TASK'S ANSWER COMES FROM.
//
// Under `development-prompt-2` a repository-understanding attempt is asked for ONE thing: its reply,
// which must be the JSON object alone. It is given no tool that could write, and it is told not to.
// (`development-prompt-1` also asked it to write the reserved answer path — an instruction a
// read-only workspace made impossible to follow — and that is what the version bump corrected.)
//
// The reserved answer path is still read first, and a clean object found there is still graded: it
// is read back through the same path fence as every other file, so an answer path that resolved
// outside the workspace is refused rather than read. On the current prompt it is simply absent, and
// the printed reply is what is graded. A reply that is the object followed by prose is NOT an object
// and is graded as the non-conforming output it is.
//
// WHICHEVER WAS USED IS RECORDED. `answerSource` is on the result, because "this candidate's answers
// are only ever in its stdout" is a fact about the integration worth being able to see — exactly as
// `strictlyParsed` versus `semanticallyParsed` is.
//
// A READ-ONLY TASK THAT WROTE IS NOT RE-GRADED, IT IS REPORTED. `gradeRepositoryQuestion` does not
// re-read the repository, on purpose: a question task is read-only by construction and its result
// snapshot is the baseline plus the answer. But whether the attempt nevertheless touched the
// repository is a real observation about the candidate, so it is computed here from the read-back
// and carried beside the grade. It changes no metric — the contract declares none for it on this
// dimension — and inventing one here would be scoring against a rule the candidate was never given.

import {
  DEVELOPMENT_ANSWER_PATH, DevelopmentProvenance, DevelopmentTask,
} from '../core/development-benchmark';
import { DevelopmentTaskResult, gradeRepositoryEdit, gradeRepositoryQuestion } from '../core/development-evaluation';
import {
  FixtureRepo, diffSnapshots, snapshotOf, touchedPaths,
} from '../core/development-fixture';
import { DevelopmentExecutionOutcome } from './development-execution';
import { isRefusedContent } from './development-workspace';

/** Which copy of a read-only task's answer was graded. */
export type AnswerSource =
  /** Read back out of the reserved answer path in the disposable workspace. Preferred. */
  | 'workspaceFile'
  /** The provider's reply text, used because the file was absent or unreadable. */
  | 'providerReply'
  /** Neither: the attempt produced no answer at all. Graded as the empty answer it was. */
  | 'none';

export interface DevelopmentAnswerReadBack {
  text: string;
  source: AnswerSource;
  /** In words, for the evidence: why this copy and not the other. */
  because: string;
}

/**
 * The answer to grade, preferring the file the task asked for over the text it printed.
 *
 * An answer path recorded with the unreadable marker is NOT used: the reader refused it — because it
 * was too large, or would not resolve inside the workspace — and grading the marker would judge the
 * model on this engine's own refusal.
 */
export function readBackAnswer(outcome: DevelopmentExecutionOutcome): DevelopmentAnswerReadBack {
  const written = outcome.reading.snapshot.get(DEVELOPMENT_ANSWER_PATH);
  if (written !== undefined && !isRefusedContent(written) && written.trim().length > 0) {
    return {
      text: written,
      source: 'workspaceFile',
      because: `the attempt wrote ${DEVELOPMENT_ANSWER_PATH} in its workspace, which is the artefact the task asked `
        + 'for; it was read back through the path fence and graded',
    };
  }
  if (outcome.answerText.trim().length > 0) {
    return {
      text: outcome.answerText,
      source: 'providerReply',
      because: written === undefined
        ? `the attempt wrote no ${DEVELOPMENT_ANSWER_PATH}, so the printed reply was graded — which is where the `
          + 'current prompt asks a read-only attempt to put its answer'
        : `${DEVELOPMENT_ANSWER_PATH} was present but could not be graded (${written.slice(0, 120)}), so the `
          + 'printed reply was graded instead',
    };
  }
  return {
    text: '',
    source: 'none',
    because: 'the attempt produced neither an answer file nor any reply text, so it is graded as the empty '
      + 'answer it actually gave — which is a failure of the task, and is distinct from an attempt no model '
      + 'ever answered, which is NOT MEASURED and is never graded at all',
  };
}

export type DevelopmentAttemptState =
  /** A model answered and the attempt was graded. */
  | 'graded'
  /** No model answered. There is no grade, and there must not be one. */
  | 'notMeasured';

export interface DevelopmentAttemptResult {
  state: DevelopmentAttemptState;
  /** Present only when `state` is `graded`. Absent is the whole point of NOT MEASURED. */
  result?: DevelopmentTaskResult;
  /** Present only when `state` is `notMeasured`. */
  notMeasuredBecause?: string;
  /** Recorded on both states: provenance is a fact about the ATTEMPT, not about the grade. */
  provenance: DevelopmentProvenance;
  /** Which copy of the answer was graded. Absent on an edit task, which produces no answer file. */
  answerReadBack?: DevelopmentAnswerReadBack;
  /** Every path the attempt added, removed or modified in its workspace. */
  touchedPaths: string[];
  /**
   * Paths a READ-ONLY task touched anyway. Empty on an edit task and on a well-behaved question.
   * Reported, never scored: the contract declares no metric for it on this dimension.
   */
  readOnlyViolationPaths: string[];
}

/**
 * Grade one executed attempt, or refuse to.
 *
 * THE REFUSAL IS THE IMPORTANT HALF. An attempt that never reached a model produces no grade, no
 * metric row and no zero — `state: 'notMeasured'` with the reason the driver recorded. Every rate
 * built on top of this counts decided results only, so an exhausted subscription cannot depress a
 * development score and a dead socket cannot look like a model that could not edit four files.
 */
export function gradeDevelopmentAttempt(options: {
  task: DevelopmentTask;
  repo: FixtureRepo;
  outcome: DevelopmentExecutionOutcome;
  provenance: DevelopmentProvenance;
}): DevelopmentAttemptResult {
  const { task, repo, outcome, provenance } = options;
  const baseline = snapshotOf(repo);
  const difference = diffSnapshots(baseline, outcome.reading.snapshot);
  // The reserved answer path is a task artefact, not a repository edit, so it never counts as a
  // touch. A question task that wrote only its answer touched nothing.
  const touched = touchedPaths(difference).filter((entry) => entry !== DEVELOPMENT_ANSWER_PATH);
  const readOnlyViolationPaths = task.kind === 'repositoryQuestion' ? touched : [];

  if (!outcome.evaluable) {
    return {
      state: 'notMeasured',
      notMeasuredBecause: outcome.notEvaluableBecause
        ?? 'the runner did not establish that a model answered this attempt',
      provenance,
      touchedPaths: touched,
      readOnlyViolationPaths,
    };
  }

  const identity = { taskDigest: provenance.taskDigest, comparabilityKey: provenance.comparabilityKey };

  if (task.kind === 'repositoryQuestion') {
    const answer = readBackAnswer(outcome);
    const result = gradeRepositoryQuestion(task, repo, answer.text, identity);
    return {
      state: 'graded',
      result: { ...result, provenance },
      provenance,
      answerReadBack: answer,
      touchedPaths: touched,
      readOnlyViolationPaths,
    };
  }

  const result = gradeRepositoryEdit(task, repo, outcome.reading.snapshot, identity, {
    retryDetail: outcome.retryDetail,
  });
  return {
    state: 'graded',
    result: { ...result, provenance },
    provenance,
    touchedPaths: touched,
    readOnlyViolationPaths,
  };
}
