// Repeats, the comparative matrix, and the cross-record aggregate — proven without a frontier model.
//
// THE DISTINCTION THIS FILE EXISTS TO HOLD. A REPEAT is a fresh independent run of a whole case
// from the sealed baseline; a RETRY is a second attempt inside one run after verification reported
// a failure. They answer different questions — variance and recovery — and a benchmark that merged
// them would report a model's ability to recover as a sample size, or three samples as three
// tries. So everything below asserts both halves: that three repeats really are three separate
// runs from three identical clean trees with three separate records, and that a run which needed a
// second attempt is still ONE run.
//
// NO PROVIDER IS CONTACTED. The driver factory is scripted, the verification commands are real
// `node` against the real sealed fixtures, and every provider figure is supplied by the test so the
// aggregate's arithmetic can be asserted rather than hoped for.

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DiscoveryEvidence } from '../../src/engine/discovery-store';
import { Ledger } from '../../src/engine/ledger';
import { SYNTHETIC_HARDWARE } from '../../src/engine/synthetic';
import { provenModel } from './frontier-harness';
import {
  BROKEN_SUM_MEAN, REGISTRY_ISOLATION_RECOVER, allWorkspaceCases, foundationFourPack,
} from '../../src/engine/workspace-catalog';
import { makeWorkspaceBenchmarkPack } from '../../src/engine/workspace-pack';
import {
  ScriptedAttempt, ScriptedWorkspaceAgent, WorkspaceAgentDriver, WorkspaceAgentRequest,
} from '../../src/engine/workspace-agent';
import { WorkspaceAgentUsage } from '../../src/engine/workspace-host';
import {
  WorkspaceMatrixError, WorkspaceMatrixRequest, buildWorkspaceMatrixPlan, describeWorkspaceMatrixPlan,
  runWorkspaceMatrix,
} from '../../src/engine/workspace-matrix';
import {
  aggregateWorkspaceRuns, collectWorkspaceRunRows, describeWorkspaceCell, spreadOf,
} from '../../src/engine/workspace-aggregate';
import { workspaceRecordPaths } from '../../src/engine/workspace-campaign';
import { measuredQuantity, unavailableQuantity } from '../../src/engine/frontier-metrics';

const FIXTURE_ROOT = path.resolve(__dirname, '../../fixtures');
const MODELS = ['claude-haiku-4-5', 'claude-sonnet-5'];

