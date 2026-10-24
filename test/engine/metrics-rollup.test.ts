// The metrics rollup — count, nearest-rank median and p90 of wall clock and tokens, cost where a price was
// recorded, retry and failure rates — per route and per capability, from recorded evidence only; and the
// one shared percentile helper it and `route-qualification.ts` use.
//
// FIXTURES ONLY. The engine is fed hand-written ledger rows shaped as `workspace-campaign.ts` writes them.
// The command test seals three runs with a scripted matrix (real `node` verification against the
// repository's fixtures, no provider) into a temporary root, and checks the command wrote nothing.

import { afterAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PercentileError, nearestRankMedian, nearestRankPercentile } from '../../src/engine/percentile';
import { METRICS_ROLLUP_SCHEMA, MetricsRollup, deriveMetricsRollup } from '../../src/engine/metrics-rollup';
import { SUBSCRIPTION_NOT_FREE } from '../../src/engine/frontier-metrics';
import { deriveRouteQualification } from '../../src/engine/route-qualification';
import { BROKEN_SUM_MEAN, allWorkspaceCases } from '../../src/engine/workspace-catalog';
import { registeredWorkspaceDifficultyProfiles } from '../../src/engine/workspace-difficulty-catalog';
import { workspaceDifficultyProfileFor } from '../../src/engine/workspace-difficulty';
import { WorkspaceRunRow, collectWorkspaceRunRows } from '../../src/engine/workspace-aggregate';
import { SYNTHETIC_HARDWARE } from '../../src/engine/synthetic';
import { makeWorkspaceBenchmarkPack } from '../../src/engine/workspace-pack';
import { ScriptedAttempt, ScriptedWorkspaceAgent, WorkspaceAgentDriver, WorkspaceAgentRequest } from '../../src/engine/workspace-agent';
import { WorkspaceMatrixRequest, buildWorkspaceMatrixPlan, runWorkspaceMatrix } from '../../src/engine/workspace-matrix';
import { acceptedOptions, commandSpec } from '../../src/cli/command-spec';
import { provenModel } from './frontier-harness';

const REPOSITORY = path.resolve(__dirname, '../..');
const FIXTURE_ROOT = path.join(REPOSITORY, 'fixtures');
const METERED = 'openaiAPI:gpt-fixture-1';
const SUBSCRIPTION = 'claudeCLI:claude-haiku-4-5';
const LOCAL = 'ollama:gemma3:4b';

