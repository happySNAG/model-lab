// `cernum status-export --json` — one versioned, read-only document (cse1) for Ordra Office: the discovered
// models, the qualified routes, per-capability candidates, the metrics rollup, regression findings, recent
// qualification results, costs where known, the fallback chain for each task type, and the active leases,
// validated against the JSON schema in docs/ordra-lane/status-export.schema.json.
//
// FIXTURES ONLY. The sealed runs come from a scripted matrix (real `node` verification against the
// repository's fixtures, no provider). The engine tests re-time copies of those rows in memory; observations
// are sealed by the store's own constructors; leases are hand-written inspections, or one taken by this test
// process in a temporary root. The command is spawned with --machine and --root and with the network
// tripwire preloaded, so nothing reads this Mac's identity or campaign root and any connection is refused.

import { afterAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SYNTHETIC_HARDWARE } from '../../src/engine/synthetic';
import { provenModel } from './frontier-harness';
import { JsonSchema, validateAgainstSchema } from './json-schema-subset';
import { BROKEN_SUM_MEAN, allWorkspaceCases } from '../../src/engine/workspace-catalog';
import { makeWorkspaceBenchmarkPack } from '../../src/engine/workspace-pack';
import { ScriptedAttempt, ScriptedWorkspaceAgent, WorkspaceAgentDriver, WorkspaceAgentRequest } from '../../src/engine/workspace-agent';
import { WorkspaceMatrixRequest, buildWorkspaceMatrixPlan, runWorkspaceMatrix } from '../../src/engine/workspace-matrix';
import { WorkspaceRunRow, collectWorkspaceRunRows } from '../../src/engine/workspace-aggregate';
import { registeredWorkspaceDifficultyProfiles } from '../../src/engine/workspace-difficulty-catalog';
import { routeSpendPosture } from '../../src/engine/route-spend-posture';
import { DiscoverySnapshot } from '../../src/engine/discovery-refresh';
import {
  ObservationRecord, ObservationStoreContents, appendObservations, discoverySnapshotObservation, readObservationStore,
  routeAvailabilityObservation,
} from '../../src/engine/observation-store';
import { LockInspection } from '../../src/engine/lock';
import { acquireRuntimeLease } from '../../src/engine/runtime-lease';
import { deriveMetricsRollup } from '../../src/engine/metrics-rollup';
import { detectRegressions } from '../../src/engine/regression-detector';
import { deriveQualificationHistory } from '../../src/engine/qualification-history';
import { ALL_ORDRA_TASK_TYPES, TASK_TAXONOMY } from '../../src/engine/task-taxonomy';
import { FALLBACK_CHAIN_IS_NOT_A_SELECTION } from '../../src/engine/fallback-chain';
import {
  STATUS_EXPORT_IS_READ_ONLY, STATUS_EXPORT_JSON_SCHEMA_PATH, STATUS_EXPORT_SCHEMA, STATUS_EXPORT_SCHEMA_VERSION,
  StatusExport, StatusExportError, StatusExportInputs, deriveStatusExport,
} from '../../src/engine/status-export';
import { acceptedOptions, commandSpec } from '../../src/cli/command-spec';

const REPOSITORY = path.resolve(__dirname, '../..');
const FIXTURE_ROOT = path.join(REPOSITORY, 'fixtures');
const PRELOAD = path.join(__dirname, 'fixtures', 'no-network-preload.cjs');
const SCHEMA = JSON.parse(fs.readFileSync(path.join(REPOSITORY, STATUS_EXPORT_JSON_SCHEMA_PATH), 'utf8')) as JsonSchema;
const HAIKU = 'claude-haiku-4-5';
const ROUTE = `claudeCLI:${HAIKU}`;
const PICKLE = 'opencodeCLI:opencode/big-pickle';
const MACHINE = 'cmk1:status-export-machine';

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