const temporaries: string[] = [];
afterEach(() => { for (const directory of temporaries.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

function temporary(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaries.push(directory);
  return directory;
}

/** A discovery store proving both models, written by hand. No provider was contacted for it. */
const PROVEN: DiscoveryEvidence = {
  writtenAt: new Date().toISOString(),
  models: MODELS.map((modelID) => ({
    ...provenModel('claudeCLI', modelID), discoveredAt: new Date().toISOString(),
  })),
};

const CORRECT_STATS = `'use strict';
function sum(values) { let total = 0; for (const value of values) total += value; return total; }
function mean(values) {
  if (values.length === 0) throw new RangeError('empty');
  return sum(values) / values.length;
}
module.exports = { sum, mean };
`;

const FIXES_BROKEN_SUM: ScriptedAttempt = {
  steps: [{ do: 'write', path: 'src/stats.js', contents: CORRECT_STATS }],
  finalMessage: 'Fixed the divisor.',
};

const CHANGES_NOTHING: ScriptedAttempt = {
  steps: [{ do: 'say', text: 'It looks correct to me.' }],
  finalMessage: 'No change needed.',
};

const USAGE: WorkspaceAgentUsage = {
  inputTokens: 6_000, freshInputTokens: 10, cacheCreationInputTokens: 5_900, cacheReadInputTokens: 90,
  visibleOutputTokens: 400, reasoningTokens: 60, subscriptionIncludedUsageMicroUSD: 20_000,
  observedFirstOutputMilliseconds: 700,
};

/**
 * A driver factory whose script and usage depend on the MODEL and the CASE, so a matrix can be
 * driven to a known answer without a provider — and so the two rows of the comparison are genuinely
 * different rows. The script is chosen inside `run`, where the case id is known, because one driver
 * instance is handed several cases exactly as a real one is.
 */
function scriptedFactory(options: {
  scripts: Record<string, ScriptedAttempt[] | Record<string, ScriptedAttempt[]>>;
  usage?: Record<string, WorkspaceAgentUsage | undefined>;
}): NonNullable<WorkspaceMatrixRequest['driverFactory']> {
  return (binding) => {
    const forModel = options.scripts[binding.requestedModelID];
    const usage = options.usage === undefined ? USAGE : options.usage[binding.requestedModelID];
    const capabilities = new ScriptedWorkspaceAgent([]).capabilities;
    const driver: WorkspaceAgentDriver = {
      driverID: 'driver.scripted',
      provider: 'claudeCLI',
      capabilities,
      async run(request: WorkspaceAgentRequest) {
        const attempts = forModel === undefined ? [CHANGES_NOTHING]
          : Array.isArray(forModel) ? forModel : (forModel[request.caseID] ?? [CHANGES_NOTHING]);
        const result = await new ScriptedWorkspaceAgent(attempts).run(request);
        return { ...result, usage, reportedModelID: binding.requestedModelID };
      },
    };
    return driver;
  };
}

function matrixRequest(overrides: Partial<WorkspaceMatrixRequest> = {}): WorkspaceMatrixRequest {
  return {
    pack: foundationFourPack,
    cases: allWorkspaceCases(),
    provider: 'claudeCLI',
    modelIDs: MODELS,
    effort: 'none',
    discovery: PROVEN,
    campaignRoot: temporary('cernum-ws-matrix-'),
    fixtureRoot: FIXTURE_ROOT,
    sandboxRoot: temporary('cernum-ws-sandbox-'),
    runLabel: 'matrix',
    driverFactory: scriptedFactory({ scripts: {} }),
    environmentSource: { PATH: process.env.PATH, HOME: '/tmp/home', USER: 'somebody' },
    ...overrides,
  };
}

// MARK: - Planning

describe('the matrix is planned in full before anything is sent', () => {
  it('counts models x cases x repeats as independent RUNS, and attempts separately', () => {
    const plan = buildWorkspaceMatrixPlan(matrixRequest({
      modelIDs: ['claude-haiku-4-5', 'claude-sonnet-5'],
    }));
    expect(plan.taskRunCount).toBe(2 * 4 * 3);
    expect(plan.runnableRunCount).toBe(24);
    expect(plan.refusedRunCount).toBe(0);
    // Two of the four cases allow a retry, so one model's twelve runs may use at most eighteen
    // attempts: (2 + 1 + 2 + 1) per repeat, three times. The run count is what happens when
    // everything passes first time; this is the ceiling.
    expect(plan.maximumProviderAttemptCount).toBe(2 * 3 * (2 + 1 + 2 + 1));
    expect(plan.maximumProviderAttemptCount).toBeGreaterThan(plan.taskRunCount);
  });

  it('gives the future four-model Claude matrix exactly 48 runs and 72 attempts', () => {
    const plan = buildWorkspaceMatrixPlan(matrixRequest({
      modelIDs: ['claude-haiku-4-5', 'claude-sonnet-5', 'claude-fable-5-1', 'claude-opus-5'],
      discovery: {
        writtenAt: new Date().toISOString(),
        models: ['claude-haiku-4-5', 'claude-sonnet-5', 'claude-fable-5-1', 'claude-opus-5'].map((modelID) => ({
          ...provenModel('claudeCLI', modelID), discoveredAt: new Date().toISOString(),
        })),
      },
    }));
    expect(plan.taskRunCount).toBe(48);
    expect(plan.runnableRunCount).toBe(48);
    expect(plan.maximumProviderAttemptCount).toBe(72);
    expect(plan.repeatsPerCase).toBe(3);
    expect(plan.repeatsFrom).toBe('pack');
  });

  it('orders execution model → repeat → case, so a cell\'s samples are spread across the run', () => {
    const plan = buildWorkspaceMatrixPlan(matrixRequest());
    const firstModel = plan.cells.filter((cell) => cell.modelID === 'claude-haiku-4-5');
    // All of one model's cells come before the next model's.
    expect(plan.cells.slice(0, 12).every((cell) => cell.modelID === 'claude-haiku-4-5')).toBe(true);
    // And within a model, repeat 1 of every case precedes repeat 2 of any of them.
    expect(firstModel.slice(0, 4).map((cell) => cell.repeat.repeatIndex)).toEqual([1, 1, 1, 1]);
    expect(firstModel.slice(4, 8).map((cell) => cell.repeat.repeatIndex)).toEqual([2, 2, 2, 2]);
  });

  it('names every record directory uniquely and filesystem-safely', () => {
    const plan = buildWorkspaceMatrixPlan(matrixRequest());
    expect(new Set(plan.cells.map((cell) => cell.recordName)).size).toBe(plan.cells.length);
    for (const cell of plan.cells) expect(cell.recordName).toMatch(/^[a-z0-9][a-z0-9-]*$/);
  });

  it('gives every repeat of one cell the same group id, and different cells different ones', () => {
    const plan = buildWorkspaceMatrixPlan(matrixRequest());
    const cell = plan.cells.filter((entry) =>
      entry.modelID === 'claude-haiku-4-5' && entry.caseID === BROKEN_SUM_MEAN.id);
    expect(cell).toHaveLength(3);
    expect(new Set(cell.map((entry) => entry.repeat.repeatGroupID)).size).toBe(1);
    expect(cell.map((entry) => entry.repeat.repeatIndex).sort()).toEqual([1, 2, 3]);
    const other = plan.cells.find((entry) =>
      entry.modelID === 'claude-sonnet-5' && entry.caseID === BROKEN_SUM_MEAN.id);
    expect(other?.repeat.repeatGroupID).not.toBe(cell[0].repeat.repeatGroupID);
  });

  it('refuses a model this machine has never proven, and still plans the ones it has', () => {
    const plan = buildWorkspaceMatrixPlan(matrixRequest({
      modelIDs: ['claude-haiku-4-5', 'claude-nothing-proved-this'],
    }));
    expect(plan.taskRunCount).toBe(24);
    expect(plan.runnableRunCount).toBe(12);
    expect(plan.refusedRunCount).toBe(12);
    const refused = plan.models.find((model) => model.modelID === 'claude-nothing-proved-this');
    expect(refused?.runnable).toBe(false);
    expect(refused?.refusals.join(' ')).toContain('unprovenRoute');
    expect(refused?.binding).toBeUndefined();
  });

  it('refuses a model named twice, because two runs of one model are repeats', () => {
    expect(() => buildWorkspaceMatrixPlan(matrixRequest({
      modelIDs: ['claude-haiku-4-5', 'claude-haiku-4-5'],
    }))).toThrow(WorkspaceMatrixError);
  });

  it('narrows attempts and the deadline, and never widens either', () => {
    const plan = buildWorkspaceMatrixPlan(matrixRequest({ attemptCeiling: 1, timeoutMilliseconds: 5_000 }));
    for (const cell of plan.cells) {
      expect(cell.effectiveAttemptCeiling).toBe(1);
      expect(cell.timeoutMilliseconds).toBe(5_000);
    }
    const wide = buildWorkspaceMatrixPlan(matrixRequest({ attemptCeiling: 99, timeoutMilliseconds: 99_000_000 }));
    for (const cell of wide.cells) {
      expect(cell.effectiveAttemptCeiling).toBe(cell.caseMaximumAttempts);
      expect(cell.timeoutMilliseconds).toBeLessThanOrEqual(600_000);
    }
  });

  it('reports an environment name this machine does not have, rather than guessing around it', () => {
    const plan = buildWorkspaceMatrixPlan(matrixRequest({
      environmentSource: { PATH: process.env.PATH, HOME: '/tmp/home' },
    }));
    expect(plan.environmentShortfalls.join(' ')).toContain('USER');
  });

  it('states a TRUE zero marginal charge and refuses to invent an allowance', () => {
    const plan = buildWorkspaceMatrixPlan(matrixRequest());
    expect(plan.marginalAPIChargeMicroUSD).toEqual(measuredQuantity(0));
    // No prior run of this experiment exists under a fresh campaign root, so there is no basis.
    // Unavailable with a reason — never zero, because these runs will consume allowance.
    expect(plan.allowanceEstimate.totalMicroUSD.provenance).toBe('unavailable');
    expect(plan.allowanceEstimate.totalMicroUSD.note).toContain('undercount');
    expect(plan.allowanceEstimate.cells.every((cell) => cell.basisRunCount === 0)).toBe(true);
  });

  it('renders one preview, and the preview names the numbers a person needs before paying', () => {
    const lines = describeWorkspaceMatrixPlan(buildWorkspaceMatrixPlan(matrixRequest())).join('\n');
    expect(lines).toContain('cwp1:');
    expect(lines).toContain('cwc1:');
    expect(lines).toContain('cwk1:');
    expect(lines).toContain('2 models x 4 cases x 3 repeats = 24 independent runs');
    expect(lines).toContain('max attempts    36');
    expect(lines).toContain('a TRUE zero');
    expect(lines).toContain('A REPEAT is a fresh independent run');
  });
});

// MARK: - Repeats, executed

describe('three repeats are three runs, not one run sampled three times', () => {
  it('runs each repeat from an identical clean baseline and seals three separate records', async () => {
    const request = matrixRequest({
      pack: makeWorkspaceBenchmarkPack({
        id: 'pack.test.one', version: '1', caseIDs: [BROKEN_SUM_MEAN.id], repeatsPerCase: 3,
      }),
      modelIDs: ['claude-haiku-4-5'],
      driverFactory: scriptedFactory({ scripts: { 'claude-haiku-4-5': [FIXES_BROKEN_SUM] } }),
    });
    const plan = buildWorkspaceMatrixPlan(request);
    expect(plan.taskRunCount).toBe(3);

    const result = await runWorkspaceMatrix(plan, request, {
      hardware: SYNTHETIC_HARDWARE, runtimeVersion: 'a test',
    });
    expect(result.completed).toHaveLength(3);
    expect(result.skipped).toHaveLength(0);

    const rows = collectWorkspaceRunRows(request.campaignRoot);
    expect(rows).toHaveLength(3);

    // THREE FRESH BASELINES. Every repeat copied the same sealed fixture and diffed against an
    // identical clean tree: nothing one repeat wrote could reach the next.
    const fixtures = rows.map((run) => run.row.fixtureObservedTreeDigest);
    expect(new Set(fixtures).size).toBe(1);
    expect(fixtures[0]).toBe(BROKEN_SUM_MEAN.source.expectedTreeDigest);
    expect(new Set(rows.map((run) => run.row.workspaceBaselineTreeDigest)).size).toBe(1);

    // THREE SEPARATE RECORDS. Distinct directories, distinct manifests, distinct transcripts.
    expect(new Set(rows.map((run) => run.recordRoot)).size).toBe(3);
    for (const run of rows) {
      const paths = workspaceRecordPaths(run.recordRoot);
      expect(fs.existsSync(paths.manifest)).toBe(true);
      expect(Ledger.exists(paths.ledger)).toBe(true);
      expect(fs.existsSync(paths.record)).toBe(true);
      const record = JSON.parse(fs.readFileSync(paths.record, 'utf8')) as Record<string, unknown>;
      expect(record.repeatsPlanned).toBe(3);
      expect(record.packID).toBe('pack.test.one');
      expect(String(record.repeatDisclosure)).toContain('A REPEAT is a fresh independent run');
      expect(fs.existsSync(path.join(paths.evidence, BROKEN_SUM_MEAN.id, 'attempt-0', 'transcript.jsonl'))).toBe(true);
    }
    const manifestIDs = rows.map((run) =>
      (JSON.parse(fs.readFileSync(workspaceRecordPaths(run.recordRoot).manifest, 'utf8')) as { manifestID: string }).manifestID);
    expect(new Set(manifestIDs).size).toBe(3);

    // ONE CELL, THREE SAMPLES: same group id, the three repeat indices, and every one a pass.
    expect(new Set(rows.map((run) => run.row.repeatGroupID)).size).toBe(1);
    expect(rows.map((run) => run.row.repeatIndex).sort()).toEqual([1, 2, 3]);
    expect(rows.every((run) => run.row.status === 'pass')).toBe(true);
  }, 180_000);

  it('keeps a run that RETRIED as one run, counted apart from the repeats', async () => {
    const trap = `'use strict';
const DEFAULT_OPTIONS = { label: 'registry', entries: [] };
function createRegistry(options) {
  const settings = options === undefined ? { label: 'registry', entries: [] } : options;
  return { label: settings.label, entries: settings.entries };
}
function register(registry, name) { registry.entries.push(name); return registry; }
function namesOf(registry) { return [...registry.entries]; }
module.exports = { DEFAULT_OPTIONS, createRegistry, register, namesOf };
`;
    const correct = trap.replace('entries: settings.entries', 'entries: [...settings.entries]')
      .replace("const settings = options === undefined ? { label: 'registry', entries: [] } : options;",
        'const settings = options === undefined ? DEFAULT_OPTIONS : options;');

    const request = matrixRequest({
      pack: makeWorkspaceBenchmarkPack({
        id: 'pack.test.recover', version: '1', caseIDs: [REGISTRY_ISOLATION_RECOVER.id], repeatsPerCase: 2,
      }),
      modelIDs: ['claude-haiku-4-5'],
      driverFactory: scriptedFactory({
        scripts: {
          'claude-haiku-4-5': [
            { steps: [{ do: 'write', path: 'src/registry.js', contents: trap }] },
            { steps: [{ do: 'write', path: 'src/registry.js', contents: correct }] },
          ],
        },
      }),
    });
    const plan = buildWorkspaceMatrixPlan(request);
    // TWO repeats, and each one allows TWO attempts. Four attempts at most; two runs, always.
    expect(plan.taskRunCount).toBe(2);
    expect(plan.maximumProviderAttemptCount).toBe(4);

    await runWorkspaceMatrix(plan, request, { hardware: SYNTHETIC_HARDWARE, runtimeVersion: 'a test' });
    const rows = collectWorkspaceRunRows(request.campaignRoot);

    expect(rows).toHaveLength(2);
    for (const run of rows) {
      expect(run.row.status).toBe('pass');
      // Each run needed the second attempt, and each is still ONE run with its own record.
      expect(run.row.attemptsUsed).toBe(2);
      expect(run.row.retriesRequired).toBe(1);
      expect(run.row.repeatsPlanned).toBe(2);
    }
    const cells = aggregateWorkspaceRuns(rows);
    expect(cells).toHaveLength(1);
    expect(cells[0].runCount).toBe(2);
    expect(cells[0].quality.successCount).toBe(2);
    // The two numbers that must never be confused: two SAMPLES, each of which used one RETRY.
    expect(cells[0].quality.firstAttemptSuccessCount).toBe(0);
    expect(cells[0].quality.recoverySuccessCount).toBe(2);
    expect(cells[0].quality.runsThatRetriedCount).toBe(2);
    expect(cells[0].caseMaximumAttempts).toBe(2);
    expect(cells[0].repeatsPlanned).toBe(2);
  }, 180_000);
});

// MARK: - Aggregation

describe('the aggregate combines records without inventing a number or a winner', () => {
  it('folds a two-model, two-case matrix into four cells with separate provenance', async () => {
    const pack = makeWorkspaceBenchmarkPack({
      id: 'pack.test.two', version: '1',
      caseIDs: [BROKEN_SUM_MEAN.id, REGISTRY_ISOLATION_RECOVER.id], repeatsPerCase: 2,
    });
    const correctRegistry = `'use strict';
const DEFAULT_OPTIONS = { label: 'registry', entries: [] };
function createRegistry(options) {
  const settings = options === undefined ? DEFAULT_OPTIONS : options;
  return { label: settings.label, entries: [...settings.entries] };
}
function register(registry, name) { registry.entries.push(name); return registry; }
function namesOf(registry) { return [...registry.entries]; }
module.exports = { DEFAULT_OPTIONS, createRegistry, register, namesOf };
`;
    const request = matrixRequest({
      pack,
      driverFactory: scriptedFactory({
        scripts: {
          // One model does the work on both cases; the other does nothing on either.
          'claude-haiku-4-5': {
            [BROKEN_SUM_MEAN.id]: [FIXES_BROKEN_SUM],
            [REGISTRY_ISOLATION_RECOVER.id]: [{
              steps: [{ do: 'write', path: 'src/registry.js', contents: correctRegistry }],
            }],
          },
          'claude-sonnet-5': [CHANGES_NOTHING],
        },
        usage: {
          'claude-haiku-4-5': USAGE,
          // THE MODEL WHOSE TOOL COUNTED NOTHING. Its columns must come back unavailable, with a
          // reason, rather than as a confident zero that would make it look free.
          'claude-sonnet-5': undefined,
        },
      }),
    });
    const plan = buildWorkspaceMatrixPlan(request);
    expect(plan.taskRunCount).toBe(8);

    await runWorkspaceMatrix(plan, request, { hardware: SYNTHETIC_HARDWARE, runtimeVersion: 'a test' });
    const cells = aggregateWorkspaceRuns(collectWorkspaceRunRows(request.campaignRoot));

    expect(cells).toHaveLength(4);
    for (const cell of cells) {
      expect(cell.runCount).toBe(2);
      expect(cell.repeatsPlanned).toBe(2);
      expect(cell.recordRoots).toHaveLength(2);
      expect(cell.packID).toBe('pack.test.two');
      // One row per candidate x case, and the row says which experiment it is.
      expect(cell.comparabilityKey.startsWith('cwk1:')).toBe(true);
    }

    const working = cells.filter((cell) => cell.candidate === 'claudeCLI:claude-haiku-4-5');
    const idle = cells.filter((cell) => cell.candidate === 'claudeCLI:claude-sonnet-5');

    // QUALITY.
    for (const cell of working) {
      expect(cell.quality.successCount).toBe(2);
      expect(cell.quality.successRateMilli).toEqual(measuredQuantity(1_000));
      expect(cell.quality.firstAttemptSuccessRateMilli).toEqual(measuredQuantity(1_000));
      expect(cell.quality.regressionCount).toBe(0);
      expect(cell.quality.scopeViolationRunCount).toBe(0);
      expect(cell.quality.verificationPassRateMilli).toEqual(measuredQuantity(1_000));
      expect(cell.quality.patchCleanRateMilli).toEqual(measuredQuantity(1_000));
      // NOTHING RETRIED, SO THERE IS NO RECOVERY RATE. Not zero, not perfect: unasked.
      expect(cell.quality.recoverySuccessRateMilli.provenance).toBe('unavailable');
      expect(cell.quality.recoverySuccessRateMilli.note).toContain('never asked to recover');
    }
    for (const cell of idle) {
      expect(cell.quality.successCount).toBe(0);
      expect(cell.quality.successRateMilli).toEqual(measuredQuantity(0));
      expect(cell.quality.statusCounts.behavioralFailure).toBe(2);
    }

    // EFFICIENCY AND ECONOMICS, through the engine's existing aggregator.
    for (const cell of working) {
      expect(cell.metrics.inputTokens.value).toBe(2 * 6_000);
      expect(cell.metrics.visibleOutputTokens.value).toBe(2 * 400);
      expect(cell.metrics.reasoningTokens.value).toBe(2 * 60);
      expect(cell.metrics.totalTokens.value).toBe(2 * 6_460);
      expect(cell.metrics.subscriptionIncludedUsageMicroUSD.value).toBe(2 * 20_000);
      // A subscription's marginal charge is a true zero; the allowance beside it is not a charge.
      expect(cell.metrics.costPerRunMicroUSD.value).toBe(0);
      expect(cell.metrics.costPerSuccessfulTaskMicroUSD.value).toBe(0);
      expect(cell.metrics.tokensPerCompletedPass.value).toBe(6_460);
      expect(cell.metrics.medianTimeToFirstVisibleTokenMilliseconds.value).toBe(700);
      expect(cell.wallClockMilliseconds.count).toBe(2);
    }

    // UNAVAILABLE STAYS UNAVAILABLE. The tool that reported nothing gets no tokens, no allowance
    // and no cost-per-success — and the reason travels with each absence.
    for (const cell of idle) {
      expect(cell.metrics.inputTokens.provenance).toBe('unavailable');
      expect(cell.metrics.totalTokens.provenance).toBe('unavailable');
      expect(cell.metrics.subscriptionIncludedUsageMicroUSD.provenance).toBe('unavailable');
      expect(cell.metrics.subscriptionIncludedUsageMicroUSD.note).toBeTruthy();
      expect(cell.metrics.costPerSuccessfulTaskMicroUSD.provenance).toBe('unavailable');
      expect(cell.totalTokens.mean.provenance).toBe('unavailable');
      expect(cell.measurementQuality).toBe('unavailable');
    }

    // And the one-line rendering says how many runs there were, not only a percentage.
    expect(describeWorkspaceCell(working[0])).toContain('2/2');
    expect(describeWorkspaceCell(idle[0])).toContain('0/2');
  }, 240_000);

  it('reports a spread over repeats, and refuses to report one over a single sample', () => {
    const three = spreadOf([measuredQuantity(100), measuredQuantity(200), measuredQuantity(300)], 'none');
    expect(three.count).toBe(3);
    expect(three.minimum.value).toBe(100);
    expect(three.maximum.value).toBe(300);
    expect(three.mean.value).toBe(200);
    expect(three.median.value).toBe(200);
    expect(three.spread.value).toBe(200);
    expect(three.standardDeviation.value).toBe(82);

    const one = spreadOf([measuredQuantity(100)], 'none');
    expect(one.median.value).toBe(100);
    // A zero here would claim that repeated runs agreed, and there were no repeated runs.
    expect(one.spread.provenance).toBe('unavailable');
    expect(one.standardDeviation.provenance).toBe('unavailable');

    const none = spreadOf([unavailableQuantity('the tool counted nothing')], 'nothing to spread');
    expect(none.count).toBe(0);
    expect(none.mean.provenance).toBe('unavailable');
    expect(none.mean.note).toBe('nothing to spread');
  });

  it('keeps the worst provenance of its inputs rather than the best', () => {
    const mixed = spreadOf([measuredQuantity(10), { provenance: 'providerReported', value: 20 }], 'none');
    expect(mixed.mean.provenance).toBe('providerReported');
  });
});
