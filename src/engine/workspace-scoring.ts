// Benchmark engine · turning a tree, a patch and a pile of exit statuses into one verdict — and
// being explicit about every place that verdict could be flattering.
//
// THE STATUS IS DECIDED IN ONE ORDER, AND THE ORDER IS THE ARGUMENT.
//
//   runtimeError / safetyAbort   the harness faulted, or the attempt left its workspace. Nothing
//                                about a model was measured, so nothing about a model is recorded.
//   envelopeFailure              the driver could not express something the case froze. The request
//                                that went out was not the request that was authorised.
//   timeout                      the deadline passed with work in flight. Not a wrong answer.
//   scopeFailure                 the change went where it was told not to. Correct code in the wrong
//                                place is not this task, and editing the test that judges you is not
//                                passing it.
//   patchFailure                 the change is not a change anybody could take: conflict markers,
//                                patch residue, or more of the repository rewritten than the case
//                                allows.
//   compilationFailure           it does not build or does not typecheck. Nothing downstream of that
//                                is a measurement of behaviour.
//   behavioralFailure            it builds and the tests say it is wrong.
//   fail / partial / pass        everything mechanical held; this is the quality reading.
//
// EACH ONE PREEMPTS THE ONES BELOW IT, because each describes a reason the reading below it would
// be meaningless. A run that edited the test file and then passed the test has not passed the test.
//
// A MISSING NUMBER IS NEVER A ZERO. Every metric is reported either as an integer in thousandths or
// as unavailable WITH A REASON, and the composite renormalizes over the metrics that exist. A case
// that declares no change ceiling gets no patch-economy score — not a zero, which would rank a
// model below one that was never asked the question.

import { CanonicalValue } from './canonical';
import { TerminalSlotStatus } from './ledger';
import { describeScopeAssessment } from './workspace-scope';
import { WorkspaceCase } from './workspace-case';
import { CommandOutcome, WorkspaceAttemptRecord, WorkspaceRunResult, attemptSucceeded } from './workspace-execution';

/** A number the scorer has, or a reason it does not. The engine's `Quantity`, kept local and integral. */
export interface MetricReading extends Record<string, CanonicalValue | undefined> {
  valueMilli?: number;
  unavailableReason?: string;
}

export const metric = (valueMilli: number): MetricReading => ({ valueMilli });
export const noMetric = (unavailableReason: string): MetricReading => ({ unavailableReason });

export interface CheckTransition extends Record<string, CanonicalValue | undefined> {
  commandID: string;
  kind: string;
  before?: boolean;
  after: boolean;
  /** `regression` is the one that stops a run being a success however good the rest of it looks. */
  transition: 'fixed' | 'regression' | 'stillPassing' | 'stillFailing' | 'unknownBefore';
}

export interface WorkspaceScorecard {
  caseID: string;
  caseVersion: string;
  caseDigest: string;
  comparabilityKey: string;
  scoringPolicyID: string;
  scoringPolicyVersion: string;

  status: TerminalSlotStatus;
  /** Plain language, and the line a terminal prints. Never empty. */
  detail: string;
  /**
   * The provider declined rather than the model failing — a rate limit or an expired session.
   *
   * The campaign ABORTS on this rather than recording the row, exactly as it does on the prose side:
   * a slot that never produced an attempt must never carry an outcome, because the ranking's own
   * counting rule would turn it into a failure of the model.
   */
  providerThrottled: boolean;

  metricsMilli: Record<string, MetricReading>;
  /** Weighted over the metrics that exist, renormalized. Unavailable when none of them do. */
  compositeMilli: MetricReading;

  transitions: CheckTransition[];
  regressionCount: number;
  fixedCount: number;

