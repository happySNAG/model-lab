// Benchmark engine · running ONE development attempt inside a workspace it cannot escape.
//
// THE SHAPE OF ONE ATTEMPT, AND WHY IT IS IN THIS ORDER.
//
//   1  a fresh disposable workspace is created under the OS temp root
//   2  the SEALED FIXTURE is copied into it as data — the fixture object is never opened again
//   3  the candidate is asked, with that directory as its working directory
//   4  the repository is READ BACK through the path fence, before anything is disposed
//   5  the workspace is deleted, whether the attempt succeeded, failed or threw
//
// Step 4 before step 5 is the whole reason this is a function rather than a call site. The grade is
// a statement about the bytes the attempt left behind, so those bytes have to be captured while
// they still exist — and the disposal has to happen anyway, which means it has to happen in a
// `finally` that runs after the read. `withIsolatedWorkspace` provides exactly that ordering.
//
// THE REAL CHECKOUT IS NEVER THE TASK WORKSPACE, AND THAT IS STRUCTURAL RATHER THAN POLICED.
// Nothing here takes a repository path. There is no parameter a caller could pass one through, no
// default that resolves to `process.cwd()`, and no branch in which a fixture is read from disk
// instead of from the sealed object. The only directory this module ever names is the one
// `createIsolatedWorkspace` just made, and `resolveInside` refuses every path that leaves it.
//
// A TRANSPORT FAILURE IS NOT A MODEL FAILURE, AND THIS IS WHERE THAT IS DECIDED FOR A DEVELOPMENT
// ROW. The classification is `dispositionForFailure`, the same function the text campaign uses and
// the same one an offline re-derivation uses months later — message first, adapter label second.
// An attempt that is not `modelAnswered` is marked NOT EVALUABLE and is never graded: grading a
// blank would put an exhausted subscription, a content filter or a dead socket into a model's
// development column, which is the exact defect Pass 9 and Pass 11 were spent correcting.

import {
  DEVELOPMENT_ANSWER_PATH, DevelopmentTask,
} from '../core/development-benchmark';
import { FixtureRepo } from '../core/development-fixture';
import { AttemptDisposition, dispositionForFailure, isScoreableDisposition } from './attempt-disposition';
import { materializeFixture, readWorkspaceSnapshot, WorkspaceReading } from './development-workspace';
import {
  FrontierAdapter, FrontierFailureKind, FrontierResponse, withRetry,
} from './frontier-adapter';
import { FrontierAttemptRecord } from './frontier-metrics';
import { buildFrontierAttemptRecord } from './frontier-host';
import { IsolatedWorkspace, withIsolatedWorkspace } from './isolation';
import { ProviderBinding } from './provider';
import { redactError } from './redaction';

/** The prefix every development workspace is created under. Visible in a path, so it names itself. */
export const DEVELOPMENT_WORKSPACE_PREFIX = 'cernum-development-';

export interface DevelopmentExecutionRequest {
  task: DevelopmentTask;
  repo: FixtureRepo;
  binding: ProviderBinding;
  adapter: FrontierAdapter;
  /** Identifies the row this produces. Carried through so a failure names the attempt it belongs to. */
  runID: string;
  slotKey: string;
  shouldCancel?: () => boolean;
  /** Injected by the tests; `Date.now` otherwise. */
  now?: () => number;
  /** Injected by the tests to observe the workspace while it still exists. Never set in life. */
  inspectWorkspace?: (workspace: IsolatedWorkspace) => void;
  sleep?: (milliseconds: number) => Promise<void>;
}

export interface DevelopmentExecutionOutcome {
  runID: string;
  slotKey: string;
  taskID: string;
  /** Where the attempt ran. Always under the OS temp root; never a checkout. */
  workspaceRoot: string;
  /** The repository as the attempt left it, read back through the path fence before disposal. */
  reading: WorkspaceReading;
  /** The candidate's answer text, exactly as the provider returned it. Empty on a failure. */
  answerText: string;
  /** The row this attempt contributes, built by the SAME function a text campaign's row is built by. */
  record: FrontierAttemptRecord;
  disposition: AttemptDisposition;
  /**
   * True when a model was asked and answered, so this attempt may be graded.
   *
   * False is NOT a zero. It becomes a `NOT MEASURED` result, and the reason travels with it.
   */
  evaluable: boolean;
  notEvaluableBecause?: string;
  failure?: { kind: FrontierFailureKind; detail: string };
  retryCount: number;
  /** What to put on `retryBehaviour`, or undefined when there is nothing to say. */
  retryDetail?: string;
  totalElapsedMilliseconds: number;
}

/**
 * The prompt one development attempt is sent.
 *
 * The fixture is NOT interpolated into it. The repository is on disk in front of the candidate, and
 * a prompt that also carried its text would be measuring reading comprehension of a prompt rather
 * than of a repository — and would make the input token count a property of the fixture's size.
 */