/** Haiku listed and proven; a hosted route listed with a published $0 price and no run of it anywhere. */
function snapshot(at: string): DiscoverySnapshot {
  return {
    schema: 'cds1', machineKey: MACHINE, takenAt: at, providerAllowlist: 'cpa1',
    providers: [{ provider: 'claudeCLI', refreshed: true, detail: 'a fixture: no provider was contacted' },
      { provider: 'opencodeCLI', refreshed: true, detail: 'a fixture: no provider was contacted' }],
    routes: [
      { routeKey: ROUTE, provider: 'claudeCLI', modelID: HAIKU, listed: true, availability: 'proven', observedAt: at },
      { routeKey: PICKLE, provider: 'opencodeCLI', modelID: 'opencode/big-pickle', listed: true, priceFingerprint: 'in:0/out:0',
        publishedFree: true, contextWindowTokens: 200_000, observedAt: at },
    ],
  };
}
const snapshotRecord = (at: string): ObservationRecord => discoverySnapshotObservation(snapshot(at), 'status-host', 'a fixture snapshot');
const availabilityRecord = (at: string): ObservationRecord =>
  routeAvailabilityObservation({ routeKey: ROUTE, machineKey: MACHINE, machineLabel: 'status-host', observedAt: at, available: true,
    reason: 'signed in (fixture)' }, 'claudeCLI', 'a fixture availability reading');
const storeOf = (records: ObservationRecord[]): ObservationStoreContents => ({
  schema: 'cos1', root: '/virtual/.observations', corrupt: [],
  observations: records.map((record) => ({ record, origin: 'observedHere', receivedAt: record.observedAt })),
});