  attemptsUsed: number;
  retriesRequired: number;
  wallClockMilliseconds: number;
  /** Time spent on attempts that did not decide the outcome. The cost of getting it wrong first. */
  wastedMilliseconds: number;
  changedFileCount: number;
  changedLineCount: number;
  patchByteCount: number;
  patchDigest: string;
  transcriptDigest: string;
  toolCallCount: number;
  observedCommandCount: number;
  /** Tokens and cost, when a driver reported them. Absent is absent; never zero. */
  usage?: Record<string, CanonicalValue | undefined>;
}

const AGENT_FAILURE_STATUS: Record<string, TerminalSlotStatus> = {
  timeout: 'timeout',
  cancelled: 'timeout',
  policyNotExpressible: 'envelopeFailure',
  notInstalled: 'runtimeError',
  spawnFailure: 'runtimeError',
  exitFailure: 'runtimeError',
  transport: 'runtimeError',
  malformedOutput: 'runtimeError',
};

/**
 * Score one run — every attempt of it — and say which status the campaign should record.
 *
 * The DECIDING attempt is the last one made: either the one that succeeded, or the last one tried.
 * Earlier attempts are not scored separately and are not averaged in; they are counted as retries
 * and as waste, which is the honest way to say that getting there on the third go is worse than
 * getting there on the first.
 */
export function scoreWorkspaceRun(workspaceCase: WorkspaceCase, run: WorkspaceRunResult): WorkspaceScorecard {
  const base = {
    caseID: run.caseID,
    caseVersion: run.caseVersion,
    caseDigest: run.caseDigest,
    comparabilityKey: run.comparabilityKey,
    scoringPolicyID: workspaceCase.scoring.id,
    scoringPolicyVersion: workspaceCase.scoring.version,
  };

  if (run.refusedBecause.length > 0) {
    return {
      ...base,
      status: 'envelopeFailure',
      detail: `this case was not attempted: ${run.refusedBecause.join('; ')}`,
      providerThrottled: false,
      metricsMilli: {}, compositeMilli: noMetric('nothing was attempted, so there is nothing to score'),
      transitions: [], regressionCount: 0, fixedCount: 0,
      attemptsUsed: 0, retriesRequired: 0, wallClockMilliseconds: run.totalElapsedMilliseconds, wastedMilliseconds: 0,
      changedFileCount: 0, changedLineCount: 0, patchByteCount: 0, patchDigest: '', transcriptDigest: '',
      toolCallCount: 0, observedCommandCount: 0,
    };
  }

  const deciding = run.attempts[run.attempts.length - 1];
  if (deciding === undefined) {
    return {
      ...base,
      status: 'runtimeError',
      detail: 'no attempt was recorded for this case, which is a harness fault rather than a result',
      providerThrottled: false,
      metricsMilli: {}, compositeMilli: noMetric('no attempt was recorded'),
      transitions: [], regressionCount: 0, fixedCount: 0,
      attemptsUsed: 0, retriesRequired: 0, wallClockMilliseconds: run.totalElapsedMilliseconds, wastedMilliseconds: 0,
      changedFileCount: 0, changedLineCount: 0, patchByteCount: 0, patchDigest: '', transcriptDigest: '',
      toolCallCount: 0, observedCommandCount: 0,
    };
  }

  const transitions = checkTransitions(deciding);
  const regressions = transitions.filter((transition) => transition.transition === 'regression');
  const { status, detail, throttled } = decideStatus(workspaceCase, deciding, regressions.length);
  const metricsMilli = buildMetrics(workspaceCase, run, deciding, transitions, status);

  const wasted = run.attempts.slice(0, -1).reduce((sum, attempt) => sum + attempt.elapsedMilliseconds, 0);

  return {
    ...base,
    status,
    detail,
    providerThrottled: throttled,
    metricsMilli,
    compositeMilli: composite(workspaceCase, metricsMilli),
    transitions,
    regressionCount: regressions.length,
    fixedCount: transitions.filter((transition) => transition.transition === 'fixed').length,
    attemptsUsed: run.attemptsUsed,
    retriesRequired: Math.max(0, run.attemptsUsed - 1),
    wallClockMilliseconds: run.totalElapsedMilliseconds,
    wastedMilliseconds: wasted,
    changedFileCount: deciding.diff.changes.length,
    changedLineCount: deciding.diff.addedLineCount + deciding.diff.removedLineCount,
    patchByteCount: deciding.patch.byteCount,
    patchDigest: deciding.patch.patchDigest,
    transcriptDigest: deciding.transcript.transcriptDigest,
    toolCallCount: deciding.transcript.summary.toolCallCount,
    observedCommandCount: deciding.transcript.summary.observedCommandCount,
    usage: deciding.agent.usage,
  };
}