const shared: string[] = [];
afterAll(() => { for (const directory of shared.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
function sharedTemporary(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  shared.push(directory);
  return directory;
}

let serial = 0;
/** One ledger row, with the fields `workspace-campaign.ts` writes for tokens, cost, timing and retries. */
function run(routeKey: string, fields: Record<string, unknown>): WorkspaceRunRow {
  const at = routeKey.indexOf(':');
  serial += 1;
  return {
    recordRoot: `/virtual/runs/${String(serial).padStart(3, '0')}`,
    row: {
      provider: routeKey.slice(0, at), requestedModelID: routeKey.slice(at + 1), candidate: routeKey,
      caseID: BROKEN_SUM_MEAN.id, effort: 'none', status: 'pass', attemptsUsed: 1,
      billingBasis: 'metered', usageProvenance: 'providerReported', costProvenance: 'estimated',
      recordedAt: new Date(Date.parse('2026-10-01T00:00:00Z') + serial * 60_000).toISOString(),
      ...fields,
    },
  };
}

// ------------------------------------------------------------------ the shared percentile helper

describe('nearest-rank percentile, the one helper', () => {
  it('takes the value at rank ceil(p/100 × n), as documented', () => {
    expect(nearestRankMedian([10, 20, 30, 40])).toBe(20);
    expect(nearestRankPercentile([10, 20, 30, 40], 90)).toBe(40);
    const ten = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(nearestRankPercentile(ten, 90)).toBe(9);
    expect(nearestRankPercentile(ten, 91)).toBe(10);
    expect(nearestRankPercentile(ten, 100)).toBe(10);
    expect(nearestRankPercentile(ten, 1)).toBe(1);
    expect(nearestRankMedian(ten)).toBe(5);
    expect(nearestRankPercentile([...Array(20).keys()].map((index) => index + 1), 90)).toBe(18);
    expect(nearestRankMedian([7, 1, 3])).toBe(3);
    expect(nearestRankPercentile([42], 90)).toBe(42);
  });

  it('always answers with a value that was recorded, never a midpoint', () => {
    const values = [1_000, 2_000];
    expect(nearestRankMedian(values)).toBe(1_000);
    for (const p of [1, 25, 50, 75, 90, 99, 100]) expect(values).toContain(nearestRankPercentile(values, p));
  });

  it('gives nothing for no values, refuses a p outside (0, 100] and a non-finite value, and sorts a copy', () => {
    expect(nearestRankMedian([])).toBeUndefined();
    expect(nearestRankPercentile([], 90)).toBeUndefined();
    for (const p of [0, -5, 101, Number.NaN]) expect(() => nearestRankPercentile([1], p)).toThrow(PercentileError);
    expect(() => nearestRankMedian([1, Number.NaN])).toThrow(PercentileError);
    const input = [3, 1, 2];
    nearestRankPercentile(input, 90);
    expect(input).toEqual([3, 1, 2]);
  });

  it('is the median route-qualification reports its efficiency with, and moves no verdict', () => {
    const rows = [1_000, 2_000, 4_000, 8_000].map((wall, index) =>
      run(SUBSCRIPTION, { wallClockMilliseconds: wall, totalTokens: 100 * (index + 1), bindingIdentityState: 'verified' }));
    const record = deriveRouteQualification({ provider: 'claudeCLI', modelID: 'claude-haiku-4-5', machineKey: 'cmk1:metrics',
      workspaceRows: rows, workspaceCases: allWorkspaceCases(), now: new Date('2026-10-02T00:00:00Z') });
    expect(record.efficiency.medianWallClockMilliseconds).toEqual({ provenance: 'measured', value: 2_000 });
    expect(record.efficiency.medianTotalTokens).toEqual({ provenance: 'measured', value: 200 });
    expect(record.efficiency.basis).toContain('nearest-rank');
  });
});

// ------------------------------------------------------------------ the rollup, over recorded rows

describe('the rollup per route, from recorded evidence only', () => {
  // Ten passes of the metered route at 100…1000 ms, priced at run time; one more pass that needed a
  // retry; one timeout; one runtime error that recorded nothing but still recorded its charge.
  const metered = [
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((step) =>
      run(METERED, { wallClockMilliseconds: step * 100, totalTokens: step * 1_000, costMicroUSD: 50 })),
    run(METERED, { wallClockMilliseconds: 2_000, totalTokens: 20_000, costMicroUSD: 50, attemptsUsed: 2 }),
    run(METERED, { status: 'timeout', wallClockMilliseconds: 5_000, totalTokens: 30_000, costMicroUSD: 50 }),
    run(METERED, { status: 'runtimeError', costMicroUSD: 50 }),
  ];
  const rollup = (): MetricsRollup => deriveMetricsRollup({ workspaceRows: metered,
    workspaceCases: allWorkspaceCases(), difficultyProfiles: registeredWorkspaceDifficultyProfiles() });

  it('reports count, nearest-rank median and p90 of wall clock and tokens over the scored runs', () => {
    const result = rollup();
    expect(result.schema).toBe(METRICS_ROLLUP_SCHEMA);
    expect(result.routes.map((route) => route.routeKey)).toEqual([METERED]);
    const { route } = result.routes[0];
    expect(route.capability).toBe('route');
    expect(route).toMatchObject({ runCount: 13, scoredRunCount: 12, passCount: 11, failedRunCount: 1,
      retriedRunCount: 1, notMeasuredRunCount: 1, providerDeclinedRunCount: 0 });
    // Scored wall clocks: 100…1000, 2000, 5000. Twelve values: median rank 6, p90 rank ceil(10.8) = 11.
    expect(route.wallClockMilliseconds).toEqual({ count: 12, missing: 0,
      median: { provenance: 'measured', value: 600 }, p90: { provenance: 'measured', value: 2_000 } });
    expect(route.totalTokens).toEqual({ count: 12, missing: 0,
      median: { provenance: 'providerReported', value: 6_000 }, p90: { provenance: 'providerReported', value: 20_000 } });
  });

  it('reports retry and failure rates over scored runs, and the runs that measured no work apart', () => {
    const { route } = rollup().routes[0];
    expect(route.failureRateMilli).toEqual({ provenance: 'measured', value: Math.round(1_000 / 12) });
    expect(route.retryRateMilli).toEqual({ provenance: 'measured', value: Math.round(1_000 / 12) });
    expect(route.notMeasuredRateMilli).toEqual({ provenance: 'measured', value: Math.round(1_000 / 13) });
  });

  it('totals the cost over every run, broken ones included, where every run recorded its price', () => {
    const { cost } = rollup().routes[0].route;
    expect(cost).toEqual({ knownRunCount: 13, unknownRunCount: 0, unknownBecause: [],
      totalMicroUSD: { provenance: 'estimated', value: 650 }, perRunMicroUSD: { provenance: 'estimated', value: 50 } });
  });

  it('says the cost is unknown, never a partial sum, when any run recorded no price', () => {
    const unpriced = [...metered, run(METERED, { wallClockMilliseconds: 300, totalTokens: 3_000 })];
    const { cost } = deriveMetricsRollup({ workspaceRows: unpriced }).routes[0].route;
    expect(cost.knownRunCount).toBe(13);
    expect(cost.unknownRunCount).toBe(1);
    expect(cost.totalMicroUSD.provenance).toBe('unavailable');
    expect(cost.totalMicroUSD.value).toBeUndefined();
    expect(cost.totalMicroUSD.note).toContain('1 of 14 run(s) recorded no cost');
    expect(cost.perRunMicroUSD.value).toBeUndefined();
    expect(cost.unknownBecause.length).toBe(1);
  });

  it('never prices a subscription run, whatever it reports, and gives a local run its measured zero', () => {
    const result = deriveMetricsRollup({ workspaceRows: [
      run(SUBSCRIPTION, { billingBasis: 'subscriptionIncluded', wallClockMilliseconds: 900, totalTokens: 9_000,
        subscriptionIncludedUsageMicroUSD: 1_234, subscriptionAllowanceState: 'reported' }),
      // A local run records its zero charge, as `workspace-host.ts` writes it.
      run(LOCAL, { billingBasis: 'local', wallClockMilliseconds: 400, totalTokens: 4_000, costMicroUSD: 0, costProvenance: 'measured' }),
    ] });
    expect(result.routes.map((route) => route.routeKey)).toEqual([SUBSCRIPTION, LOCAL].sort());
    const subscription = result.routes.find((route) => route.routeKey === SUBSCRIPTION)!.route.cost;
    expect(subscription.totalMicroUSD.provenance).toBe('unavailable');
    expect(subscription.unknownBecause).toEqual([SUBSCRIPTION_NOT_FREE]);
    const local = result.routes.find((route) => route.routeKey === LOCAL)!;
    expect(local.provider).toBe('ollama');
    expect(local.modelID).toBe('gemma3:4b');
    expect(local.route.cost.totalMicroUSD).toEqual({ provenance: 'measured', value: 0 });
  });

  it('counts a run that recorded no wall clock or no tokens as missing, never as zero', () => {
    const result = deriveMetricsRollup({ workspaceRows: [
      run(METERED, { wallClockMilliseconds: 700, totalTokens: 7_000, costMicroUSD: 1 }),
      run(METERED, { costMicroUSD: 1 }),
      run(METERED, { wallClockMilliseconds: 900, usageProvenance: 'unavailable', totalTokens: 50, costMicroUSD: 1 }),
    ] });
    const { route } = result.routes[0];
    expect(route.wallClockMilliseconds).toMatchObject({ count: 2, missing: 1, median: { value: 700 }, p90: { value: 900 } });
    expect(route.totalTokens).toMatchObject({ count: 1, missing: 2, median: { value: 7_000 }, p90: { value: 7_000 } });
  });

  it('reports nothing measurable as unavailable with a reason, not as zero', () => {
    const { route } = deriveMetricsRollup({ workspaceRows: [
      run(METERED, { status: 'runtimeError', providerThrottled: true }),
    ] }).routes[0];
    expect(route.scoredRunCount).toBe(0);
    expect(route.providerDeclinedRunCount).toBe(1);
    expect(route.wallClockMilliseconds.median.provenance).toBe('unavailable');
    expect(route.wallClockMilliseconds.p90.note).toContain('no scored run');
    expect(route.failureRateMilli.provenance).toBe('unavailable');
    expect(route.retryRateMilli.provenance).toBe('unavailable');
    expect(route.notMeasuredRateMilli).toEqual({ provenance: 'measured', value: 1_000 });
    expect(route.cost.totalMicroUSD.provenance).toBe('unavailable');
  });

  it('is pure: the rows it was given are unchanged, and the same rows give the same rollup', () => {
    const before = JSON.stringify(metered);
    const first = rollup();
    expect(JSON.stringify(metered)).toBe(before);
    expect(rollup()).toEqual(first);
  });
});

describe('the rollup per capability', () => {
  it('names each capability as route qualification does, from the sealed case and its difficulty profile', () => {
    const profile = workspaceDifficultyProfileFor(registeredWorkspaceDifficultyProfiles(), BROKEN_SUM_MEAN.id);
    const rows = [
      run(METERED, { wallClockMilliseconds: 100, totalTokens: 1_000, costMicroUSD: 10 }),
      run(METERED, { wallClockMilliseconds: 300, totalTokens: 3_000, costMicroUSD: 10, status: 'fail', attemptsUsed: 3 }),
      run(METERED, { caseID: 'case.not.in.this.build', wallClockMilliseconds: 9_000, totalTokens: 90_000, costMicroUSD: 10 }),
    ];
    const route = deriveMetricsRollup({ workspaceRows: rows, workspaceCases: allWorkspaceCases(),
      difficultyProfiles: registeredWorkspaceDifficultyProfiles() }).routes[0];
    const expected = [...BROKEN_SUM_MEAN.dimensions.map((dimension) => `workspace:${dimension}`),
      ...(profile === undefined ? [] : [`workspace-tier:${profile.tier}`])].sort();
    expect(route.capabilities.map((entry) => entry.capability)).toEqual(expected);
    expect(route.unclassifiedRunCount).toBe(1);
    expect(route.route.runCount).toBe(3);
    for (const entry of route.capabilities) {
      expect(entry).toMatchObject({ runCount: 2, scoredRunCount: 2, passCount: 1, failedRunCount: 1, retriedRunCount: 1 });
      expect(entry.wallClockMilliseconds).toMatchObject({ count: 2, median: { value: 100 }, p90: { value: 300 } });
      expect(entry.totalTokens).toMatchObject({ count: 2, median: { value: 1_000 }, p90: { value: 3_000 } });
      expect(entry.failureRateMilli.value).toBe(500);
      expect(entry.retryRateMilli.value).toBe(500);
      expect(entry.cost.totalMicroUSD).toEqual({ provenance: 'estimated', value: 20 });
      expect(entry.recordRoots).toEqual(rows.slice(0, 2).map((entry) => entry.recordRoot));
    }
  });

  it('gives no capability without the cases to read them from, and filters by route and effort', () => {
    const rows = [run(METERED, { wallClockMilliseconds: 1 }), run(SUBSCRIPTION, { wallClockMilliseconds: 2, effort: 'high' }),
      { recordRoot: '/virtual/runs/orphan', row: { status: 'pass' } }];
    const all = deriveMetricsRollup({ workspaceRows: rows });
    expect(all.routes.map((route) => route.routeKey)).toEqual([SUBSCRIPTION, METERED].sort());
    expect(all.routes.every((route) => route.capabilities.length === 0 && route.unclassifiedRunCount === 1)).toBe(true);
    expect(all.unattributedRunCount).toBe(1);
    expect(deriveMetricsRollup({ workspaceRows: rows, routeKey: METERED }).routes.map((route) => route.routeKey)).toEqual([METERED]);
    const high = deriveMetricsRollup({ workspaceRows: rows, effort: 'high' });
    expect(high.effort).toBe('high');
    expect(high.routes.map((route) => route.routeKey)).toEqual([SUBSCRIPTION]);
    expect(high.routes[0].route.efforts).toEqual(['high']);
  });
});

// ------------------------------------------------------------------ the command, in a subprocess

const CORRECT_STATS = `'use strict';
function sum(values) { let total = 0; for (const value of values) total += value; return total; }
function mean(values) {
  if (values.length === 0) throw new RangeError('empty');
  return sum(values) / values.length;
}
module.exports = { sum, mean };
`;
const FIXES_BROKEN_SUM: ScriptedAttempt = { steps: [{ do: 'write', path: 'src/stats.js', contents: CORRECT_STATS }], finalMessage: 'fixed' };
const HAIKU = 'claude-haiku-4-5';

async function sealedRoot(): Promise<{ root: string; rows: WorkspaceRunRow[] }> {
  const root = sharedTemporary('cernum-metrics-root-');
  const request: WorkspaceMatrixRequest = {
    pack: makeWorkspaceBenchmarkPack({ id: 'pack.test.metrics', version: '1', caseIDs: [BROKEN_SUM_MEAN.id], repeatsPerCase: 3 }),
    cases: allWorkspaceCases(), provider: 'claudeCLI', modelIDs: [HAIKU], effort: 'none',
    discovery: { writtenAt: new Date().toISOString(), models: [{ ...provenModel('claudeCLI', HAIKU), discoveredAt: new Date().toISOString() }] },
    campaignRoot: root, fixtureRoot: FIXTURE_ROOT, sandboxRoot: sharedTemporary('cernum-metrics-sandbox-'), runLabel: 'metrics',
    environmentSource: { PATH: process.env.PATH, HOME: '/tmp/home', USER: 'somebody' },
    driverFactory: (binding) => {
      const driver: WorkspaceAgentDriver = {
        driverID: 'driver.scripted', provider: 'claudeCLI', capabilities: new ScriptedWorkspaceAgent([]).capabilities,
        async run(agentRequest: WorkspaceAgentRequest) {
          const result = await new ScriptedWorkspaceAgent([FIXES_BROKEN_SUM]).run(agentRequest);
          return { ...result, reportedModelID: binding.requestedModelID,
            usage: { inputTokens: 5_000, visibleOutputTokens: 300, identityState: 'verified' } };
        },
      };
      return driver;
    },
  };
  await runWorkspaceMatrix(buildWorkspaceMatrixPlan(request), request, { hardware: SYNTHETIC_HARDWARE, runtimeVersion: 'a test' });
  return { root, rows: collectWorkspaceRunRows(root) };
}
let cached: Promise<{ root: string; rows: WorkspaceRunRow[] }> | undefined;
const sealed = () => { cached = cached ?? sealedRoot(); return cached; };

function digestTree(root: string): string {
  const hash = crypto.createHash('sha256');
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else { hash.update(full); hash.update(fs.readFileSync(full)); }
    }
  };
  walk(root);
  return hash.digest('hex');
}

// Asynchronous on purpose: a synchronous spawn blocks the vitest worker's event loop for the whole
// subprocess and starves vitest's own RPC.
function cernum(...args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(path.join(REPOSITORY, 'node_modules', '.bin', 'tsx'), ['src/cli/cernum.ts', ...args], {
      cwd: REPOSITORY, env: { ...process.env, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin` },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

describe('cernum history <route> --metrics', () => {
  it('is an option of the read-only history command', () => {
    const spec = commandSpec('history')!;
    expect(spec.effect).toBe('readOnly');
    expect(acceptedOptions(spec).map((option) => option.name)).toEqual(expect.arrayContaining(['metrics', 'json']));
  });

  it('--json prints the same rollup the pure function derives from the sealed runs, and writes nothing', async () => {
    const { root, rows } = await sealed();
    const before = digestTree(root);
    const result = await cernum('history', `claudeCLI:${HAIKU}`, '--metrics', '--json', '--root', root);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const printed = JSON.parse(result.stdout) as MetricsRollup;
    expect(printed).toEqual(JSON.parse(JSON.stringify(deriveMetricsRollup({ workspaceRows: rows, routeKey: `claudeCLI:${HAIKU}`,
      workspaceCases: allWorkspaceCases(), difficultyProfiles: registeredWorkspaceDifficultyProfiles() }))));
    const route = printed.routes[0];
    expect(route.route.runCount).toBe(3);
    expect(route.route.passCount).toBe(3);
    expect(route.route.wallClockMilliseconds.count).toBe(3);
    expect(route.route.wallClockMilliseconds.p90.provenance).toBe('measured');
    expect(route.capabilities.length).toBeGreaterThan(0);
    // Subscription execution: the cost is unknown, never $0.
    expect(route.route.cost.totalMicroUSD.provenance).toBe('unavailable');
    expect(digestTree(root)).toBe(before);
  }, 180_000);

  it('prints it for a person, and refuses a route no sealed run measured', async () => {
    const { root } = await sealed();
    const before = digestTree(root);
    const text = await cernum('history', `claudeCLI:${HAIKU}`, '--metrics', '--root', root);
    expect(text.status).toBe(0);
    expect(text.stdout).toContain(`Metrics of claudeCLI:${HAIKU}`);
    expect(text.stdout).toMatch(/wall clock median \d+ ms · p90 \d+ ms/);
    expect(text.stdout).toContain('cost       total unknown');
    const unknown = await cernum('history', 'claudeCLI:claude-nonexistent-9', '--metrics', '--root', root);
    expect(unknown.status).toBe(2);
    expect(`${unknown.stdout}${unknown.stderr}`).toContain('no sealed run of claudeCLI:claude-nonexistent-9');
    expect(digestTree(root)).toBe(before);
  }, 180_000);
});
