// The provider-throttle circuit breaker, the efficiency split, unproductive spend, the repeats
// provenance wording, and the non-model session preflight.
//
// WHAT THIS FILE IS ANSWERING. The first full forty-eight-run Claude matrix produced forty-eight
// honest durable records and one measured pass. The Claude subscription hit its session limit on
// the second run, and the matrix went on to hand the same exhausted session forty-six more
// workspaces. Nothing lied: every declined run was classified as a provider decline, no model was
// blamed, the fixtures stayed sealed. The failures were all in what happened NEXT — the matrix kept
// launching, the aggregate presented 429 response times as model latency, and a run that spent
// 86,332 tokens before being cut off reported zero waste. Each of those is asserted below.
//
// NO PROVIDER IS CONTACTED, AND NO MODEL IS INVOKED. The matrix tests drive a scripted driver
// against the real sealed fixtures; the aggregate tests are arithmetic over rows written by hand;
// the preflight test asserts the probe's argv WITHOUT running a process at all.

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DiscoveryEvidence } from '../../src/engine/discovery-store';
import { SYNTHETIC_HARDWARE } from '../../src/engine/synthetic';
import { provenModel } from './frontier-harness';
import { RECEIPT_REFUNDS_SIGN, TASK_PRIORITY_PROPAGATE, allWorkspaceCases } from '../../src/engine/workspace-catalog';
import { makeWorkspaceBenchmarkPack } from '../../src/engine/workspace-pack';
import {
  ScriptedAttempt, ScriptedWorkspaceAgent, WorkspaceAgentDriver, WorkspaceAgentRequest,
} from '../../src/engine/workspace-agent';
import { WorkspaceAgentUsage } from '../../src/engine/workspace-host';
import {
  WorkspaceMatrixRequest, buildWorkspaceMatrixPlan, describeWorkspaceMatrixPlan,
  describeWorkspaceMatrixRunResult, runWorkspaceMatrix,
} from '../../src/engine/workspace-matrix';
import {
  WorkspaceRunRow, aggregateWorkspaceCell, collectWorkspaceRunRows, describeWorkspaceCell,
} from '../../src/engine/workspace-aggregate';
import {
  NON_MODEL_SESSION_PROBES, assertNonModelProbe, describeProviderSessionStatus,
  readProviderSessionStatus, sessionPreflightRefusal,
} from '../../src/engine/provider-session-status';
import {
  detectProviderThrottle, parseThrottleReset, providerThrottleScopeFor, throttleBlocks,
} from '../../src/engine/workspace-throttle';
import { CLIResult } from '../../src/engine/cli-process';

const FIXTURE_ROOT = path.resolve(__dirname, '../../fixtures');
const MODELS = ['claude-haiku-4-5', 'claude-sonnet-5'];

/** The message Claude Code actually returned in the failed matrix, kept verbatim. */
const REAL_SESSION_LIMIT = 'the CLI reported a failed turn (api_error, HTTP 429): You\'ve hit your session limit · '
  + 'resets 8:10pm (America/Chicago)';