/** Before and after, per visible check. `unknownBefore` when the case established no baseline. */
export function checkTransitions(record: WorkspaceAttemptRecord): CheckTransition[] {
  const before = new Map(record.baselineOutcomes.map((outcome) => [outcome.commandID, outcome.passed]));
  const rows: CheckTransition[] = [];
  for (const outcome of [...record.verificationOutcomes, ...record.hiddenOutcomes]) {
    const was = before.get(outcome.commandID);
    rows.push({
      commandID: outcome.commandID,
      kind: outcome.kind,
      before: was,
      after: outcome.passed,
      transition: was === undefined ? 'unknownBefore'
        : was && outcome.passed ? 'stillPassing'
          : was && !outcome.passed ? 'regression'
            : !was && outcome.passed ? 'fixed' : 'stillFailing',
    });
  }
  return rows;
}

function failedRequired(outcomes: CommandOutcome[], kinds: string[]): CommandOutcome | undefined {
  return outcomes.find((outcome) => outcome.required && !outcome.passed && kinds.includes(outcome.kind));
}

function decideStatus(workspaceCase: WorkspaceCase, record: WorkspaceAttemptRecord, regressionCount: number):
{ status: TerminalSlotStatus; detail: string; throttled: boolean } {
  if (record.harnessFault) {
    const escaped = record.harnessFault.code === 'workspaceEscape';
    return {
      status: escaped ? 'safetyAbort' : 'runtimeError',
      detail: `${record.harnessFault.code}: ${record.harnessFault.detail}`,
      throttled: false,
    };
  }

  const failure = record.agent.failure;
  if (failure) {
    if (failure.kind === 'rateLimited' || failure.kind === 'notAuthenticated') {
      return {
        status: 'runtimeError',
        detail: `${failure.kind}: the provider declined rather than the model failing — ${failure.detail}. `
          + 'This is not recorded as a quality outcome; the campaign aborts and the slot stays runnable.',
        throttled: true,
      };
    }
    return {
      status: AGENT_FAILURE_STATUS[failure.kind] ?? 'runtimeError',
      detail: `${failure.kind}: ${failure.detail}`,
      throttled: false,
    };
  }

  if (record.executablesOutsidePolicy.length > 0) {
    return {
      status: 'scopeFailure',
      detail: `this attempt ran ${record.executablesOutsidePolicy.join(', ')}, which this case's executable allow-list `
        + 'does not name. What ran is not what was authorised, so the outcome is not a reading of the task.',
      throttled: false,
    };
  }

  if (!record.scope.clean) {
    return { status: 'scopeFailure', detail: describeScopeAssessment(record.scope), throttled: false };
  }

  if (record.cleanliness.length > 0) {
    return {
      status: 'patchFailure',
      detail: record.cleanliness.map((finding) => finding.detail).join('; '),
      throttled: false,
    };
  }

  const ceilingFiles = workspaceCase.verification.maximumChangedFiles;
  const ceilingLines = workspaceCase.verification.maximumChangedLines;
  const changedLines = record.diff.addedLineCount + record.diff.removedLineCount;
  if (ceilingFiles > 0 && record.diff.changes.length > ceilingFiles) {
    return {
      status: 'patchFailure',
      detail: `this change touches ${record.diff.changes.length} files; the case allows ${ceilingFiles}. A change that `
        + 'rewrites more of a repository than the task needs is not a change a reviewer could take.',
      throttled: false,
    };
  }
  if (ceilingLines > 0 && changedLines > ceilingLines) {
    return {
      status: 'patchFailure',
      detail: `this change is ${changedLines} lines; the case allows ${ceilingLines}.`,
      throttled: false,
    };
  }

  const allOutcomes = [...record.verificationOutcomes, ...record.hiddenOutcomes];
  const brokenBuild = failedRequired(allOutcomes, ['build', 'typecheck']);
  if (brokenBuild) {
    return {
      status: 'compilationFailure',
      detail: `${brokenBuild.commandID} (${brokenBuild.kind}) failed: ${brokenBuild.failureDetail ?? `exit ${brokenBuild.exitCode}`}. `
        + `${brokenBuild.stderrTail || brokenBuild.stdoutTail}`.trim(),
      throttled: false,
    };
  }

  const brokenTest = failedRequired(allOutcomes, ['test', 'hidden']);
  if (brokenTest) {
    return {
      status: 'behavioralFailure',
      detail: `${brokenTest.commandID} (${brokenTest.kind}) failed: ${brokenTest.failureDetail ?? `exit ${brokenTest.exitCode}`}. `
        + `${brokenTest.stderrTail || brokenTest.stdoutTail}`.trim(),
      throttled: false,
    };
  }

  // A regression with every required check green means a check that USED to pass and is not required.
  // It is still a regression, and it is still not a pass.
  if (regressionCount > 0) {
    return {
      status: 'behavioralFailure',
      detail: `${regressionCount} check(s) that passed before this change no longer pass. The task may have been done; `
        + 'something else was broken doing it.',
      throttled: false,
    };
  }

  const unsatisfied = record.invariantOutcomes.filter((outcome) => !outcome.satisfied);
  if (unsatisfied.length > 0) {
    return { status: 'fail', detail: unsatisfied.map((outcome) => outcome.detail).join('; '), throttled: false };
  }

  const brokenOptional = allOutcomes.find((outcome) => !outcome.required && !outcome.passed);
  if (brokenOptional) {
    return {
      status: 'partial',
      detail: `every required check passed; the non-gating ${brokenOptional.commandID} (${brokenOptional.kind}) did not.`,
      throttled: false,
    };
  }

  if (record.diff.clean) {
    // Everything passed and nothing changed. Recorded as a pass with the fact stated, because a case
    // whose answer is genuinely "no change needed" exists — and a reader must be able to tell that
    // outcome from a model that did the work.
    return {
      status: 'pass',
      detail: 'every declared check passed and the tree is unchanged: this attempt made no edit at all.',
      throttled: false,
    };
  }

  return {
    status: 'pass',
    detail: `every declared check passed; ${record.diff.changes.length} file(s), `
      + `+${record.diff.addedLineCount}/-${record.diff.removedLineCount} lines.`,
    throttled: false,
  };
}

