// Cernum core · run executor (port of `ModelLabRunExecutor`).
// Fail-closed at every step; every attempt is RECORDED, never thrown; evidence is never rolled back.

import { AttemptRequest, CancellationToken, EvaluationAdapter, requestDigest } from './adapter';
import { CandidateDescriptor, claimFor, configurationID, descriptorDigest, permitsPlanning } from './candidate';
import { BenchmarkCase, BenchmarkSuite, caseDigest, comparabilityKey, packageDigest, suiteDigest } from './benchmark';
import { AttemptRecord, EnvironmentRecord, Observation, PlannedAttempt, RunPlan, RunSummary, RunState, TerminalStatus, isoSeconds } from './run';
import { ResultStore } from './store';
import { parseJSONContainer } from './json';

export class ExecutionFailure extends Error {
  constructor(public readonly code: 'suiteDoesNotMatchPlan' | 'unknownCase' | 'unknownCandidate', message: string) {
    super(message);
    this.name = 'ExecutionFailure';
  }
}

export interface ExecutionProgress {
  /** Called before each attempt is invoked. */
  onAttemptStarting?: (planned: PlannedAttempt, index: number, total: number) => void;
  /** Called after each attempt record is appended (awaited, so a caller may evaluate it in place). */
  onAttemptRecorded?: (record: AttemptRecord, recorded: number, total: number) => void | Promise<void>;
}

export class RunExecutor {
  constructor(
    private readonly adapter: EvaluationAdapter,
    private readonly store: ResultStore,
    private readonly environment: EnvironmentRecord,
    private readonly now: () => Date,
  ) {}

  async execute(plan: RunPlan, suite: BenchmarkSuite, cancellation: CancellationToken, progress: ExecutionProgress = {}): Promise<RunSummary> {
    const digest = suiteDigest(suite);
    if (digest !== plan.suiteDigest) {
      throw new ExecutionFailure('suiteDoesNotMatchPlan', `suite digest ${digest} does not match the plan's sealed suite digest ${plan.suiteDigest} — refused`);
    }
    const casesByID = new Map(suite.cases.map((c) => [c.id.raw, c]));
    const candidatesByID = new Map(plan.candidates.map((c) => [c.id.raw, c]));

    // The plan enters the permanent history first — a run that dies mid-way is still evidence.
    await this.store.appendPlan(plan);

    const statusCounts: Record<string, number> = {};
    let recorded = 0;
    let cancelledEarly = false;
    const total = plan.plannedAttempts.length;

    for (const planned of plan.plannedAttempts) {
      if (cancellation.isCancelled) {
        cancelledEarly = true;
        break;
      }
      const benchmarkCase = casesByID.get(planned.caseID.raw);
      if (!benchmarkCase) throw new ExecutionFailure('unknownCase', `plan references case ${planned.caseID.raw} the suite does not contain`);
      const candidate = candidatesByID.get(planned.candidateID.raw);
      if (!candidate) throw new ExecutionFailure('unknownCandidate', `plan references candidate ${planned.candidateID.raw} it does not carry`);

      progress.onAttemptStarting?.(planned, recorded, total);
      const startedAt = this.now();
      const record = await this.executeOne(plan.runID, planned, benchmarkCase, candidate, startedAt, cancellation);
      await this.store.appendAttempt(record);
      statusCounts[record.terminalStatus] = (statusCounts[record.terminalStatus] ?? 0) + 1;
      recorded += 1;
      await progress.onAttemptRecorded?.(record, recorded, total);
    }

    let state: RunState;
    if (cancelledEarly) state = 'cancelled';
    else if (recorded === total) state = 'completed';
    else state = 'incomplete';

    const summary: RunSummary = {
      runID: plan.runID, planDigest: plan.planDigest, state,
      plannedAttemptCount: total, recordedAttemptCount: recorded, statusCounts, completedAt: isoSeconds(this.now()),
    };
    await this.store.appendSummary(summary);
    return summary;
  }