/** Three sealed runs of Haiku on the broken-sum case, each attempt scripted the same way. */
async function sealRuns(root: string, attempt: ScriptedAttempt, label: string): Promise<void> {
  const request: WorkspaceMatrixRequest = {
    pack: makeWorkspaceBenchmarkPack({ id: `pack.test.status-export.${label}`, version: '1', caseIDs: [BROKEN_SUM_MEAN.id], repeatsPerCase: 3 }),
    cases: allWorkspaceCases(), provider: 'claudeCLI', modelIDs: [HAIKU], effort: 'none',
    discovery: { writtenAt: new Date().toISOString(), models: [{ ...provenModel('claudeCLI', HAIKU), discoveredAt: new Date().toISOString() }] },
    campaignRoot: root, fixtureRoot: FIXTURE_ROOT, sandboxRoot: sharedTemporary('cernum-status-export-sandbox-'), runLabel: `status-export-${label}`,
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

/** A campaign root: an observation store observed a minute ago and three passing sealed runs. */
async function sealedRoot(): Promise<{ root: string; rows: WorkspaceRunRow[] }> {
  const root = sharedTemporary('cernum-status-export-root-');
  const observedAt = iso(Date.now() - 60_000);
  appendObservations(root, [snapshotRecord(observedAt), availabilityRecord(observedAt)], { origin: 'observedHere', receivedAt: observedAt });
  await sealRuns(root, FIXES_BROKEN_SUM, 'pass');
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
function cernum(networkLog: string, ...args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(path.join(REPOSITORY, 'node_modules', '.bin', 'tsx'), ['src/cli/cernum.ts', ...args], {
      cwd: REPOSITORY,
      env: { ...process.env, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
        // Quoted: the checkout path contains a space, and NODE_OPTIONS splits on whitespace.
        NODE_OPTIONS: `--require ${JSON.stringify(PRELOAD)}`, CERNUM_NETWORK_LOG: networkLog },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}
const networkUse = (log: string): string[] => (!fs.existsSync(log) ? []
  : fs.readFileSync(log, 'utf8').split('\n').filter((line) => line.length > 0 && !/ ipc /.test(line)));

// ------------------------------------------------------------------ the engine, over fixed instants

const T0 = Date.parse('2026-10-01T00:00:00Z');
const hour = 3_600_000;
const day = 24 * hour;

/** Copies of the first sealed passing run, an hour apart from T0 + 1 h, each its own record root. */
async function runsOf(statuses: string[]): Promise<WorkspaceRunRow[]> {
  const { rows } = await sealed();
  const template = rows.find((run) => run.row.status === 'pass')!;
  return statuses.map((status, index) => ({
    recordRoot: `${template.recordRoot}#copy-${index}`,
    row: { ...template.row, recordedAt: iso(T0 + (index + 1) * hour), repeatIndex: index, status,
      wallClockMilliseconds: 1_000, totalTokens: 5_000 },
  }));
}

const LIVE_LEASE: LockInspection = {
  held: true, state: 'live', heartbeatAgeMilliseconds: 2_000, recoverable: false,
  message: 'the benchmark endpoint http://127.0.0.1:11434 is already held by campaign \'fixture-live\' (fixture)',
  record: { lockFormatVersion: 1, nonce: 'n-live', pid: 4242, processType: 'terminal', command: 'cernum run fixture-live',
    hostname: 'status-host', campaignID: 'c-live', campaignName: 'fixture-live', acquiredAt: iso(T0), heartbeatAt: iso(T0),
    endpoint: 'http://127.0.0.1:11434', endpointAsGiven: 'http://localhost:11434', modelStoreCount: 3 },
};
const STALE_LEASE: LockInspection = {
  held: true, state: 'stale', heartbeatAgeMilliseconds: 9 * hour, recoverable: true,
  message: 'the benchmark endpoint http://127.0.0.1:11500 was left leased by a process that no longer exists (fixture)',
  record: { lockFormatVersion: 1, nonce: 'n-stale', pid: 4343, processType: 'terminal', command: 'cernum run fixture-stale',
    hostname: 'status-host', campaignID: 'c-stale', campaignName: 'fixture-stale', acquiredAt: iso(T0), heartbeatAt: iso(T0),
    endpoint: 'http://127.0.0.1:11500' },
};

async function inputs(over: Partial<StatusExportInputs> = {}, statuses = ['pass', 'pass', 'pass', 'pass', 'pass', 'pass']):
  Promise<StatusExportInputs> {
  return {
    machineKey: MACHINE, contents: storeOf([snapshotRecord(iso(T0)), availabilityRecord(iso(T0))]),
    workspaceRows: await runsOf(statuses), workspaceCases: allWorkspaceCases(), difficultyProfiles: registeredWorkspaceDifficultyProfiles(),
    leases: [STALE_LEASE, LIVE_LEASE], spendFor: ({ provider, modelID }, at) => routeSpendPosture({ provider, modelID, now: at }),
    now: new Date(T0 + 7 * hour), ...over,
  };
}

describe('the document, one versioned value validated against the schema in docs', () => {
  it('carries its schema id, version and schema path, and validates against docs/ordra-lane/status-export.schema.json', async () => {
    const document = deriveStatusExport(await inputs());
    expect(document).toMatchObject({ schema: STATUS_EXPORT_SCHEMA, schemaVersion: STATUS_EXPORT_SCHEMA_VERSION,
      jsonSchema: STATUS_EXPORT_JSON_SCHEMA_PATH, readOnly: true, machineKey: MACHINE, disclosure: STATUS_EXPORT_IS_READ_ONLY });
    expect(STATUS_EXPORT_SCHEMA).toBe('cse1');
    expect(STATUS_EXPORT_SCHEMA_VERSION).toBe(1);
    expect(SCHEMA.$id).toBe('cernum:status-export:cse1:1');
    expect(validateAgainstSchema(JSON.parse(JSON.stringify(document)), SCHEMA)).toEqual([]);
    // Every top-level field is one the schema requires, and every required field is present.
    expect(Object.keys(document).sort()).toEqual([...(SCHEMA.required as string[])].sort());
    expect(document.versions).toMatchObject({ routingContract: 'crc2', routingPolicy: 'crp2', qualificationPolicy: 'cqp1',
      metricsRollup: 'cmr1', regressionReport: 'crg1', regressionThresholds: 'crt1', qualificationHistory: 'cqh1',
      taskTaxonomy: 'ctt1', fallbackChain: 'cfc1', discoverySnapshot: 'cds1', observationStore: 'cos1' });
  }, 180_000);

  it('is refused by the schema when it is not this document: the validator is not a rubber stamp', async () => {
    const document = JSON.parse(JSON.stringify(deriveStatusExport(await inputs()))) as Record<string, unknown>;
    expect(validateAgainstSchema({ ...document, schema: 'cse2' }, SCHEMA)).toEqual(['$.schema: expected "cse1", found "cse2"']);
    const { activeLeases: _dropped, ...withoutLeases } = document;
    expect(validateAgainstSchema(withoutLeases, SCHEMA)).toEqual(["$: missing required 'activeLeases'"]);
    expect(validateAgainstSchema({ ...document, surprise: 1 }, SCHEMA)).toEqual(["$: 'surprise' is not allowed"]);
    const fallback = document.fallbackChains as { tasks: unknown[] };
    expect(validateAgainstSchema({ ...document, fallbackChains: { ...fallback, tasks: fallback.tasks.slice(1) } }, SCHEMA))
      .toEqual(['$.fallbackChains.tasks: fewer than 8 items']);
    expect(() => validateAgainstSchema({}, { type: 'object', oneOf: [] })).toThrow(/not implemented/);
  }, 180_000);
});

describe('every section, from the module that owns it', () => {
  it('lists the discovered models with their metadata as the latest snapshot on the machine recorded them', async () => {
    const { discoveredModels } = deriveStatusExport(await inputs());
    expect(discoveredModels.snapshotTakenAt).toBe(iso(T0));
    expect(discoveredModels.providerAllowlist).toBe('cpa1');
    expect(discoveredModels.providers.map((provider) => provider.provider)).toEqual(['claudeCLI', 'opencodeCLI']);
    expect(discoveredModels.models.map((model) => model.routeKey)).toEqual([ROUTE, PICKLE]);
    expect(discoveredModels.models[1]).toMatchObject({ priceFingerprint: 'in:0/out:0', publishedFree: true, contextWindowTokens: 200_000 });

    const none = deriveStatusExport(await inputs({ contents: storeOf([]) })).discoveredModels;
    expect(none.models).toEqual([]);
    expect(none.snapshotTakenAt).toBeUndefined();
    expect(none.reason).toContain('no discovery snapshot was ever recorded');
  }, 180_000);

  it('reports every known route\'s qualification and which are safe to route, and per-capability candidates', async () => {
    const document = deriveStatusExport(await inputs());
    expect(document.qualifiedRoutes.routes.map((route) => route.routeKey)).toEqual([ROUTE, PICKLE]);
    expect(document.qualifiedRoutes.safeToRouteKeys).toEqual([ROUTE]);
    const haiku = document.qualifiedRoutes.routes[0];
    expect(haiku.routableCapabilities.length).toBeGreaterThan(0);
    expect(haiku.capabilities.every((capability) => capability.scoredRunCount === 6)).toBe(true);
    const pickle = document.qualifiedRoutes.routes[1];
    expect(pickle.safeToRoute).toBe(false);
    expect(pickle.blockers.length).toBeGreaterThan(0);

    const names = document.capabilityCandidates.capabilities.map((entry) => entry.capability);
    expect(names).toEqual([...haiku.capabilities.map((capability) => capability.capability)].sort());
    for (const entry of document.capabilityCandidates.capabilities) {
      expect(entry.query).toMatchObject({ machineKey: MACHINE, capability: entry.capability, costPolicy: 'zeroMarginalCostOnly' });
      expect(entry.candidates.map((candidate) => candidate.routeKey)).toEqual([ROUTE]);
      expect(entry.excluded.map((excluded) => excluded.routeKey)).toEqual([PICKLE]);
      expect(entry.excluded[0].reasons.length).toBeGreaterThan(0);
    }
  }, 180_000);

  it('carries the metrics rollup and the regression report exactly as their own modules derive them', async () => {
    const given = await inputs({}, ['pass', 'pass', 'pass', 'fail', 'fail', 'fail']);
    const document = deriveStatusExport(given);
    const options = { workspaceCases: given.workspaceCases, difficultyProfiles: given.difficultyProfiles };
    expect(document.metricsRollup).toEqual(deriveMetricsRollup({ workspaceRows: given.workspaceRows, ...options }));
    expect(document.regressions).toEqual(detectRegressions({ machineKey: MACHINE, contents: given.contents,
      workspaceRows: given.workspaceRows, now: given.now, spendFor: given.spendFor, ...options }));
    expect(document.regressions.regressedRouteCount).toBe(1);
    expect(document.regressions.routes[0].findings.map((finding) => finding.kind)).toEqual(expect.arrayContaining(['verdictDowngrade', 'successRateDrop']));
    expect(validateAgainstSchema(JSON.parse(JSON.stringify(document)), SCHEMA)).toEqual([]);
  }, 180_000);

  it('carries the newest qualification history entries of each route, the history module\'s own', async () => {
    const given = await inputs();
    const document = deriveStatusExport(given);
    const haiku = document.recentQualificationResults.routes.find((route) => route.routeKey === ROUTE)!;
    const history = deriveQualificationHistory({ routeKey: ROUTE, machineKey: MACHINE, contents: given.contents,
      workspaceRows: given.workspaceRows, workspaceCases: given.workspaceCases, difficultyProfiles: given.difficultyProfiles,
      spendAt: (at) => routeSpendPosture({ provider: 'claudeCLI', modelID: HAIKU, now: at }) });
    expect(document.recentQualificationResults.entriesPerRoute).toBe(5);
    expect(haiku.historyEntryCount).toBe(history.entries.length);
    expect(history.entries.length).toBeGreaterThan(5);
    expect(haiku.entries).toEqual(history.entries.slice(-5));
    expect(haiku.entries[haiku.entries.length - 1].verdict).toBe('safeToRoute');
    const two = deriveStatusExport({ ...given, recentQualificationEntries: 2 });
    expect(two.recentQualificationResults.routes.find((route) => route.routeKey === ROUTE)!.entries).toEqual(history.entries.slice(-2));
  }, 180_000);

  it('reports costs where known and leaves each unknown unknown, with the reason', async () => {
    const document = deriveStatusExport(await inputs());
    const haiku = document.costs.find((cost) => cost.routeKey === ROUTE)!;
    expect(haiku.spend).toMatchObject({ eligibility: 'subscription_included', zeroMarginalCost: true });
    expect(haiku.recorded?.knownRunCount).toBe(document.metricsRollup.routes[0].route.cost.knownRunCount);
    expect(haiku.recorded).toEqual(document.metricsRollup.routes[0].route.cost);
    expect(haiku.published).toBeUndefined();
    expect(haiku.reason).toContain('the latest snapshot recorded no published price');

    const pickle = document.costs.find((cost) => cost.routeKey === PICKLE)!;
    expect(pickle.recorded).toBeUndefined();
    expect(pickle.published).toEqual({ priceFingerprint: 'in:0/out:0', publishedFree: true, observedAt: iso(T0) });
    expect(pickle.state).toBe('partlyKnown');
    expect(pickle.reason).toContain('no sealed run of this route exists');

    const bare = deriveStatusExport(await inputs({ spendFor: undefined, contents: storeOf([availabilityRecord(iso(T0))]) }));
    expect(bare.costs.find((cost) => cost.routeKey === ROUTE)!.spend).toBeUndefined();
    expect(bare.costs.find((cost) => cost.routeKey === ROUTE)!.reason).toContain('no spend posture was given');
  }, 180_000);

  it('gives the fallback chain for every task type of ctt1 at every tier, advisory and never a selection', async () => {
    const document = deriveStatusExport(await inputs());
    const { fallbackChains } = document;
    expect(fallbackChains).toMatchObject({ taxonomyVersion: 'ctt1', rule: 'cfc1', isSelection: false,
      disclosure: FALLBACK_CHAIN_IS_NOT_A_SELECTION, contextRequirement: { applied: false } });
    expect(fallbackChains.tasks.map((task) => task.taskType)).toEqual(ALL_ORDRA_TASK_TYPES);
    const qualified = new Set(document.qualifiedRoutes.routes[0].capabilities
      .filter((capability) => capability.verdict === 'qualified').map((capability) => capability.capability));
    let chained = 0;
    for (const task of fallbackChains.tasks) {
      expect(task.capability).toBe(`workspace:${TASK_TAXONOMY[task.taskType].dimension}`);
      expect(task.tiers.map((tier) => tier.tier)).toEqual(['tier1', 'tier2', 'tier3']);
      for (const tier of task.tiers) {
        expect(tier.query).toMatchObject({ machineKey: MACHINE, capability: task.capability, structuralTier: tier.tier,
          costPolicy: 'zeroMarginalCostOnly', routingPolicyVersion: 'crp2' });
        expect(tier.query.minimumContextTokens).toBeUndefined();
        // Haiku stands in a chain exactly where it is qualified for both the task's capability and the tier.
        const expected = qualified.has(task.capability) && qualified.has(`workspace-tier:${tier.tier}`) ? [ROUTE] : [];
        expect(tier.chain).toEqual(expected);
        expect([...tier.entries.map((entry) => entry.routeKey), ...tier.excluded.map((entry) => entry.routeKey)].sort())
          .toEqual([ROUTE, PICKLE].sort());
        chained += tier.chain.length;
      }
    }
    expect(chained).toBeGreaterThan(0);
  }, 180_000);

  it('applies a context requirement only when one is given, and an unknown context window cannot satisfy it', async () => {
    const document = deriveStatusExport(await inputs({ contextTokens: 8_000 }));
    expect(document.fallbackChains.contextRequirement).toMatchObject({ applied: true, contextTokens: 8_000 });
    for (const tier of document.fallbackChains.tasks.flatMap((task) => task.tiers)) {
      expect(tier.query.minimumContextTokens).toBe(8_000);
      expect(tier.chain).toEqual([]);
      expect(tier.excluded.find((entry) => entry.routeKey === ROUTE)!.reasons.join(' ')).toContain('context window is UNKNOWN');
    }
    expect(validateAgainstSchema(JSON.parse(JSON.stringify(document)), SCHEMA)).toEqual([]);
  }, 180_000);

  it('lists the leases it was given, which are active, and says when none were read', async () => {
    const { activeLeases } = deriveStatusExport(await inputs());
    expect(activeLeases.read).toBe(true);
    expect(activeLeases.activeCount).toBe(1);
    expect(activeLeases.leases.map((lease) => [lease.endpoint, lease.state, lease.active])).toEqual([
      ['http://127.0.0.1:11434', 'live', true], ['http://127.0.0.1:11500', 'stale', false]]);
    expect(activeLeases.leases[0]).toMatchObject({ campaignName: 'fixture-live', pid: 4242, modelStoreCount: 3, recoverable: false });

    const unread = deriveStatusExport(await inputs({ leases: undefined })).activeLeases;
    expect(unread).toEqual({ read: false, activeCount: 0, leases: [] });
  }, 180_000);
});

describe('read-only, and refusing what it cannot apply', () => {
  it('changes none of its inputs, and the same evidence gives the same document', async () => {
    const given = await inputs({}, ['pass', 'pass', 'pass', 'fail', 'fail', 'fail']);
    const before = JSON.stringify({ contents: given.contents, rows: given.workspaceRows, leases: given.leases });
    const document = deriveStatusExport(given);
    expect(JSON.stringify({ contents: given.contents, rows: given.workspaceRows, leases: given.leases })).toBe(before);
    expect(deriveStatusExport(given)).toEqual(document);
  }, 180_000);

  it('refuses a context requirement or an entry count it could not apply', async () => {
    const given = await inputs();
    for (const contextTokens of [0, -1, 1.5, Number.NaN]) {
      expect(() => deriveStatusExport({ ...given, contextTokens })).toThrow(StatusExportError);
    }
    for (const recentQualificationEntries of [0, 2.5]) {
      expect(() => deriveStatusExport({ ...given, recentQualificationEntries })).toThrow(StatusExportError);
    }
  }, 180_000);

  it('is documented: the feature page names the schema, its version and every section', () => {
    const documented = fs.readFileSync(path.join(REPOSITORY, 'docs/ordra-lane/status-export.md'), 'utf8');
    for (const phrase of ['`cse1`', 'version 1', 'status-export.schema.json', 'cernum status-export --json']) expect(documented).toContain(phrase);
    for (const section of SCHEMA.required as string[]) expect(documented).toContain(`\`${section}\``);
  });
});

// ------------------------------------------------------------------ the command, in a subprocess

describe('cernum status-export', () => {
  it('is declared read-only, takes no positional argument, and offers --json', () => {
    const spec = commandSpec('status-export')!;
    expect(spec.effect).toBe('readOnly');
    expect(spec.positional).toBe('');
    expect(acceptedOptions(spec).map((option) => option.name)).toEqual(
      expect.arrayContaining(['json', 'machine', 'evidence-roots', 'policy', 'context', 'root', 'help']));
  });

  it('--json emits one document that validates against the schema, writes nothing and contacts nothing', async () => {
    const { root, rows } = await sealed();
    expect(rows).toHaveLength(3);
    const lease = acquireRuntimeLease(root, { processType: 'terminal', command: 'status-export test', campaignID: 'c-test',
      campaignName: 'status-export-fixture', endpoint: 'http://localhost:11434', modelStoreCount: 2 }, { heartbeatIntervalMilliseconds: 0 });
    try {
      const networkLog = path.join(sharedTemporary('cernum-status-export-net-'), 'network.log');
      const before = digestTree(root);
      const result = await cernum(networkLog, 'status-export', '--json', '--machine', MACHINE, '--root', root);
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      const document = JSON.parse(result.stdout) as StatusExport;
      expect(validateAgainstSchema(document, SCHEMA)).toEqual([]);
      expect(document).toMatchObject({ schema: 'cse1', schemaVersion: 1, machineKey: MACHINE, readOnly: true });
      expect(document.discoveredModels.models.map((model) => model.routeKey)).toEqual([ROUTE, PICKLE]);
      expect(document.qualifiedRoutes.safeToRouteKeys).toEqual([ROUTE]);
      expect(document.metricsRollup.routes.map((route) => route.routeKey)).toEqual([ROUTE]);
      expect(document.regressions.routes.map((route) => route.routeKey)).toEqual([ROUTE]);
      expect(document.recentQualificationResults.routes.map((route) => route.routeKey)).toEqual([ROUTE, PICKLE]);
      expect(document.fallbackChains.tasks.flatMap((task) => task.tiers.flatMap((tier) => tier.chain))).toContain(ROUTE);
      expect(document.activeLeases).toMatchObject({ read: true, activeCount: 1 });
      expect(document.activeLeases.leases[0]).toMatchObject({ endpoint: 'http://127.0.0.1:11434', state: 'live', active: true,
        campaignName: 'status-export-fixture', pid: process.pid });
      expect(digestTree(root)).toBe(before);
      expect(readObservationStore(root).observations).toHaveLength(2);
      expect(networkUse(networkLog)).toEqual([]);
    } finally {
      lease.release();
    }
  }, 240_000);

  it('prints a summary for a person, and refuses an unreadable --context or a positional argument, writing nothing', async () => {
    const { root } = await sealed();
    const networkLog = path.join(sharedTemporary('cernum-status-export-net-'), 'network.log');
    const before = digestTree(root);
    const result = await cernum(networkLog, 'status-export', '--machine', MACHINE, '--root', root, '--context', '8000');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Status export cse1 v1');
    expect(result.stdout).toContain('2 known · 1 safe to route');
    expect(result.stdout).toContain('8 task type(s), each at 3 tier(s)');
    expect(result.stdout.replace(/\s+/g, ' ')).toContain('nothing was written and no model, provider or network service was contacted');
    const unreadable = await cernum(networkLog, 'status-export', '--json', '--machine', MACHINE, '--root', root, '--context', 'lots');
    expect(unreadable.status).toBe(2);
    expect(`${unreadable.stdout}${unreadable.stderr}`).toContain('--context must be a positive whole number of tokens');
    const positional = await cernum(networkLog, 'status-export', 'extra', '--machine', MACHINE, '--root', root);
    expect(positional.status).toBe(2);
    expect(digestTree(root)).toBe(before);
    expect(networkUse(networkLog)).toEqual([]);
  }, 240_000);
});
