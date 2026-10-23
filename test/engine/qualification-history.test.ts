// `cernum history <route>` — one route's qualification verdicts over time, oldest first, re-derived from
// the observation store and sealed workspace runs and written nowhere.
//
// FIXTURES ONLY. The sealed runs come from a scripted matrix (real `node` verification against the
// repository's fixtures, no provider), the observations are sealed by the store's own constructors into
// temporary roots, and the command is spawned with --machine so nothing reads this Mac's identity.

import { afterAll, afterEach, describe, expect, it } from 'vitest';
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
import {
  QUALIFICATION_HISTORY_SCHEMA, QualificationHistory, QualificationHistoryError, deriveQualificationHistory, parseRouteKey,
} from '../../src/engine/qualification-history';
import { acceptedOptions, commandSpec } from '../../src/cli/command-spec';

const REPOSITORY = path.resolve(__dirname, '../..');
const FIXTURE_ROOT = path.join(REPOSITORY, 'fixtures');
const HAIKU = 'claude-haiku-4-5';
const ROUTE = `claudeCLI:${HAIKU}`;
const MACHINE = 'cmk1:history-machine';
const OTHER = 'cmk1:another-machine';

const temporaries: string[] = [];
afterEach(() => { for (const directory of temporaries.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
function temporary(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaries.push(directory);
  return directory;
}
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

const iso = (milliseconds: number): string => new Date(milliseconds).toISOString().replace(/\.\d{3}Z$/, 'Z');

function snapshot(at: string, machineKey = MACHINE): DiscoverySnapshot {
  return {
    schema: 'cds1', machineKey, takenAt: at, providerAllowlist: 'cpa1',
    providers: [{ provider: 'claudeCLI', refreshed: true, detail: 'a fixture: no provider was contacted' }],
    routes: [{ routeKey: ROUTE, provider: 'claudeCLI', modelID: HAIKU, listed: true, availability: 'proven', observedAt: at }],
  };
}
const snapshotRecord = (at: string, machineKey = MACHINE): ObservationRecord =>
  discoverySnapshotObservation(snapshot(at, machineKey), 'history-host', 'a fixture snapshot');
const availabilityRecord = (at: string, available: boolean, machineKey = MACHINE, routeKey = ROUTE): ObservationRecord =>
  routeAvailabilityObservation({ routeKey, machineKey, machineLabel: 'history-host', observedAt: at, available,
    reason: available ? 'signed in (fixture)' : 'signed out (fixture)' }, 'claudeCLI', 'a fixture availability reading');
const stalenessRecord = (at: string): ObservationRecord => qualificationStalenessObservation({
  routeKey: ROUTE, provider: 'claudeCLI', machineKey: MACHINE, machineLabel: 'history-host', observedAt: at,
  reasons: ['driverChanged'], detail: ['the workspace driver moved (fixture)'], provenance: 'a fixture staleness reading',
});
const storeOf = (records: ObservationRecord[]): ObservationStoreContents => ({
  schema: 'cos1', root: '/virtual/.observations', corrupt: [],
  observations: records.map((record) => ({ record, origin: 'observedHere', receivedAt: record.observedAt })),
});

/** Three sealed runs of Haiku fixing the broken-sum case. Written once, shared, and never modified. */
async function sealRuns(root: string): Promise<WorkspaceRunRow[]> {
  const request: WorkspaceMatrixRequest = {
    pack: makeWorkspaceBenchmarkPack({ id: 'pack.test.history', version: '1', caseIDs: [BROKEN_SUM_MEAN.id], repeatsPerCase: 3 }),
    cases: allWorkspaceCases(), provider: 'claudeCLI', modelIDs: [HAIKU], effort: 'none',
    discovery: { writtenAt: new Date().toISOString(), models: [{ ...provenModel('claudeCLI', HAIKU), discoveredAt: new Date().toISOString() }] },
    campaignRoot: root, fixtureRoot: FIXTURE_ROOT, sandboxRoot: sharedTemporary('cernum-history-sandbox-'), runLabel: 'history',
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
  return collectWorkspaceRunRows(root);
}

/** A campaign root holding the sealed runs AND an observation store made just before them. */
async function sealedRoot(): Promise<{ root: string; rows: WorkspaceRunRow[]; observedAt: string }> {
  const root = sharedTemporary('cernum-history-root-');
  const observedAt = iso(Date.now() - 60_000);
  appendObservations(root, [snapshotRecord(observedAt), availabilityRecord(observedAt, true)],
    { origin: 'observedHere', receivedAt: observedAt });
  const rows = await sealRuns(root);
  return { root, rows, observedAt };
}
let cached: Promise<{ root: string; rows: WorkspaceRunRow[]; observedAt: string }> | undefined;
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

describe('the timeline, derived at each instant from the evidence that existed then', () => {
  const T0 = Date.parse('2026-10-01T00:00:00Z');
  const hour = 3_600_000;

  async function timeline(extra: ObservationRecord[] = []): Promise<QualificationHistory> {
    const { rows } = await sealed();
    // The same sealed rows, re-timed in memory so the instants are fixed. Nothing on disk is touched.
    const timed = rows.map((run, index) => ({ recordRoot: run.recordRoot, row: { ...run.row, recordedAt: iso(T0 + (index + 1) * hour) } }));
    return deriveQualificationHistory({
      routeKey: ROUTE, machineKey: MACHINE,
      contents: storeOf([snapshotRecord(iso(T0)), availabilityRecord(iso(T0), true),
        availabilityRecord(iso(T0 + 4 * hour), false), stalenessRecord(iso(T0 + 5 * hour)),
        // Another machine's reading of the same route: it can move no verdict here.
        availabilityRecord(iso(T0 + 2.5 * hour), false, OTHER), ...extra]),
      workspaceRows: timed, workspaceCases: allWorkspaceCases(), difficultyProfiles: registeredWorkspaceDifficultyProfiles(),
      spendAt: (at) => routeSpendPosture({ provider: 'claudeCLI', modelID: HAIKU, now: at }),
    });
  }

  it('lists one verdict per evidence instant, oldest first, each with policy, verdict, blockers and evidence window', async () => {
    const history = await timeline();
    expect(history.schema).toBe(QUALIFICATION_HISTORY_SCHEMA);
    expect(history.routeKey).toBe(ROUTE);
    expect(history.entries.map((entry) => entry.recordedAt)).toEqual(
      [0, 1, 2, 3, 4, 5].map((h) => new Date(T0 + h * hour).toISOString()));
    for (const entry of history.entries) {
      expect(entry.policyID).toBe(V1_QUALIFICATION_POLICY.policyID);
      expect(entry.evidenceWindow.from).toBe(new Date(T0).toISOString());
      expect(entry.evidenceWindow.to).toBe(entry.recordedAt);
    }
    expect(history.entries.map((entry) => entry.verdict)).toEqual(
      ['notRoutable', 'notRoutable', 'notRoutable', 'safeToRoute', 'notRoutable', 'notRoutable']);
    expect(history.entries.map((entry) => entry.evidenceWindow.workspaceRuns)).toEqual([0, 1, 2, 3, 3, 3]);
  }, 120_000);

  it('says why each verdict is what it is: no evidence, too little, qualified, then unavailable here', async () => {
    const [none, one, two, three, unavailable, stale] = (await timeline()).entries;
    expect(none.blockers.find((entry) => entry.kind === 'qualification')?.reason).toContain('no benchmark evidence exists');
    for (const early of [one, two]) {
      expect(early.capabilities.length).toBeGreaterThan(0);
      expect(early.capabilities.every((entry) => entry.verdict !== 'qualified')).toBe(true);
      expect(early.blockers.map((entry) => entry.kind)).toEqual(['qualification']);
    }
    expect(three.blockers).toEqual([]);
    expect(three.routableCapabilities.length).toBeGreaterThan(0);
    expect(three.capabilities.some((entry) => entry.verdict === 'qualified' && entry.scoredRunCount === 3)).toBe(true);
    expect(unavailable.blockers.map((entry) => entry.kind)).toEqual(['availability']);
    expect(unavailable.triggeredBy.map((entry) => entry.kind)).toEqual(['routeAvailability']);
    expect(stale.stalenessRecorded).toEqual([{ observedAt: iso(T0 + 5 * hour), machineKey: MACHINE,
      reasons: ['driverChanged'], detail: ['the workspace driver moved (fixture)'] }]);
    // The same verdict, the same capability verdicts and the same blocker kinds: not a change.
    expect(stale.changed).toBe(false);
    expect([none, one, three, unavailable].every((entry) => entry.changed)).toBe(true);
  }, 120_000);

  it('never consults another machine: its observation is neither an instant nor a blocker here', async () => {
    const history = await timeline();
    expect(history.entries.some((entry) => entry.recordedAt === new Date(T0 + 2.5 * hour).toISOString())).toBe(false);
    expect(history.entries.flatMap((entry) => entry.triggeredBy).some((entry) => entry.ref === availabilityRecord(iso(T0 + 2.5 * hour), false, OTHER).recordID))
      .toBe(false);
  }, 120_000);

  it('refuses a route nothing has recorded, and a string that is not a route', async () => {
    const { rows } = await sealed();
    const ask = (routeKey: string) => () => deriveQualificationHistory({ routeKey, machineKey: MACHINE, contents: storeOf([]), workspaceRows: rows });
    expect(ask('claudeCLI:claude-nonexistent-9')).toThrow(QualificationHistoryError);
    expect(ask('claudeCLI:claude-nonexistent-9')).toThrow(/has ever recorded|ever recorded/);
    expect(ask('no-colon-here')).toThrow(/is not a route/);
    expect(parseRouteKey('ollama:gemma3:4b')).toEqual({ provider: 'ollama', modelID: 'gemma3:4b' });
  }, 120_000);

  it('knows a route from the store alone, before any run of it exists', () => {
    const history = deriveQualificationHistory({ routeKey: 'opencodeCLI:opencode/big-pickle', machineKey: MACHINE,
      contents: storeOf([availabilityRecord(iso(T0), true, MACHINE, 'opencodeCLI:opencode/big-pickle')]), workspaceRows: [] });
    expect(history.entries).toHaveLength(1);
    expect(history.entries[0].verdict).toBe('notRoutable');
    expect(history.entries[0].blockers.map((entry) => entry.kind)).toContain('qualification');
  });
});

// ------------------------------------------------------------------ the command, in a subprocess

describe('cernum history <route>', () => {
  it('is declared read-only, takes a route, and offers --json', () => {
    const spec = commandSpec('history')!;
    expect(spec.effect).toBe('readOnly');
    expect(spec.positional).toBe('<route>');
    expect(acceptedOptions(spec).map((option) => option.name)).toEqual(expect.arrayContaining(['json', 'machine', 'evidence-roots', 'help']));
  });

  it('--json prints the timeline from the store and the sealed runs, oldest first, and writes nothing', async () => {
    const { root, rows, observedAt } = await sealed();
    const before = digestTree(root);
    const result = await cernum('history', ROUTE, '--json', '--machine', MACHINE, '--root', root);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const history = JSON.parse(result.stdout) as QualificationHistory;
    expect(history.routeKey).toBe(ROUTE);
    expect(history.machineKey).toBe(MACHINE);
    // The observations, then each distinct instant a run was sealed at (two runs sealed in the same
    // second are one instant, and one entry).
    const runInstants = new Set(rows.map((run) => Date.parse(String(run.row.recordedAt))));
    expect(rows).toHaveLength(3);
    expect(history.entries).toHaveLength(1 + runInstants.size);
    expect(history.entries[0].recordedAt).toBe(new Date(observedAt).toISOString());
    const instants = history.entries.map((entry) => Date.parse(entry.recordedAt));
    expect(instants).toEqual([...instants].sort((a, b) => a - b));
    expect(history.entries.every((entry) => entry.policyID === 'cqp1')).toBe(true);
    const last = history.entries[history.entries.length - 1];
    expect(last.verdict).toBe('safeToRoute');
    expect(history.entries.slice(0, -1).every((entry) => entry.verdict === 'notRoutable' && entry.blockers.length > 0)).toBe(true);
    expect(last.evidenceWindow).toMatchObject({ workspaceRuns: 3, observations: 2 });
    expect(digestTree(root)).toBe(before);
    expect(readObservationStore(root).observations).toHaveLength(2);
  }, 180_000);

  it('prints the same timeline for a person', async () => {
    const { root } = await sealed();
    const before = digestTree(root);
    const result = await cernum('history', ROUTE, '--machine', MACHINE, '--root', root);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`Qualification history of ${ROUTE}`);
    expect(result.stdout).toMatch(/\d verdict\(s\), oldest first\./);
    expect(result.stdout).toContain('SAFE TO ROUTE');
    expect(result.stdout).toMatch(/blocker {4}qualification:/);
    expect(result.stdout).toContain('· cqp1 ·');
    expect(result.stdout.replace(/\s+/g, ' ')).toContain('Nothing here was stored as a verdict, and nothing was written to produce it.');
    expect(digestTree(root)).toBe(before);
  }, 180_000);

  it('refuses an unknown route clearly and exits non-zero', async () => {
    const { root } = await sealed();
    const before = digestTree(root);
    const unknown = await cernum('history', 'claudeCLI:claude-nonexistent-9', '--machine', MACHINE, '--root', root);
    expect(unknown.status).not.toBe(0);
    expect(`${unknown.stdout}${unknown.stderr}`).toContain('claudeCLI:claude-nonexistent-9 is not a route this store or these evidence roots have ever recorded');
    const malformed = await cernum('history', 'not-a-route', '--machine', MACHINE, '--root', root);
    expect(malformed.status).not.toBe(0);
    expect(`${malformed.stdout}${malformed.stderr}`).toContain('is not a route');
    const missing = await cernum('history', '--machine', MACHINE, '--root', root);
    expect(missing.status).not.toBe(0);
    expect(`${missing.stdout}${missing.stderr}`).toContain('name the route');
    expect(digestTree(root)).toBe(before);
  }, 180_000);

  it('refuses an empty root for an unknown route without creating anything in it', async () => {
    const root = temporary('cernum-history-empty-');
    const result = await cernum('history', ROUTE, '--json', '--machine', MACHINE, '--root', root);
    expect(result.status).not.toBe(0);
    expect(fs.readdirSync(root)).toEqual([]);
  }, 120_000);
});