const temporaries: string[] = [];
afterEach(() => { for (const directory of temporaries.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

function temporary(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaries.push(directory);
  return directory;
}

const PROVEN: DiscoveryEvidence = {
  writtenAt: new Date().toISOString(),
  models: MODELS.map((modelID) => ({ ...provenModel('claudeCLI', modelID), discoveredAt: new Date().toISOString() })),
};

const USAGE: WorkspaceAgentUsage = {
  inputTokens: 6_000, freshInputTokens: 100, cacheCreationInputTokens: 5_800, cacheReadInputTokens: 100,
  visibleOutputTokens: 400, reasoningTokens: 60, subscriptionIncludedUsageMicroUSD: 20_000,
  observedFirstOutputMilliseconds: 700,
};

const THROTTLED: ScriptedAttempt = { steps: [{ do: 'fail', kind: 'rateLimited', detail: REAL_SESSION_LIMIT }] };
const CHANGES_NOTHING: ScriptedAttempt = { steps: [{ do: 'say', text: 'It looks correct to me.' }] };
const TRANSPORT_FAULT: ScriptedAttempt = {
  steps: [{ do: 'fail', kind: 'transport', detail: 'the connection was reset once' }],
};

/**
 * A driver whose script depends on the model AND on how many times it has already been asked, so a
 * matrix can be made to throttle on its FIRST run and would happily keep answering afterwards —
 * which is exactly what makes "nothing after it ran" a real assertion rather than a tautology.
 */
function scriptedFactory(options: {
  scripts: Record<string, ScriptedAttempt[]>;
  /** Called for every run the driver is actually asked to do. The witness the breaker is tested by. */
  onRun?: (modelID: string, caseID: string) => void;
  firstRunScript?: Record<string, ScriptedAttempt[]>;
}): NonNullable<WorkspaceMatrixRequest['driverFactory']> {
  const runsByModel = new Map<string, number>();
  return (binding) => {
    const modelID = binding.requestedModelID;
    const driver: WorkspaceAgentDriver = {
      driverID: 'driver.scripted',
      provider: 'claudeCLI',
      capabilities: new ScriptedWorkspaceAgent([]).capabilities,
      async run(request: WorkspaceAgentRequest) {
        options.onRun?.(modelID, request.caseID);
        const already = runsByModel.get(modelID) ?? 0;
        // `attemptIndex` is 0 on the first attempt of every RUN, so the run counter has to be kept
        // here rather than read off the request.
        if (request.attemptIndex === 0) runsByModel.set(modelID, already + 1);
        const first = options.firstRunScript?.[modelID];
        const attempts = (already === 0 && first !== undefined) ? first
          : (options.scripts[modelID] ?? [CHANGES_NOTHING]);
        const result = await new ScriptedWorkspaceAgent(attempts).run(request);
        return { ...result, usage: USAGE, reportedModelID: modelID };
      },
    };
    return driver;
  };
}

/** Two cases, one attempt each, one repeat: four cells, and a fast matrix. */
const TWO_CASE_PACK = makeWorkspaceBenchmarkPack({
  id: 'pack.test.resilience',
  version: '1',
  caseIDs: [RECEIPT_REFUNDS_SIGN.id, TASK_PRIORITY_PROPAGATE.id],
  repeatsPerCase: 1,
});

function matrixRequest(overrides: Partial<WorkspaceMatrixRequest> = {}): WorkspaceMatrixRequest {
  return {
    pack: TWO_CASE_PACK,
    cases: allWorkspaceCases(),
    provider: 'claudeCLI',
    modelIDs: MODELS,
    effort: 'none',
    discovery: PROVEN,
    campaignRoot: temporary('cernum-ws-breaker-'),
    fixtureRoot: FIXTURE_ROOT,
    sandboxRoot: temporary('cernum-ws-sandbox-'),
    runLabel: 'breaker',
    driverFactory: scriptedFactory({ scripts: {} }),
    environmentSource: { PATH: process.env.PATH, HOME: '/tmp/home', USER: 'somebody' },
    ...overrides,
  };
}

// MARK: - The breaker's scope vocabulary, on its own

describe('a throttle carries how far it reaches, declared rather than assumed', () => {
  it('declares the Claude CLI session limit as subscription-session scoped', () => {
    const decision = providerThrottleScopeFor('claudeCLI');
    expect(decision.scope).toBe('subscriptionSession');
    expect(decision.declared).toBe(true);
    expect(decision.sessionKey).toBe('claudeCLI');
    expect(decision.note).toContain('one signed-in subscription session');
  });

  it('does NOT claim to know an undeclared provider\'s scope, and says so where it is used', () => {
    const decision = providerThrottleScopeFor('openaiAPI');
    expect(decision.declared).toBe(false);
    expect(decision.note).toContain('has NOT declared');
  });

  it('blocks by scope: a route-scoped throttle leaves the other routes alone', () => {
    const base = detectProviderThrottle({
      provider: 'claudeCLI',
      candidate: 'claudeCLI:claude-haiku-4-5',
      caseID: RECEIPT_REFUNDS_SIGN.id,
      repeatIndex: 1,
      recordRoot: '/somewhere',
      providerThrottled: true,
      detail: REAL_SESSION_LIMIT,
      failureKind: 'rateLimited',
    })!;
    // As declared: the session is shared, so another model on the same CLI is blocked too.
    expect(throttleBlocks(base, { provider: 'claudeCLI', candidate: 'claudeCLI:claude-opus-5' })).toBe(true);
    // A route-scoped version of the same signal would not be.
    const perRoute = { ...base, scope: 'route' as const };
    expect(throttleBlocks(perRoute, { provider: 'claudeCLI', candidate: 'claudeCLI:claude-opus-5' })).toBe(false);
    expect(throttleBlocks(perRoute, { provider: 'claudeCLI', candidate: 'claudeCLI:claude-haiku-4-5' })).toBe(true);
    // And no signal ever reaches a different provider.
    expect(throttleBlocks(base, { provider: 'openaiAPI', candidate: 'openaiAPI:whatever' })).toBe(false);
  });

  it('reads the provider\'s own reset wording, and invents none where there is none', () => {
    expect(parseThrottleReset(REAL_SESSION_LIMIT)?.resetsAt).toBe('8:10pm (America/Chicago)');
    expect(parseThrottleReset('retry-after: 900')?.retryAfterSeconds).toBe(900);
    expect(parseThrottleReset('the provider said no and gave no time')).toBeUndefined();
  });

  it('refuses to raise a signal from anything but the two session-establishing failures', () => {
    const observation = {
      provider: 'claudeCLI' as const,
      candidate: 'claudeCLI:claude-haiku-4-5',
      caseID: RECEIPT_REFUNDS_SIGN.id,
      repeatIndex: 1,
      recordRoot: '/somewhere',
      detail: 'a thing went wrong',
    };
    expect(detectProviderThrottle({ ...observation, providerThrottled: false, failureKind: 'transport' })).toBeUndefined();
    expect(detectProviderThrottle({ ...observation, providerThrottled: false, failureKind: 'exitFailure' })).toBeUndefined();
    // A flag set with a failure kind that cannot establish a session condition is a contradiction,
    // and the honest reading of a contradiction is the narrower claim.
    expect(detectProviderThrottle({ ...observation, providerThrottled: true, failureKind: 'timeout' })).toBeUndefined();
    expect(detectProviderThrottle({ ...observation, providerThrottled: true, failureKind: 'notAuthenticated' })).toBeDefined();
  });
});

// MARK: - The breaker, in a real matrix

describe('the circuit breaker stops launching work into an exhausted session', () => {
  it('stops after the first session limit, and does not launch the affected cells', async () => {
    const launched: string[] = [];
    const request = matrixRequest({
      driverFactory: scriptedFactory({
        scripts: { 'claude-haiku-4-5': [CHANGES_NOTHING], 'claude-sonnet-5': [CHANGES_NOTHING] },
        // The FIRST run of the first model is declined; everything afterwards would have answered.
        firstRunScript: { 'claude-haiku-4-5': [THROTTLED] },
        onRun: (modelID, caseID) => launched.push(`${modelID}/${caseID}`),
      }),
    });
    const plan = buildWorkspaceMatrixPlan(request);
    expect(plan.taskRunCount).toBe(4);

    const result = await runWorkspaceMatrix(plan, request, {
      hardware: SYNTHETIC_HARDWARE, runtimeVersion: 'a test',
    });

    // 1. ONE run was launched. The driver was never asked for the other three.
    expect(launched).toHaveLength(1);
    expect(result.executedRunCount).toBe(1);
    expect(result.completed).toHaveLength(1);

    // 2. THE ORIGINAL PLAN IS INTACT. Forty-eight planned means forty-eight planned even when two
    //    ran, and the plan object the run was handed is unchanged by what happened to it.
    expect(result.plan).toBe(plan);
    expect(result.plan.cells).toHaveLength(4);
    expect(result.plannedRunCount).toBe(4);

    // 3. THE UNEXECUTED CELLS ARE NOT MODEL FAILURES. They are not recorded at all: no record
    //    directory, no ledger row, no status, no zero.
    expect(result.notExecutedBecauseThrottledCount).toBe(3);
    expect(result.notExecutedForOtherReasonCount).toBe(0);
    for (const entry of result.skipped) {
      expect(entry.disposition).toBe('providerThrottledBeforeExecution');
      expect(entry.reasons.join(' ')).toContain('providerThrottledBeforeExecution');
      expect(entry.reasons.join(' ')).toContain('not a failure of the model');
      expect(fs.existsSync(entry.cell.recordRoot)).toBe(false);
    }
    const rows = collectWorkspaceRunRows(request.campaignRoot);
    expect(rows).toHaveLength(1);

    // 4. THE SCOPE CROSSED THE MODEL BOUNDARY, because the Claude CLI's is declared session-wide.
    expect(result.skipped.map((entry) => entry.cell.modelID)).toContain('claude-sonnet-5');

    // 5. THE THROTTLE DETAIL, INCLUDING THE RESET, IS PRESERVED.
    expect(result.throttle?.failureKind).toBe('rateLimited');
    expect(result.throttle?.scope).toBe('subscriptionSession');
    expect(result.throttle?.scopeDeclared).toBe(true);
    expect(result.throttle?.detail).toContain('session limit');
    expect(result.throttle?.reset?.resetsAt).toBe('8:10pm (America/Chicago)');
    expect(result.throttle?.observedInRecordRoot).toBe(result.completed[0].cell.recordRoot);

    // 6. THE RECORD SEALED BEFORE THE STOP IS COMPLETE AND VALID, and readable as an aggregate.
    const [row] = rows;
    expect(row.row.status).toBe('runtimeError');
    expect(row.row.providerThrottled).toBe(true);
    expect(row.row.terminationReason).toBe('providerDeclined');
    const cell = aggregateWorkspaceCell(rows);
    expect(cell.runCount).toBe(1);
    expect(cell.quality.scoredRunCount).toBe(0);
    expect(cell.quality.notMeasuredRunCount).toBe(1);
    expect(cell.quality.successRateMilli.provenance).toBe('unavailable');

    // 7. AND THE REPORT SAYS PLANNED AND EXECUTED, not just executed.
    const report = describeWorkspaceMatrixRunResult(result).join('\n');
    expect(report).toContain('planned runs    4');
    expect(report).toContain('executed runs   1');
    expect(report).toContain('3 because the PROVIDER throttled');
    expect(report).toContain('resets 8:10pm');
    expect(report).toContain('stopped early because the PROVIDER declined');
  }, 240_000);

  it('does NOT trip on a model that simply failed the task', async () => {
    const launched: string[] = [];
    const request = matrixRequest({
      driverFactory: scriptedFactory({
        scripts: { 'claude-haiku-4-5': [CHANGES_NOTHING], 'claude-sonnet-5': [CHANGES_NOTHING] },
        onRun: (modelID, caseID) => launched.push(`${modelID}/${caseID}`),
      }),
    });
    const plan = buildWorkspaceMatrixPlan(request);
    const result = await runWorkspaceMatrix(plan, request, {
      hardware: SYNTHETIC_HARDWARE, runtimeVersion: 'a test',
    });

    expect(result.throttle).toBeUndefined();
    expect(result.executedRunCount).toBe(4);
    expect(result.notExecutedBecauseThrottledCount).toBe(0);
    expect(launched).toHaveLength(4);
    // Every one of them is a behavioural failure, and a behavioural failure is a RESULT.
    for (const entry of result.completed) expect(entry.status).toBe('behavioralFailure');
  }, 240_000);

  it('does NOT trip on a single transport fault that says nothing about the session', async () => {
    const request = matrixRequest({
      driverFactory: scriptedFactory({
        scripts: { 'claude-haiku-4-5': [CHANGES_NOTHING], 'claude-sonnet-5': [CHANGES_NOTHING] },
        firstRunScript: { 'claude-haiku-4-5': [TRANSPORT_FAULT] },
      }),
    });
    const plan = buildWorkspaceMatrixPlan(request);
    const result = await runWorkspaceMatrix(plan, request, {
      hardware: SYNTHETIC_HARDWARE, runtimeVersion: 'a test',
    });

    expect(result.throttle).toBeUndefined();
    expect(result.executedRunCount).toBe(4);
    expect(result.notExecutedBecauseThrottledCount).toBe(0);
    // The faulted run IS sealed, as a runtime error — it just does not stop the other three.
    const statuses = result.completed.map((entry) => entry.status).sort();
    expect(statuses.filter((status) => status === 'runtimeError')).toHaveLength(1);
  }, 240_000);
});

// MARK: - Efficiency, and unproductive spend, as arithmetic over rows

/** A ledger row, by hand, with only the fields these aggregates read. */
function row(overrides: Record<string, unknown>): WorkspaceRunRow {
  return {
    recordRoot: `/records/${String(overrides.status ?? 'row')}-${Math.random().toString(36).slice(2, 8)}`,
    row: {
      candidate: 'claudeCLI:claude-haiku-4-5',
      provider: 'claudeCLI',
      requestedModelID: 'claude-haiku-4-5',
      executionClass: 'subscriptionCLI',
      billingBasis: 'subscriptionIncluded',
      bindingIdentityState: 'verified',
      caseID: 'ws.receipt-refunds.sign',
      caseVersion: '1',
      comparabilityKey: 'cwk1:test',
      scoringPolicyID: 'p', scoringPolicyVersion: '1',
      caseMaximumAttempts: 1,
      repeatIndex: 1, repeatsPlanned: 3,
      attemptsUsed: 1,
      retryCount: 0,
      usageProvenance: 'providerReported',
      costProvenance: 'measured',
      costMicroUSD: 0,
      subscriptionAllowanceState: 'reported',
      subscriptionAllowanceProvenance: 'providerReported',
      inputTokens: 0, visibleOutputTokens: 0, reasoningTokens: 0,
      wastedTokens: 0,
      ...overrides,
    },
  };
}

/** The Haiku run that spent 86,332 tokens and was cut off by the session limit. */
const INTERRUPTED_86K = row({
  status: 'runtimeError',
  providerThrottled: true,
  terminationReason: 'providerDeclined',
  detail: `rateLimited: ${REAL_SESSION_LIMIT}`,
  totalTokens: 86_332,
  inputTokens: 76_575, visibleOutputTokens: 3_277, reasoningTokens: 2_260,
  subscriptionIncludedUsageMicroUSD: 32_535,
  wallClockMilliseconds: 27_603,
  latencyMilliseconds: 27_603,
  timeToFirstTokenMilliseconds: 489,
});

/** A declined run that never got started: a 429 in under two seconds, with nothing spent. */
const DECLINED_EMPTY = row({
  status: 'runtimeError',
  providerThrottled: true,
  terminationReason: 'providerDeclined',
  detail: `rateLimited: ${REAL_SESSION_LIMIT}`,
  totalTokens: 0,
  subscriptionIncludedUsageMicroUSD: 0,
  wallClockMilliseconds: 1_556,
  latencyMilliseconds: 1_556,
  timeToFirstTokenMilliseconds: 489,
});

/** A real pass, with real model timing. */
const REAL_PASS = row({
  status: 'pass',
  providerThrottled: false,
  totalTokens: 94_766,
  inputTokens: 90_000, visibleOutputTokens: 4_766,
  subscriptionIncludedUsageMicroUSD: 25_856,
  wallClockMilliseconds: 18_476,
  latencyMilliseconds: 18_476,
  timeToFirstTokenMilliseconds: 674,
  compositeMilli: 1_000,
  metricsMilli: { patchClean: { valueMilli: 1_000 } },
  verificationOutcomes: [{ required: true, passed: true }],
});

describe('efficiency columns measure the model, not how fast a 429 came back', () => {
  it('reports model TTFT as unavailable for a cell whose every run was declined', () => {
    const cell = aggregateWorkspaceCell([DECLINED_EMPTY, DECLINED_EMPTY, DECLINED_EMPTY]);
    expect(cell.efficiency.modelTimedRunCount).toBe(0);
    expect(cell.efficiency.providerDeclinedRunCount).toBe(3);
    expect(cell.efficiency.modelTimeToFirstTokenMilliseconds.mean.provenance).toBe('unavailable');
    expect(cell.efficiency.modelTimeToFirstTokenMilliseconds.mean.note).toContain('how fast the provider refused');
  });

  it('reports model wall time as unavailable for the same cell, and never as a zero', () => {
    const cell = aggregateWorkspaceCell([DECLINED_EMPTY, DECLINED_EMPTY, DECLINED_EMPTY]);
    expect(cell.efficiency.modelWallClockMilliseconds.median.provenance).toBe('unavailable');
    expect(cell.efficiency.modelWallClockMilliseconds.median.value).toBeUndefined();
    expect(cell.wallClockMilliseconds.median.provenance).toBe('unavailable');
    // And the one-line rendering says `declined` rather than printing a time it does not have.
    expect(describeWorkspaceCell(cell)).toContain('declined');
  });

  it('keeps the provider\'s operational timing rather than discarding the evidence', () => {
    const cell = aggregateWorkspaceCell([DECLINED_EMPTY, DECLINED_EMPTY, DECLINED_EMPTY]);
    expect(cell.efficiency.operationalWallClockMilliseconds.count).toBe(3);
    expect(cell.efficiency.operationalWallClockMilliseconds.median.value).toBe(1_556);
    expect(cell.efficiency.providerDeclineWallClockMilliseconds.count).toBe(3);
    expect(cell.efficiency.providerDeclineWallClockMilliseconds.median.value).toBe(1_556);
  });

  it('still aggregates timing normally for a run that measured a model', () => {
    const cell = aggregateWorkspaceCell([REAL_PASS, REAL_PASS]);
    expect(cell.efficiency.modelTimedRunCount).toBe(2);
    expect(cell.efficiency.modelWallClockMilliseconds.median.value).toBe(18_476);
    expect(cell.efficiency.modelTimeToFirstTokenMilliseconds.median.value).toBe(674);
    expect(cell.wallClockMilliseconds.median.value).toBe(18_476);
  });

  it('excludes the declined run from model timing when a cell holds both kinds', () => {
    const cell = aggregateWorkspaceCell([REAL_PASS, DECLINED_EMPTY, DECLINED_EMPTY]);
    expect(cell.efficiency.modelTimedRunCount).toBe(1);
    // The model columns see only the pass; the operational column sees all three.
    expect(cell.efficiency.modelWallClockMilliseconds.count).toBe(1);
    expect(cell.efficiency.modelWallClockMilliseconds.median.value).toBe(18_476);
    expect(cell.efficiency.operationalWallClockMilliseconds.count).toBe(3);
    expect(cell.efficiency.operationalWallClockMilliseconds.median.value).toBe(1_556);
  });
});

describe('unproductive spend: resources an executed run consumed without producing a result', () => {
  it('reports none for a cell whose runs all produced an outcome', () => {
    const cell = aggregateWorkspaceCell([REAL_PASS, REAL_PASS]);
    expect(cell.unproductiveSpend.unproductiveRunCount).toBe(0);
    expect(cell.unproductiveSpend.unproductiveTokens).toEqual(
      expect.objectContaining({ provenance: 'measured', value: 0 }));
    expect(cell.unproductiveSpend.unproductiveAllowanceMicroUSD.value).toBe(0);
    expect(cell.unproductiveSpend.totalNonResultTokens.value).toBe(0);
  });

  it('counts the whole spend of a provider-declined run that had already consumed tokens', () => {
    const cell = aggregateWorkspaceCell([INTERRUPTED_86K]);
    expect(cell.unproductiveSpend.unproductiveRunCount).toBe(1);
    expect(cell.unproductiveSpend.providerDeclinedRunCount).toBe(1);
    expect(cell.unproductiveSpend.unproductiveTokens.value).toBe(86_332);
    expect(cell.unproductiveSpend.unproductiveAllowanceMicroUSD.value).toBe(32_535);
    expect(cell.unproductiveSpend.unproductiveMarginalChargeMicroUSD.value).toBe(0);
    // The run used one attempt, so `wastedTokens` is 0 under its own definition — which is exactly
    // why the whole-run figure had to exist. The old field keeps its meaning.
    expect(cell.metrics.wastedTokens.value).toBe(0);
  });

  it('does not double-count retry waste against whole-run unproductive spend', () => {
    // A run that RETRIED and then passed: 500 of its tokens went on the discarded first attempt.
    const retriedPass = row({
      status: 'pass', providerThrottled: false, attemptsUsed: 2, retryCount: 1,
      totalTokens: 10_000, wastedTokens: 500,
      subscriptionIncludedUsageMicroUSD: 4_000,
      wallClockMilliseconds: 9_000, latencyMilliseconds: 9_000, timeToFirstTokenMilliseconds: 500,
      compositeMilli: 900,
    });
    const cell = aggregateWorkspaceCell([retriedPass, INTERRUPTED_86K]);

    // The retried PASS contributes its retry waste and nothing else.
    expect(cell.unproductiveSpend.retryWastedTokens.value).toBe(500);
    // The declined run contributes its whole spend and no retry waste.
    expect(cell.unproductiveSpend.unproductiveTokens.value).toBe(86_332);
    expect(cell.unproductiveSpend.unproductiveRunCount).toBe(1);
    // The total is the sum, and 86,332 is not counted twice.
    expect(cell.unproductiveSpend.totalNonResultTokens.value).toBe(86_832);
    expect(cell.unproductiveSpend.definition).toContain('disjoint');
  });

  it('accounts allowance where the provider valued it, and refuses a total where it did not', () => {
    const unvalued = row({
      status: 'runtimeError', providerThrottled: true, terminationReason: 'providerDeclined',
      totalTokens: 1_000,
      subscriptionAllowanceState: 'unavailable',
      subscriptionIncludedUsageMicroUSD: undefined,
      wallClockMilliseconds: 900, latencyMilliseconds: 900,
    });
    const cell = aggregateWorkspaceCell([INTERRUPTED_86K, unvalued]);
    expect(cell.unproductiveSpend.unproductiveTokens.value).toBe(87_332);
    // One of the two reported no valuation, so the ALLOWANCE total is unavailable rather than an
    // undercount presented as a total — and it is explicitly not zero.
    expect(cell.unproductiveSpend.unproductiveAllowanceMicroUSD.provenance).toBe('unavailable');
    expect(cell.unproductiveSpend.unproductiveAllowanceMicroUSD.note).toContain('not zero');
  });

  it('leaves a cell that was never executed out of the accounting entirely', () => {
    // There is no row for a deferred cell, so a cell aggregate simply has fewer runs than planned —
    // and `repeatsPlanned` beside `runCount` is what says so.
    const cell = aggregateWorkspaceCell([REAL_PASS]);
    expect(cell.runCount).toBe(1);
    expect(cell.repeatsPlanned).toBe(3);
    expect(cell.unproductiveSpend.unproductiveRunCount).toBe(0);
  });
});

// MARK: - Repeats provenance

describe('the dry run says who chose the repeat count, and only calls an override an override', () => {
  it('names the pack when the operator asked for nothing', () => {
    const plan = buildWorkspaceMatrixPlan(matrixRequest());
    expect(plan.repeatsFrom).toBe('pack');
    expect(plan.repeatsPerCase).toBe(1);
    expect(plan.packRepeatsPerCase).toBe(1);
    const printed = describeWorkspaceMatrixPlan(plan).join('\n');
    expect(printed).toContain('the sealed pack\'s own number');
    expect(printed).not.toContain('OVERRIDING');
  });

  it('says EQUAL, not "different", when the operator names the pack\'s own number', () => {
    const plan = buildWorkspaceMatrixPlan(matrixRequest({ repeatsPerCase: 1 }));
    expect(plan.repeatsFrom).toBe('operatorMatchedPack');
    const printed = describeWorkspaceMatrixPlan(plan).join('\n');
    expect(printed).toContain('the same number the pack asks for');
    expect(printed).toContain('this is not an override');
    expect(printed).not.toContain('OVERRIDING');
    expect(printed).not.toContain('different number');
  });

  it('calls a real override an override, and names what the pack asked for', () => {
    const plan = buildWorkspaceMatrixPlan(matrixRequest({ repeatsPerCase: 3 }));
    expect(plan.repeatsFrom).toBe('operatorOverrodePack');
    expect(plan.repeatsPerCase).toBe(3);
    expect(plan.packRepeatsPerCase).toBe(1);
    const printed = describeWorkspaceMatrixPlan(plan).join('\n');
    expect(printed).toContain('OVERRIDING the sealed pack, which asks for 1');
  });
});

// MARK: - The session preflight

describe('the session preflight asks about the session and cannot reach a model', () => {
  it('declares one frozen, prompt-free argv per provider and refuses anything else', () => {
    const probe = NON_MODEL_SESSION_PROBES.claudeCLI!;
    expect(probe.args).toEqual(['auth', 'status', '--json']);
    // Nothing in it can carry a prompt, resume a conversation or select a model.
    for (const forbidden of ['-p', '--print', '--prompt', '-c', '--continue', '--resume', '--model']) {
      expect(probe.args).not.toContain(forbidden);
    }
    expect(() => assertNonModelProbe(probe)).not.toThrow();
    // An argv that is not the frozen one is refused, however innocuous it looks…
    expect(() => assertNonModelProbe({ ...probe, args: ['auth', 'status'] })).toThrow(/not the frozen probe/);
    // …and one that could reach a model is refused by name.
    expect(() => assertNonModelProbe({ ...probe, args: ['-p', 'hello'] })).toThrow(/not the frozen probe/);
  });

  it('runs exactly that argv and nothing else when it probes', async () => {
    const seen: { executable: string; args: string[] }[] = [];
    const status = await readProviderSessionStatus({
      provider: 'claudeCLI',
      runCommand: async (request) => {
        seen.push({ executable: request.executable, args: [...request.args] });
        return {
          stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' }),
          stderr: '', exitCode: 0, signal: null, elapsedMilliseconds: 40,
        } as CLIResult;
      },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].args).toEqual(['auth', 'status', '--json']);
    // No stdin was written, which is the other way a prompt could have travelled.
    expect(status.probeSucceeded).toBe(true);
    expect(status.signedIn).toBe(true);
    expect(status.subscriptionType).toBe('max');
  });

  it('reports remaining allowance as UNAVAILABLE rather than guessing at one', async () => {
    const status = await readProviderSessionStatus({
      provider: 'claudeCLI',
      runCommand: async () => ({
        stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' }),
        stderr: '', exitCode: 0, signal: null, elapsedMilliseconds: 40,
      } as CLIResult),
    });
    expect(status.remainingAllowance.provenance).toBe('unavailable');
    expect(status.remainingAllowance.value).toBeUndefined();
    expect(status.remainingAllowance.note).toContain('no remaining-allowance figure');
    // A plan tier is reported as a plan tier, and is never converted into a budget.
    expect(status.subscriptionType).toBe('max');
    expect(status.throttleState).toBe('notReported');

    const printed = describeProviderSessionStatus(status).join('\n');
    expect(printed).toContain('allowance     NOT KNOWN');
    expect(printed).toContain('NOT REPORTED');
    // There is nothing here to refuse a matrix on: a signed-in session is all it can establish.
    expect(sessionPreflightRefusal(status)).toBeUndefined();
  });

  it('refuses a matrix when the probe establishes there is no session at all', async () => {
    const status = await readProviderSessionStatus({
      provider: 'claudeCLI',
      runCommand: async () => ({
        stdout: JSON.stringify({ loggedIn: false }),
        stderr: '', exitCode: 0, signal: null, elapsedMilliseconds: 20,
      } as CLIResult),
    });
    expect(status.signedIn).toBe(false);
    expect(sessionPreflightRefusal(status)).toContain('no signed-in session');
  });

  it('survives a tool that answered in an unfamiliar shape, without claiming anything', async () => {
    const status = await readProviderSessionStatus({
      provider: 'claudeCLI',
      runCommand: async () => ({
        stdout: 'Logged in as somebody', stderr: '', exitCode: 0, signal: null, elapsedMilliseconds: 20,
      } as CLIResult),
    });
    expect(status.probeSucceeded).toBe(false);
    expect(status.probeFailure).toContain('documented JSON');
    expect(status.remainingAllowance.provenance).toBe('unavailable');
    expect(sessionPreflightRefusal(status)).toBeUndefined();
  });
});