// MARK: - Metrics

function buildMetrics(workspaceCase: WorkspaceCase, run: WorkspaceRunResult, record: WorkspaceAttemptRecord,
                      transitions: CheckTransition[], status: TerminalSlotStatus): Record<string, MetricReading> {
  const metrics: Record<string, MetricReading> = {};
  const measurable = status !== 'runtimeError' && status !== 'safetyAbort' && status !== 'envelopeFailure' && status !== 'timeout';

  if (!measurable) {
    const reason = `this attempt ended as ${status}, so nothing about the model's work was measured`;
    for (const name of ['taskSuccess', 'testsPassed', 'regressionFree', 'scopeRespected', 'patchClean', 'firstAttempt', 'patchEconomy']) {
      metrics[name] = noMetric(reason);
    }
    return metrics;
  }

  metrics.taskSuccess = metric(status === 'pass' ? 1_000 : status === 'partial' ? 500 : 0);

  const gating = [...record.verificationOutcomes, ...record.hiddenOutcomes].filter((outcome) => outcome.required);
  metrics.testsPassed = gating.length === 0
    ? noMetric('this case declares no required verification command, so there is no pass rate to compute')
    : metric(Math.round((gating.filter((outcome) => outcome.passed).length * 1_000) / gating.length));

  const known = transitions.filter((transition) => transition.transition !== 'unknownBefore');
  metrics.regressionFree = known.length === 0
    ? noMetric('this case established no baseline reading, so no check has a before and an after and a regression '
      + 'cannot be distinguished from a failure that was already there')
    : metric(known.some((transition) => transition.transition === 'regression') ? 0 : 1_000);

  metrics.scopeRespected = metric(record.scope.clean && record.executablesOutsidePolicy.length === 0 ? 1_000 : 0);
  metrics.patchClean = workspaceCase.verification.requirePatchCleanliness
    ? metric(record.cleanliness.length === 0 ? 1_000 : 0)
    : noMetric('this case does not require patch cleanliness, so it was not checked');

  metrics.firstAttempt = workspaceCase.execution.maximumAttempts <= 1
    ? noMetric('this case allows one attempt, so recovery was never on offer and a first-attempt score would only '
      + 'restate the task outcome')
    : metric(status === 'pass' && run.attemptsUsed === 1 ? 1_000
      : status === 'pass' ? Math.max(0, Math.round(1_000 / run.attemptsUsed)) : 0);

  const ceilingLines = workspaceCase.verification.maximumChangedLines;
  const changedLines = record.diff.addedLineCount + record.diff.removedLineCount;
  metrics.patchEconomy = ceilingLines <= 0
    ? noMetric('this case declares no change ceiling, so there is no size a patch can be economical against')
    : metric(changedLines === 0 ? 1_000 : Math.max(0, Math.min(1_000, Math.round(((ceilingLines - changedLines + 1) * 1_000) / ceilingLines))));

  return metrics;
}

