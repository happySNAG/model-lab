// `cernum regressions` — each route's latest qualification evidence compared with its own history under the
// versioned thresholds crt1 (a verdict downgrade, a success-rate drop, a p90 latency or token increase),
// beside the stale-qualification findings that already exist. Detection only: nothing changes.
//
// FIXTURES ONLY. The sealed runs come from scripted matrices (real `node` verification against the
// repository's fixtures, no provider). The engine tests re-time and re-shape copies of those rows in
// memory; nothing on disk is touched. Observations are sealed by the store's own constructors, and the
// command is spawned with --machine and --root so nothing reads this Mac's identity or campaign root.

import { afterAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SYNTHETIC_HARDWARE } from '../../src/engine/synthetic';
import { provenModel } from './frontier-harness';
import { BROKEN_SUM_MEAN, allWorkspaceCases } from '../../src/engine/workspace-catalog';
import { makeWorkspaceBenchmarkPack } from '../../src/engine/workspace-pack';
import { ScriptedAttempt, ScriptedWorkspaceAgent, WorkspaceAgentDriver, WorkspaceAgentRequest } from '../../src/engine/workspace-agent';
import { WorkspaceMatrixRequest, buildWorkspaceMatrixPlan, runWorkspaceMatrix } from '../../src/engine/workspace-matrix';
import { WorkspaceRunRow, collectWorkspaceRunRows } from '../../src/engine/workspace-aggregate';
import { registeredWorkspaceDifficultyProfiles } from '../../src/engine/workspace-difficulty-catalog';
import { V1_QUALIFICATION_POLICY } from '../../src/engine/route-qualification';
import { routeSpendPosture } from '../../src/engine/route-spend-posture';
import { DiscoverySnapshot } from '../../src/engine/discovery-refresh';
import {
  ObservationRecord, ObservationStoreContents, appendObservations, discoverySnapshotObservation, qualificationStalenessObservation,
  readObservationStore, routeAvailabilityObservation,
} from '../../src/engine/observation-store';
import { QualificationHistoryError } from '../../src/engine/qualification-history';
import {
  REGRESSIONS_ARE_DETECTION_ONLY, REGRESSION_REPORT_SCHEMA, RegressionDetectorError, RegressionReport, RegressionThresholds,
  V1_REGRESSION_THRESHOLDS, detectRegressions,
} from '../../src/engine/regression-detector';
import { acceptedOptions, commandSpec } from '../../src/cli/command-spec';

const REPOSITORY = path.resolve(__dirname, '../..');
const FIXTURE_ROOT = path.join(REPOSITORY, 'fixtures');
const HAIKU = 'claude-haiku-4-5';
const ROUTE = `claudeCLI:${HAIKU}`;
const MACHINE = 'cmk1:regression-machine';