export function developmentPromptFor(task: DevelopmentTask): { system: string; user: string } {
  const preamble = task.kind === 'repositoryQuestion'
    ? `The repository is the current working directory. Read it. Do not modify it.\n\n`
      + `Write your answer as a single JSON object to the file ${DEVELOPMENT_ANSWER_PATH} in the `
      + `working directory root, and also print it as your reply.\n\n`
    : `The repository is the current working directory. Make the change in place, editing the files `
      + `that genuinely need to change and no others.\n\n`;
  return { system: task.prompt.system, user: `${preamble}${task.prompt.user}` };
}

/** Why an attempt that produced no model answer must not be graded, in the disposition's own terms. */
function notEvaluableBecause(disposition: AttemptDisposition, failure?: { kind: string; detail: string }): string {
  return `this attempt is ${disposition}, so no model answered it and there is nothing here to grade. `
    + `The result is recorded as NOT MEASURED rather than as a failed development task: a blank is not a `
    + `wrong answer, and putting one in a capability column is the single most misleading thing a `
    + `benchmark can do.${failure ? ` The adapter reported ${failure.kind}.` : ''}`;
}

/**
 * Run one development attempt, end to end, inside a workspace that is deleted afterwards.
 *
 * NOTHING IS GRADED HERE. This function produces the bytes and the telemetry; `development-grading`
 * turns them into a verdict. Keeping the two apart is what lets a grade be recomputed from a
 * recorded snapshot without re-running a model — and it is why a scoring change is a re-grade
 * rather than a re-run.
 */
export async function executeDevelopmentAttempt(
  request: DevelopmentExecutionRequest,
): Promise<DevelopmentExecutionOutcome> {
  const now = request.now ?? (() => Date.now());
  const startedAt = now();
  const prompt = developmentPromptFor(request.task);
  // An edit task may write; a repository-understanding task may not, and is given no tool that
  // could. The task's own `kind` decides it — never a flag the runner could set differently.
  const writable = request.task.kind === 'repositoryEdit';

  return withIsolatedWorkspace(async (workspace) => {
    materializeFixture(workspace, request.repo);

    const response: FrontierResponse = await withRetry(
      request.binding,
      () => request.adapter.complete({
        binding: request.binding,
        promptText: `${prompt.system}\n\n${prompt.user}`,
        // THE MODEL'S WORKING DIRECTORY IS THE WORKSPACE ROOT, and it is the only directory named
        // anywhere in this call. The adapter uses it instead of making its own, and does not remove
        // it: the snapshot below has to be read before anything is disposed.
        developmentWorkspace: { root: workspace.root, writable },
        shouldCancel: request.shouldCancel,
      }),
      request.sleep,
      request.shouldCancel,
    );

    // READ BACK BEFORE DISPOSAL, and read back on EVERY path including a failed one. A failed
    // attempt that nevertheless wrote to the repository is a fact worth having: it is how an
    // isolation claim gets checked rather than asserted.
    const reading = readWorkspaceSnapshot(workspace);
    request.inspectWorkspace?.(workspace);

    const record = buildFrontierAttemptRecord(request.binding, response);
    const failure = response.failure;
    const disposition = failure === undefined
      ? 'modelAnswered' as AttemptDisposition
      : dispositionForFailure(failure.kind, failure.detail);
    const evaluable = failure === undefined && isScoreableDisposition(disposition);

    return {
      runID: request.runID,
      slotKey: request.slotKey,
      taskID: request.task.id,
      workspaceRoot: workspace.root,
      reading,
      answerText: response.answerText,
      record,
      disposition,
      evaluable,
      notEvaluableBecause: evaluable ? undefined : notEvaluableBecause(disposition, failure),
      failure: failure === undefined
        ? undefined
        // Redacted on its way out, for the same reason the ledger redacts every row: a provider that
        // echoes a credential into an error writes it into evidence that outlives the run.
        : { kind: failure.kind, detail: redactError(failure.detail) },
      retryCount: response.retryCount,
      retryDetail: retryDetailFor(response),
      totalElapsedMilliseconds: response.totalElapsedMilliseconds > 0
        ? response.totalElapsedMilliseconds : now() - startedAt,
    };
  }, DEVELOPMENT_WORKSPACE_PREFIX);
}

/**
 * What `retryBehaviour` is told about this attempt.
 *
 * A first-try success gets a sentence too. `gradeTask` reports the metric as NOT MEASURED when the
 * runner recorded no retry history, and "the runner did not look" and "the runner looked and there
 * were none" are different facts about a row.
 */
export function retryDetailFor(response: FrontierResponse): string {
  if (response.retryCount === 0) {
    return 'the attempt was made once and was not retried';
  }
  return `the attempt was retried ${response.retryCount} time(s), discarding ${response.wastedTokens} token(s) `
    + 'on the tries that were thrown away; retries are not free and this figure is what they cost';
}