  private async executeOne(runID: string, planned: PlannedAttempt, benchmarkCase: BenchmarkCase, candidate: CandidateDescriptor,
                           startedAt: Date, cancellation: CancellationToken): Promise<AttemptRecord> {
    const request: AttemptRequest = {
      attemptID: planned.attemptID,
      messages: benchmarkCase.inputs.messages,
      syntheticContext: benchmarkCase.inputs.syntheticContext,
      generationSettings: benchmarkCase.generationSettings,
      responseFormat: benchmarkCase.responseFormat,
      executionBudgetMilliseconds: benchmarkCase.executionBudgetMilliseconds,
    };
    const digest = requestDigest(request);
    const synthesized = (status: TerminalStatus, errors: { code: string; detail: string }[]): Observation => ({
      toolCallObservationsRaw: [],
      terminalStatus: status,
      providerReportedUsage: { unavailableReason: 'the adapter was never invoked' },
      timing: {
        totalElapsedMilliseconds: { unavailableReason: 'the adapter was never invoked' },
        firstTokenMilliseconds: { unavailableReason: 'the adapter was never invoked' },
      },
      warnings: [],
      errors,
      identityVerification: { state: 'unverifiable', reason: 'the adapter was never invoked' },
      runtimeConfigurationID: configurationID(candidate.runtimeConfiguration),
      requestDigest: digest,
    });

    let observation: Observation;
    let terminalStatus: TerminalStatus;
    const unsupported = benchmarkCase.requiredCapabilities.find((c) => !permitsPlanning(claimFor(candidate, c)));
    if (candidate.availability.state === 'unavailable') {
      // Fail closed BEFORE invocation: an unavailable candidate is never invoked.
      observation = synthesized('candidateUnavailable', [{ code: 'candidate.unavailable', detail: candidate.availability.reason }]);
      terminalStatus = 'candidateUnavailable';
    } else if (unsupported !== undefined) {
      observation = synthesized('unsupportedCapability', [{
        code: 'candidate.unsupportedCapability',
        detail: `case requires ${unsupported}; candidate claim is ${claimFor(candidate, unsupported)}`,
      }]);
      terminalStatus = 'unsupportedCapability';
    } else {
      try {
        observation = await this.adapter.invoke(request, candidate, cancellation);
      } catch (error) {
        observation = synthesized('failed', [{ code: 'adapter.threw', detail: describeError(error) }]);
      }
      terminalStatus = observation.terminalStatus;
      // Fail closed AFTER invocation: a contradicted identity poisons the attempt whatever the adapter claimed.
      if (observation.identityVerification.state === 'mismatch') terminalStatus = 'identityMismatch';
      // A JSON demand answered without parseable JSON is malformed output, not a success.
      if (terminalStatus === 'completed' && benchmarkCase.responseFormat === 'json') {
        const raw = observation.structuredOutputRaw ?? observation.outputText ?? '';
        if (parseJSONContainer(raw) === undefined) terminalStatus = 'malformedOutput';
      }
    }

    return {
      attemptID: planned.attemptID,
      runID,
      ordinal: planned.ordinal,
      repetitionIndex: planned.repetitionIndex,
      candidate,
      candidateDigest: descriptorDigest(candidate),
      suiteID: benchmarkCase.suiteID,
      suiteVersion: benchmarkCase.suiteVersion,
      caseID: benchmarkCase.id,
      caseDigest: caseDigest(benchmarkCase),
      inputPackage: benchmarkCase.inputs,
      inputPackageDigest: packageDigest(benchmarkCase.inputs),
      scoringPolicyID: benchmarkCase.scoringPolicyID,
      scoringPolicyVersion: benchmarkCase.scoringPolicyVersion,
      environment: this.environment,
      observation,
      terminalStatus,
      comparabilityKey: comparabilityKey(benchmarkCase),
      startedAt: isoSeconds(startedAt),
      finishedAt: isoSeconds(this.now()),
    };
  }
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