const shared: string[] = [];
afterAll(() => { for (const directory of shared.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
function sharedTemporary(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  shared.push(directory);
  return directory;
}

const CORRECT_STATS = `'use strict';
function sum(values) { let total = 0; for (const value of values) total += value; return total; }
function mean(values) {
  if (values.length === 0) throw new RangeError('empty');
  return sum(values) / values.length;
}
module.exports = { sum, mean };
`;
const FIXES_BROKEN_SUM: ScriptedAttempt = { steps: [{ do: 'write', path: 'src/stats.js', contents: CORRECT_STATS }], finalMessage: 'fixed' };
const CHANGES_NOTHING: ScriptedAttempt = { steps: [], finalMessage: 'I could not find the defect' };

const iso = (milliseconds: number): string => new Date(milliseconds).toISOString().replace(/\.\d{3}Z$/, 'Z');

function snapshot(at: string): DiscoverySnapshot {
  return {
    schema: 'cds1', machineKey: MACHINE, takenAt: at, providerAllowlist: 'cpa1',
    providers: [{ provider: 'claudeCLI', refreshed: true, detail: 'a fixture: no provider was contacted' }],
    routes: [{ routeKey: ROUTE, provider: 'claudeCLI', modelID: HAIKU, listed: true, availability: 'proven', observedAt: at }],
  };
}
const snapshotRecord = (at: string): ObservationRecord => discoverySnapshotObservation(snapshot(at), 'regression-host', 'a fixture snapshot');
const availabilityRecord = (at: string, available: boolean): ObservationRecord =>
  routeAvailabilityObservation({ routeKey: ROUTE, machineKey: MACHINE, machineLabel: 'regression-host', observedAt: at, available,
    reason: available ? 'signed in (fixture)' : 'signed out (fixture)' }, 'claudeCLI', 'a fixture availability reading');
const stalenessRecord = (at: string): ObservationRecord => qualificationStalenessObservation({
  routeKey: ROUTE, provider: 'claudeCLI', machineKey: MACHINE, machineLabel: 'regression-host', observedAt: at,
  reasons: ['driverChanged'], detail: ['the workspace driver moved (fixture)'], provenance: 'a fixture staleness reading',
});
const storeOf = (records: ObservationRecord[]): ObservationStoreContents => ({
  schema: 'cos1', root: '/virtual/.observations', corrupt: [],
  observations: records.map((record) => ({ record, origin: 'observedHere', receivedAt: record.observedAt })),
});

/** Three sealed runs of Haiku on the broken-sum case, each attempt scripted the same way. */
async function sealRuns(root: string, attempt: ScriptedAttempt, label: string): Promise<void> {
  const request: WorkspaceMatrixRequest = {
    pack: makeWorkspaceBenchmarkPack({ id: `pack.test.regressions.${label}`, version: '1', caseIDs: [BROKEN_SUM_MEAN.id], repeatsPerCase: 3 }),
    cases: allWorkspaceCases(), provider: 'claudeCLI', modelIDs: [HAIKU], effort: 'none',
    discovery: { writtenAt: new Date().toISOString(), models: [{ ...provenModel('claudeCLI', HAIKU), discoveredAt: new Date().toISOString() }] },
    campaignRoot: root, fixtureRoot: FIXTURE_ROOT, sandboxRoot: sharedTemporary('cernum-regressions-sandbox-'), runLabel: `regressions-${label}`,
    environmentSource: { PATH: process.env.PATH, HOME: '/tmp/home', USER: 'somebody' },
    driverFactory: (binding) => {
      const driver: WorkspaceAgentDriver = {
        driverID: 'driver.scripted', provider: 'claudeCLI', capabilities: new ScriptedWorkspaceAgent([]).capabilities,
        async run(agentRequest: WorkspaceAgentRequest) {
          const result = await new ScriptedWorkspaceAgent([attempt]).run(agentRequest);
          return { ...result, reportedModelID: binding.requestedModelID,
            usage: { inputTokens: 5_000, visibleOutputTokens: 300, identityState: 'verified' } };
        },
      };
      return driver;
    },
  };
  await runWorkspaceMatrix(buildWorkspaceMatrixPlan(request), request, { hardware: SYNTHETIC_HARDWARE, runtimeVersion: 'a test' });
}

/** A campaign root: an observation store, three passing runs, then three runs that changed nothing. */
async function sealedRoot(): Promise<{ root: string; rows: WorkspaceRunRow[] }> {
  const root = sharedTemporary('cernum-regressions-root-');
  const observedAt = iso(Date.now() - 60_000);
  appendObservations(root, [snapshotRecord(observedAt), availabilityRecord(observedAt, true)],
    { origin: 'observedHere', receivedAt: observedAt });
  await sealRuns(root, FIXES_BROKEN_SUM, 'pass');
  await sealRuns(root, CHANGES_NOTHING, 'fail');
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

// ------------------------------------------------------------------ the engine, over fixed instants

const T0 = Date.parse('2026-10-01T00:00:00Z');
const hour = 3_600_000;
const day = 24 * hour;

interface Shape { status?: string; wall?: number; tokens?: number }

/**
 * Copies of the first sealed passing run, one per shape, an hour apart from T0 + 1 h. Each copy is its
 * own record root, so no two are the same run. Nothing on disk is touched.
 */
async function runsOf(shapes: Shape[]): Promise<WorkspaceRunRow[]> {
  const { rows } = await sealed();
  const template = rows.find((run) => run.row.status === 'pass')!;
  return shapes.map((shape, index) => ({
    recordRoot: `${template.recordRoot}#copy-${index}`,
    row: { ...template.row, recordedAt: iso(T0 + (index + 1) * hour), repeatIndex: index,
      status: shape.status ?? 'pass', wallClockMilliseconds: shape.wall ?? 1_000, totalTokens: shape.tokens ?? 5_000 },
  }));
}
const passes = (count: number, shape: Shape = {}): Shape[] => Array.from({ length: count }, () => ({ ...shape }));

function detect(workspaceRows: WorkspaceRunRow[], options: {
  extra?: ObservationRecord[]; now?: number; thresholds?: RegressionThresholds; routeKey?: string;
} = {}): RegressionReport {
  return detectRegressions({
    machineKey: MACHINE,
    contents: storeOf([snapshotRecord(iso(T0)), availabilityRecord(iso(T0), true), ...(options.extra ?? [])]),
    workspaceRows, workspaceCases: allWorkspaceCases(), difficultyProfiles: registeredWorkspaceDifficultyProfiles(),
    spendFor: ({ provider, modelID }, at) => routeSpendPosture({ provider, modelID, now: at }),
    now: new Date(options.now ?? T0 + day),
    ...(options.thresholds === undefined ? {} : { thresholds: options.thresholds }),
    ...(options.routeKey === undefined ? {} : { routeKey: options.routeKey }),
  });
}
const kinds = (report: RegressionReport): string[] => report.routes.flatMap((route) => route.findings.map((finding) => finding.kind));
const comparison = (report: RegressionReport, metric: string) => report.routes[0].comparisons.find((entry) => entry.metric === metric)!;

describe('the thresholds, documented and versioned', () => {
  it('are crt1, with the numbers the documentation states, carried on every report', async () => {
    expect(V1_REGRESSION_THRESHOLDS).toEqual({
      thresholdsID: 'crt1', latestWindowScoredRuns: 3, minimumBaselineScoredRuns: 3,
      successRateDropMilli: 100, p90WallClockIncreasePercent: 50, p90TotalTokensIncreasePercent: 50,
    });
    const report = detect(await runsOf(passes(6)));
    expect(report.schema).toBe(REGRESSION_REPORT_SCHEMA);
    expect(report.thresholds).toEqual(V1_REGRESSION_THRESHOLDS);
    expect(report.qualificationPolicyID).toBe(V1_QUALIFICATION_POLICY.policyID);
    expect(report.disclosure).toBe(REGRESSIONS_ARE_DETECTION_ONLY);
    const documented = fs.readFileSync(path.join(REPOSITORY, 'docs/ordra-lane/regression-detector.md'), 'utf8');
    for (const phrase of ['`crt1`', '`latestWindowScoredRuns` | 3', '`minimumBaselineScoredRuns` | 3', '`successRateDropMilli` | 100',
      '`p90WallClockIncreasePercent` | 50', '`p90TotalTokensIncreasePercent` | 50']) expect(documented).toContain(phrase);
  }, 180_000);

  it('refuses thresholds it could not apply', async () => {
    const rows = await runsOf(passes(6));
    for (const broken of [{ latestWindowScoredRuns: 0 }, { minimumBaselineScoredRuns: 1.5 }, { successRateDropMilli: -1 },
      { successRateDropMilli: 1_001 }, { p90TotalTokensIncreasePercent: Number.NaN }, { thresholdsID: '' }]) {
      expect(() => detect(rows, { thresholds: { ...V1_REGRESSION_THRESHOLDS, ...broken } })).toThrow(RegressionDetectorError);
    }
  }, 180_000);
});

describe('regressions, the latest evidence against the route\'s own history', () => {
  it('flags nothing for a route whose evidence is steady, and says every comparison was within threshold', async () => {
    const report = detect(await runsOf(passes(6)));
    expect(report.routes.map((route) => route.routeKey)).toEqual([ROUTE]);
    const [route] = report.routes;
    expect(route.latest?.verdict).toBe('safeToRoute');
    expect(route.downgrades).toEqual([]);
    expect(route.findings).toEqual([]);
    expect(route.comparisons.map((entry) => [entry.metric, entry.state])).toEqual([
      ['successRateMilli', 'withinThreshold'], ['p90WallClockMilliseconds', 'withinThreshold'], ['p90TotalTokens', 'withinThreshold']]);
    expect(route.windows.baseline.scoredRunCount).toBe(3);
    expect(route.windows.latest).toMatchObject({ scoredRunCount: 3, passCount: 3, from: iso(T0 + 4 * hour), to: iso(T0 + 6 * hour) });
    expect(report).toMatchObject({ regressedRouteCount: 0, staleRouteCount: 0 });
  }, 180_000);

  it('flags a verdict downgrade, for the route and each capability, and the success-rate drop behind it', async () => {
    const report = detect(await runsOf([...passes(3), ...passes(3, { status: 'fail' })]));
    const [route] = report.routes;
    expect(route.latest?.verdict).toBe('notRoutable');
    const routeDowngrade = route.downgrades.find((entry) => entry.scope === 'route')!;
    expect(routeDowngrade).toMatchObject({ from: 'safeToRoute', to: 'notRoutable',
      heldAt: new Date(T0 + 3 * hour).toISOString(), latestAt: new Date(T0 + 6 * hour).toISOString() });
    expect(routeDowngrade.because.some((reason) => reason.startsWith('qualification:'))).toBe(true);
    const capabilityDowngrades = route.downgrades.filter((entry) => entry.scope !== 'route');
    expect(capabilityDowngrades.length).toBeGreaterThan(0);
    for (const entry of capabilityDowngrades) {
      expect(entry).toMatchObject({ from: 'qualified', to: 'notQualified' });
      expect(entry.because).toEqual(['3/6 scored runs passed']);
    }
    expect(comparison(report, 'successRateMilli')).toMatchObject({ baseline: 1_000, latest: 0, change: -1_000, state: 'regressed' });
    expect(kinds(report)).toEqual(expect.arrayContaining(['verdictDowngrade', 'successRateDrop']));
    expect(kinds(report)).not.toContain('p90LatencyIncrease');
    expect(report.regressedRouteCount).toBe(1);
  }, 180_000);

  it('flags a p90 latency increase and a p90 token increase beyond threshold, with no verdict moved', async () => {
    const report = detect(await runsOf([...passes(3), ...passes(3, { wall: 1_600, tokens: 8_000 })]));
    expect(report.routes[0].downgrades).toEqual([]);
    expect(comparison(report, 'p90WallClockMilliseconds')).toMatchObject({ baseline: 1_000, latest: 1_600, change: 600, state: 'regressed' });
    expect(comparison(report, 'p90TotalTokens')).toMatchObject({ baseline: 5_000, latest: 8_000, change: 3_000, state: 'regressed' });
    expect(comparison(report, 'successRateMilli').state).toBe('withinThreshold');
    expect(kinds(report).sort()).toEqual(['p90LatencyIncrease', 'p90TokenIncrease']);
  }, 180_000);

  it('flags only BEYOND a threshold: exactly at it is within, and a caller\'s thresholds are applied and named', async () => {
    const atLimit = detect(await runsOf([...passes(3), ...passes(3, { wall: 1_500, tokens: 7_500 })]));
    expect(comparison(atLimit, 'p90WallClockMilliseconds').state).toBe('withinThreshold');
    expect(comparison(atLimit, 'p90TotalTokens').state).toBe('withinThreshold');
    expect(atLimit.routes[0].findings).toEqual([]);

    // Three passes, then two passes and a failure: 1000‰ → 667‰, a drop of 333‰.
    const rows = await runsOf([...passes(5), { status: 'fail' }]);
    expect(comparison(detect(rows), 'successRateMilli')).toMatchObject({ baseline: 1_000, latest: 667, state: 'regressed' });
    const lenient = detect(rows, { thresholds: { ...V1_REGRESSION_THRESHOLDS, thresholdsID: 'test-333', successRateDropMilli: 333 } });
    expect(comparison(lenient, 'successRateMilli').state).toBe('withinThreshold');
    expect(lenient.thresholds.thresholdsID).toBe('test-333');
    const strict = detect(rows, { thresholds: { ...V1_REGRESSION_THRESHOLDS, thresholdsID: 'test-332', successRateDropMilli: 332 } });
    expect(comparison(strict, 'successRateMilli').state).toBe('regressed');
    expect(strict.routes[0].findings.find((finding) => finding.kind === 'successRateDrop')?.summary).toContain('test-332');
  }, 180_000);

  it('compares nothing without enough history, and says so rather than reporting a clean result', async () => {
    const report = detect(await runsOf([...passes(1), ...passes(3, { wall: 9_000, tokens: 90_000 })]));
    const [route] = report.routes;
    expect(route.comparisons.every((entry) => entry.state === 'notComparable')).toBe(true);
    expect(route.comparisons[0].reason).toContain('absence of history, not a clean result');
    expect(route.comparisons.every((entry) => entry.baseline === undefined && entry.latest === undefined)).toBe(true);
    expect(route.findings).toEqual([]);
    expect(route.windows).toMatchObject({ baseline: { scoredRunCount: 1 }, latest: { scoredRunCount: 3 } });
  }, 180_000);

  it('flags a downgrade that is current, and none once the route has recovered', async () => {
    const rows = await runsOf(passes(3));
    const signedOut = detect(rows, { extra: [availabilityRecord(iso(T0 + 4 * hour), false)] });
    expect(signedOut.routes[0].downgrades).toEqual([expect.objectContaining({ scope: 'route', from: 'safeToRoute', to: 'notRoutable' })]);
    expect(signedOut.routes[0].latest?.blockerKinds).toEqual(['availability']);
    const recovered = detect(rows, { extra: [availabilityRecord(iso(T0 + 4 * hour), false), availabilityRecord(iso(T0 + 5 * hour), true)] });
    expect(recovered.routes[0].latest?.verdict).toBe('safeToRoute');
    expect(recovered.routes[0].downgrades).toEqual([]);
  }, 180_000);
});

describe('stale qualifications, alongside the regressions', () => {
  it('reports the existing staleness findings: the read model\'s, the fresh-qualification query\'s, and the store\'s', async () => {
    const rows = await runsOf(passes(6));
    const report = detect(rows, { extra: [stalenessRecord(iso(T0 + 7 * hour))], now: T0 + 40 * day });
    const [route] = report.routes;
    expect(route.staleness.derived?.valid).toBe(false);
    expect(route.staleness.derived?.reasons).toContain('staleEvidenceExpired');
    expect(route.staleness.freshQualificationQueryReason).toMatch(/^staleness: the query requires fresh qualification evidence/);
    expect(route.staleness.recorded).toEqual([{ observedAt: iso(T0 + 7 * hour), reasons: ['driverChanged'],
      detail: ['the workspace driver moved (fixture)'] }]);
    expect(route.findings.map((finding) => finding.kind)).toEqual(['staleQualification']);
    expect(report).toMatchObject({ staleRouteCount: 1, regressedRouteCount: 0 });

    const fresh = detect(rows).routes[0];
    expect(fresh.staleness.derived).toEqual({ valid: true, reasons: ['qualificationStillValid'], detail: ['nothing that describes the route has moved'] });
    expect(fresh.staleness.freshQualificationQueryReason).toBeUndefined();
  }, 180_000);
});

describe('detection only', () => {
  it('changes none of its inputs and decides no verdict: the same evidence gives the same verdicts with or without it', async () => {
    const rows = await runsOf([...passes(3), ...passes(3, { status: 'fail', wall: 9_000 })]);
    const contents = storeOf([snapshotRecord(iso(T0)), availabilityRecord(iso(T0), true)]);
    const before = JSON.stringify({ rows, contents, policy: V1_QUALIFICATION_POLICY, thresholds: V1_REGRESSION_THRESHOLDS });
    const report = detectRegressions({ machineKey: MACHINE, contents, workspaceRows: rows, workspaceCases: allWorkspaceCases(),
      difficultyProfiles: registeredWorkspaceDifficultyProfiles(), now: new Date(T0 + day) });
    expect(kinds(report).length).toBeGreaterThan(0);
    expect(JSON.stringify({ rows, contents, policy: V1_QUALIFICATION_POLICY, thresholds: V1_REGRESSION_THRESHOLDS })).toBe(before);
    expect(detectRegressions({ machineKey: MACHINE, contents, workspaceRows: rows, workspaceCases: allWorkspaceCases(),
      difficultyProfiles: registeredWorkspaceDifficultyProfiles(), now: new Date(T0 + day) })).toEqual(report);
  }, 180_000);

  it('answers for one named route, and refuses a route nothing has recorded and a string that is not a route', async () => {
    const rows = await runsOf(passes(6));
    expect(detect(rows, { routeKey: ROUTE }).routes.map((route) => route.routeKey)).toEqual([ROUTE]);
    expect(() => detect(rows, { routeKey: 'claudeCLI:claude-nonexistent-9' })).toThrow(QualificationHistoryError);
    expect(() => detect(rows, { routeKey: 'no-colon-here' })).toThrow(/is not a route/);
    expect(detect([]).routes).toEqual([]);
  }, 180_000);
});

// ------------------------------------------------------------------ the command, in a subprocess

describe('cernum regressions', () => {
  it('is declared read-only, takes an optional route, and offers --json', () => {
    const spec = commandSpec('regressions')!;
    expect(spec.effect).toBe('readOnly');
    expect(spec.positional).toBe('[<route>]');
    expect(acceptedOptions(spec).map((option) => option.name)).toEqual(expect.arrayContaining(['json', 'machine', 'evidence-roots', 'policy', 'help']));
  });

  it('--json reports the downgrade and the success-rate drop in sealed runs, and writes nothing', async () => {
    const { root, rows } = await sealed();
    expect(rows).toHaveLength(6);
    expect(rows.filter((run) => run.row.status === 'pass')).toHaveLength(3);
    const before = digestTree(root);
    const result = await cernum('regressions', '--json', '--machine', MACHINE, '--root', root);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as RegressionReport;
    expect(report).toMatchObject({ schema: REGRESSION_REPORT_SCHEMA, machineKey: MACHINE, thresholds: V1_REGRESSION_THRESHOLDS,
      regressedRouteCount: 1 });
    expect(report.routes.map((route) => route.routeKey)).toEqual([ROUTE]);
    const [route] = report.routes;
    expect(route.downgrades.find((entry) => entry.scope === 'route')).toMatchObject({ from: 'safeToRoute', to: 'notRoutable' });
    expect(route.comparisons.find((entry) => entry.metric === 'successRateMilli')).toMatchObject({ baseline: 1_000, latest: 0, state: 'regressed' });
    expect(route.findings.map((finding) => finding.kind)).toEqual(expect.arrayContaining(['verdictDowngrade', 'successRateDrop']));
    expect(digestTree(root)).toBe(before);
    expect(readObservationStore(root).observations).toHaveLength(2);
  }, 240_000);

  it('prints the same report for a person, and answers for a named route', async () => {
    const { root } = await sealed();
    const before = digestTree(root);
    const result = await cernum('regressions', ROUTE, '--machine', MACHINE, '--root', root);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Regressions · thresholds crt1 · cqp1');
    expect(result.stdout).toContain('1 route(s) compared · 1 regressed');
    expect(result.stdout).toMatch(/FINDING {4}verdictDowngrade \(route\)/);
    expect(result.stdout).toMatch(/FINDING {4}successRateDrop \(route\)/);
    expect(result.stdout.replace(/\s+/g, ' ')).toContain('No verdict, record or policy was changed, and nothing was written');
    expect(digestTree(root)).toBe(before);
  }, 240_000);

  it('refuses an unknown or malformed route clearly and exits non-zero, writing nothing', async () => {
    const { root } = await sealed();
    const before = digestTree(root);
    const unknown = await cernum('regressions', 'claudeCLI:claude-nonexistent-9', '--machine', MACHINE, '--root', root);
    expect(unknown.status).toBe(2);
    expect(`${unknown.stdout}${unknown.stderr}`).toContain('claudeCLI:claude-nonexistent-9 is not a route this store or these evidence roots have ever recorded');
    const malformed = await cernum('regressions', 'not-a-route', '--machine', MACHINE, '--root', root);
    expect(malformed.status).toBe(2);
    expect(`${malformed.stdout}${malformed.stderr}`).toContain('is not a route');
    expect(digestTree(root)).toBe(before);
  }, 240_000);
});