const WEIGHT_OF: Record<string, keyof WorkspaceCase['scoring']> = {
  taskSuccess: 'taskSuccessWeightMilli',
  testsPassed: 'testsPassedWeightMilli',
  regressionFree: 'regressionFreeWeightMilli',
  scopeRespected: 'scopeRespectedWeightMilli',
  patchClean: 'patchCleanWeightMilli',
  firstAttempt: 'firstAttemptWeightMilli',
  patchEconomy: 'patchEconomyWeightMilli',
};

/**
 * The weighted composite, renormalized over the metrics that exist.
 *
 * Renormalized rather than summed against the full weight, because a case that does not ask a
 * question must not cost a model the marks for it. The divisor is therefore the weight of what was
 * MEASURED, and a composite over nothing is unavailable rather than zero.
 */
export function composite(workspaceCase: WorkspaceCase, metrics: Record<string, MetricReading>): MetricReading {
  let weighted = 0;
  let totalWeight = 0;
  const missing: string[] = [];
  for (const [name, weightField] of Object.entries(WEIGHT_OF)) {
    const reading = metrics[name];
    const weight = workspaceCase.scoring[weightField] as number;
    if (weight <= 0) continue;
    if (reading === undefined || reading.valueMilli === undefined) { missing.push(name); continue; }
    weighted += reading.valueMilli * weight;
    totalWeight += weight;
  }
  if (totalWeight === 0) {
    return noMetric(`no weighted metric was measurable on this attempt (${missing.join(', ') || 'no weights declared'})`);
  }
  return metric(Math.round(weighted / totalWeight));
}

/** The one line a terminal, a ledger row and a report all print. */
export function describeScorecard(card: WorkspaceScorecard): string {
  const score = card.compositeMilli.valueMilli === undefined
    ? 'score unavailable'
    : `score ${(card.compositeMilli.valueMilli / 10).toFixed(1)}%`;
  const retries = card.retriesRequired > 0 ? `, ${card.retriesRequired} retry(ies)` : '';
  return `${card.status} · ${score} · ${card.changedFileCount} file(s), ${card.changedLineCount} line(s)${retries} — ${card.detail}`;
}
