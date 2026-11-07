// The Qualification and Routing screens: the read-only service that reads the cse1 status export from a
// campaign root, and the pure view-model that turns the document into each screen's rows (G-24181 C0).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as net from 'node:net';
import { ChildProcess } from 'node:child_process';
import { observationStorePath, runtimeLeaseDirectory } from '../../src/engine/index';
import type { StatusExport } from '../../src/engine/status-export';
import { readRoutingStatus } from '../../src/main/routing-status-service';
import { menuTemplate, MenuActions } from '../../src/main/menu';
import { SCREEN_ORDER, ScreenID } from '../../src/shared/ipc';
import { qualificationView, qualificationViewOf, routingView, routingViewOf } from '../../src/renderer/routing-status-view';
import { JsonSchema, validateAgainstSchema } from '../engine/json-schema-subset';

const SCHEMA = JSON.parse(fs.readFileSync(path.join(__dirname, '../../docs/ordra-lane/status-export.schema.json'), 'utf8')) as JsonSchema;
const MACHINE = 'cmk1:000000000000000000000000';
const NOW = new Date('2026-11-07T12:00:00Z');

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'cernum-views-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); });

/** Every path under `directory`, with its mtime and size, so any write shows up as a difference. */
function listing(directory: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (at: string) => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name);
      const stat = fs.statSync(full);
      out[path.relative(directory, full)] = `${entry.isDirectory() ? 'd' : 'f'}:${stat.mtimeMs}:${stat.size}`;
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(directory);
  return out;
}

// ---- a hand-written cse1 schemaVersion 2 document ------------------------------------------------

const TASK_TYPES = ['implement', 'fix', 'test-repair', 'refactor', 'docs', 'verify', 'plan', 'review'] as const;
const TIERS = ['tier1', 'tier2', 'tier3'] as const;
const unknown = (note: string) => ({ provenance: 'unavailable', note });

const ROUTE_A = 'ollama:qwen3:8b';
const ROUTE_B = 'claudeCLI:claude-haiku-4-5';
const ROUTE_C = 'codexCLI:gpt-5-codex';

function qualifiedRoute(routeKey: string, provider: string, modelID: string, safe: boolean) {
  return {
    routeKey, provider, modelID, safeToRoute: safe, routableCapabilities: safe ? ['workspace:implement'] : [],
    qualificationScope: provider === 'ollama' ? 'machine' : 'route',
    discovered: { state: 'listed', reason: 'the latest snapshot listed it' },
    availability: { state: 'available', reason: 'observed available', observedAt: '2026-11-06T09:00:00Z' },
    identityConfidence: 'confirmed', identityAdmitted: true,
    ...(safe ? { lastSuccessfulQualificationAt: '2026-10-08T09:00:00Z' } : {}),
    capabilities: [{ capability: 'workspace:implement', verdict: safe ? 'qualified' : 'insufficientEvidence',
      scoredRunCount: safe ? 5 : 1, successCount: safe ? 5 : 1, reason: safe ? '5 of 5 passed' : 'too few runs' }],
    blockers: safe ? [] : [{ kind: 'insufficientEvidence', reason: 'no capability has enough scored runs' }],
  };
}

function historyEntry(recordedAt: string, verdict: 'safeToRoute' | 'notRoutable') {
  return {
    recordedAt, policyID: 'cqp1', routingPolicyVersion: 'crp2', verdict,
    routableCapabilities: verdict === 'safeToRoute' ? ['workspace:implement'] : [],
    capabilities: [{ capability: 'workspace:implement', verdict: verdict === 'safeToRoute' ? 'qualified' : 'insufficientEvidence', scoredRunCount: 5, successCount: 5 }],
    blockers: [], evidenceWindow: { from: '2026-10-01T09:00:00Z', to: recordedAt, workspaceRuns: 5, observations: 1 },
    triggeredBy: ['workspaceRun'], stalenessRecorded: [], changed: true,
  };
}

function regressionRoute(routeKey: string, findings: { kind: string; scope: string; summary: string }[]) {
  return {
    routeKey, provider: routeKey.split(':')[0], modelID: routeKey.slice(routeKey.indexOf(':') + 1), historyEntryCount: 2,
    downgrades: [], windows: { baseline: { scoredRunCount: 0, passCount: 0, recordRoots: [] }, latest: { scoredRunCount: 0, passCount: 0, recordRoots: [] } },
    comparisons: [{ metric: 'successRateMilli', threshold: '50', state: findings.some((f) => f.kind === 'successRateDrop') ? 'regressed' : 'notComparable', reason: 'as recorded' }],
    staleness: { recorded: [] }, findings,
  };
}

const query = (taskType: string, tier: string) => ({
  machineKey: MACHINE, capability: `workspace:${taskType}`, structuralTier: tier, costPolicy: 'zeroMarginalCostOnly', routingPolicyVersion: 'crp2',
});

const fallbackEntry = (position: number, routeKey: string, inChain: boolean) => ({
  position, routeKey, standing: inChain ? 'inChain' : 'fallsThrough', fallsThroughBecause: inChain ? [] : ['the qualification is stale'],
  group: 'zeroMarginalCost', failureRateMilli: unknown('no runs'), p90WallClockMilliseconds: unknown('no runs'),
});

/** Implement at tier1 has A then C (C falls through); every other task and tier has B alone. */
function tiersFor(taskType: string) {
  return TIERS.map((tier) => {
    const entries = taskType === 'implement' && tier === 'tier1'
      ? [fallbackEntry(1, ROUTE_A, true), fallbackEntry(2, ROUTE_C, false)]
      : taskType === 'docs' && tier === 'tier3' ? [] : [fallbackEntry(1, ROUTE_B, true)];
    return { tier, query: query(taskType, tier), chain: entries.filter((e) => e.standing === 'inChain').map((e) => e.routeKey), entries, excluded: [] };
  });
}

const HAND_WRITTEN = {
  schema: 'cse1', schemaVersion: 2, jsonSchema: 'docs/ordra-lane/status-export.schema.json',
  generatedAt: '2026-11-07T12:00:00.000Z', machineKey: MACHINE, effort: 'any', readOnly: true,
  versions: {
    observationStore: 'cos1', discoverySnapshot: 'cds1', qualificationPolicy: 'cqp1', routingPolicy: 'crp2', routingContract: 'crc2',
    metricsRollup: 'cmr1', regressionReport: 'crg1', regressionThresholds: 'crt1', qualificationHistory: 'cqh1', taskTaxonomy: 'ctt1', fallbackChain: 'cfc1',
  },
  discoveredModels: { snapshotSchema: 'cds1', providers: [], models: [], reason: 'no discovery snapshot was ever recorded' },
  qualifiedRoutes: {
    safeToRouteKeys: [ROUTE_B, ROUTE_A],
    routes: [
      qualifiedRoute(ROUTE_B, 'claudeCLI', 'claude-haiku-4-5', true),
      qualifiedRoute(ROUTE_C, 'codexCLI', 'gpt-5-codex', false),
      qualifiedRoute(ROUTE_A, 'ollama', 'qwen3:8b', true),
    ],
  },
  capabilityCandidates: { disclosure: 'not a choice', capabilities: [] },
  metricsRollup: { schema: 'cmr1', effort: 'any', routes: [], unattributedRunCount: 0, disclosure: 'measured only' },
  regressions: {
    schema: 'crg1', thresholds: { thresholdsID: 'crt1' }, qualificationPolicyID: 'cqp1', routingPolicyVersion: 'crp2', machineKey: MACHINE,
    derivedAt: '2026-11-07T12:00:00.000Z',
    routes: [
      regressionRoute(ROUTE_B, []),
      regressionRoute(ROUTE_C, [{ kind: 'staleQualification', scope: 'route', summary: 'the qualification is stale: its evidence is older than 30 days' }]),
      regressionRoute(ROUTE_A, [{ kind: 'successRateDrop', scope: 'workspace:implement', summary: 'the success rate fell from 1000 to 400 milli' }]),
    ],
    regressedRouteCount: 1, staleRouteCount: 1, undatedWorkspaceRuns: [], corrupt: [], disclosure: 'detection only',
  },
  recentQualificationResults: {
    entriesPerRoute: 5,
    routes: [
      { routeKey: ROUTE_B, historyEntryCount: 2, entries: [historyEntry('2026-10-01T09:00:00Z', 'notRoutable'), historyEntry('2026-10-08T09:00:00Z', 'safeToRoute')], undatedWorkspaceRuns: [] },
      { routeKey: ROUTE_C, historyEntryCount: 0, entries: [], undatedWorkspaceRuns: [] },
      { routeKey: ROUTE_A, historyEntryCount: 1, entries: [historyEntry('2026-10-08T09:00:00Z', 'safeToRoute')], undatedWorkspaceRuns: [] },
    ],
  },
  costs: [
    { routeKey: ROUTE_B, state: 'unknown', reason: 'no sealed run of this route exists' },
    { routeKey: ROUTE_C, state: 'unknown', reason: 'no sealed run of this route exists' },
    { routeKey: ROUTE_A, state: 'unknown', reason: 'no sealed run of this route exists' },
  ],
  fallbackChains: {
    taxonomyVersion: 'ctt1', rule: 'cfc1', contextRequirement: { applied: false, reason: 'no context requirement was given' },
    isSelection: false, disclosure: 'A fallback chain is advisory and not a selection.',
    tasks: TASK_TYPES.map((taskType) => ({ taskType, capability: `workspace:${taskType}`, tiers: tiersFor(taskType) })),
  },
  activeLeases: { read: true, activeCount: 0, leases: [] },
  corrupt: [],
  disclosure: 'Read-only.',
  expiryWarnings: [
    { routeKey: ROUTE_A, expiresAt: '2026-11-06T09:00:00Z', state: 'expired', reason: 'the cqp1 qualification expired 2026-11-06T09:00:00Z' },
    { routeKey: ROUTE_B, expiresAt: '2026-11-10T09:00:00Z', state: 'expiring', reason: 'the cqp1 qualification expires 2026-11-10T09:00:00Z' },
  ],
};
const DOCUMENT = HAND_WRITTEN as unknown as StatusExport;

describe('routing status service and views (G-24181 C0)', () => {
  it('(a) on an empty root the service returns a document with no routes, and both views say so in words', () => {
    const result = readRoutingStatus({ root, machineKey: MACHINE, now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.root).toBe(root);
    expect(result.document.schema).toBe('cse1');
    expect(result.document.schemaVersion).toBe(2);
    expect(result.document.qualifiedRoutes.routes).toEqual([]);
    expect(result.document.expiryWarnings).toEqual([]);
    expect(validateAgainstSchema(JSON.parse(JSON.stringify(result.document)), SCHEMA)).toEqual([]);

    const qualification = qualificationViewOf(result);
    expect(qualification.state).toBe('empty');
    expect(qualification.rows).toEqual([]);
    expect(qualification.message).toMatch(/No routes are known/);
    expect(qualification.message).toMatch(/nothing is safe to route/);

    const routing = routingViewOf(result);
    expect(routing.state).toBe('empty');
    expect(routing.message).toMatch(/No route is in any fallback chain/);
    expect(routing.tasks.length).toBe(8);
    for (const task of routing.tasks) {
      expect(task.tiers.length).toBe(3);
      for (const tier of task.tiers) expect(tier.emptyMessage).toMatch(/^No qualified route for /);
    }
    expect(routing.marked).toEqual([]);
  });

  it('(a) a root that cannot be read and a document that is not cse1 are each said in words, never a blank table', () => {
    const unreadable = qualificationViewOf({ ok: false, root, reason: 'permission denied' });
    expect(unreadable.state).toBe('unreadable');
    expect(unreadable.message).toContain('permission denied');
    expect(routingViewOf({ ok: false, root, reason: 'permission denied' }).message).toContain(root);
    const wrong = { ...HAND_WRITTEN, schema: 'cse9' } as unknown as StatusExport;
    expect(qualificationView(wrong).state).toBe('unreadable');
    expect(routingView(wrong).message).toMatch(/not a cse1 document/);
  });

  it('(b) Qualification lists every route with its safe-to-route state, and every expiry warning on its route', () => {
    expect(validateAgainstSchema(JSON.parse(JSON.stringify(HAND_WRITTEN)), SCHEMA)).toEqual([]);
    const view = qualificationView(DOCUMENT);
    expect(view.state).toBe('rows');
    expect(view.rows.map((row) => row.routeKey)).toEqual(DOCUMENT.qualifiedRoutes.routes.map((route) => route.routeKey));
    for (const route of DOCUMENT.qualifiedRoutes.routes) {
      const row = view.rows.find((entry) => entry.routeKey === route.routeKey);
      expect(row?.safeToRoute).toBe(route.safeToRoute);
      expect(row?.safeLabel).toBe(route.safeToRoute ? 'Safe to route' : 'Not safe to route');
    }
    expect(view.safeCount).toBe(2);
    for (const warning of DOCUMENT.expiryWarnings ?? []) {
      const row = view.rows.find((entry) => entry.routeKey === warning.routeKey);
      expect(row?.expiry).toEqual({ state: warning.state, expiresAt: warning.expiresAt, reason: warning.reason });
      expect(row?.expiryLabel).toContain(warning.expiresAt);
    }
    expect(view.expiryWarningCount).toBe(2);
    const withoutWarning = view.rows.find((row) => row.routeKey === ROUTE_C);
    expect(withoutWarning?.expiry).toBeUndefined();
    expect(withoutWarning?.expiryLabel).toBe('No expiry warning');
    // the latest verdict is the newest cqh1 entry, and a route with no history says so
    expect(view.rows.find((row) => row.routeKey === ROUTE_B)).toMatchObject({ latestVerdict: 'safeToRoute', latestVerdictAt: '2026-10-08T09:00:00Z' });
    expect(withoutWarning?.latestVerdictLabel).toBe('No qualification history yet');
  });

  it('(c) Routing lists every task type with its tiers in order, and marks every regressed or stale route', () => {
    const view = routingView(DOCUMENT);
    expect(view.state).toBe('rows');
    expect(view.tasks.map((task) => task.taskType)).toEqual(DOCUMENT.fallbackChains.tasks.map((task) => task.taskType));
    for (const task of DOCUMENT.fallbackChains.tasks) {
      const row = view.tasks.find((entry) => entry.taskType === task.taskType);
      expect(row?.tiers.map((tier) => tier.tier)).toEqual(task.tiers.map((tier) => tier.tier));
      for (const [index, tier] of task.tiers.entries()) {
        expect(row?.tiers[index].chain).toEqual(tier.chain);
        expect(row?.tiers[index].entries.map((entry) => [entry.position, entry.routeKey])).toEqual(tier.entries.map((entry) => [entry.position, entry.routeKey]));
      }
    }
    expect(view.tasks.find((task) => task.taskType === 'docs')?.tiers[2].emptyMessage).toBe('No qualified route for docs at tier3.');

    const regressedOrStale = DOCUMENT.regressions.routes.filter((route) => route.findings.length > 0).map((route) => route.routeKey).sort();
    expect(view.marked.map((mark) => mark.routeKey)).toEqual(regressedOrStale);
    expect(view.marked.find((mark) => mark.routeKey === ROUTE_A)).toMatchObject({ regressed: true, stale: false, label: 'Regressed' });
    expect(view.marked.find((mark) => mark.routeKey === ROUTE_C)).toMatchObject({ regressed: false, stale: true, label: 'Stale' });
    expect(view.marked.find((mark) => mark.routeKey === ROUTE_B)).toBeUndefined();
    expect(view.regressedCount).toBe(1);
    expect(view.staleCount).toBe(1);
    const implementTier1 = view.tasks[0].tiers[0].entries;
    expect(implementTier1.find((entry) => entry.routeKey === ROUTE_A)).toMatchObject({ regressed: true, markLabel: 'Regressed', inChain: true });
    expect(implementTier1.find((entry) => entry.routeKey === ROUTE_C)).toMatchObject({ stale: true, markLabel: 'Stale', inChain: false });
    expect(view.tasks[1].tiers[0].entries[0]).toMatchObject({ routeKey: ROUTE_B, regressed: false, stale: false });
    expect(view.tasks[1].tiers[0].entries[0].markLabel).toBeUndefined();
  });

  it('(d) the service writes nothing under the root and makes no network call or child process', () => {
    // A root with something in it: an observation that does not verify, a workspace directory that is
    // not a record, and a lease directory holding no lease.
    const machineDirectory = path.join(observationStorePath(root), 'cmk1-someone');
    fs.mkdirSync(machineDirectory, { recursive: true });
    fs.writeFileSync(path.join(machineDirectory, 'broken.json'), 'null');
    fs.mkdirSync(path.join(root, 'workspace', 'half-written'), { recursive: true });
    fs.mkdirSync(runtimeLeaseDirectory(root), { recursive: true });
    fs.writeFileSync(path.join(runtimeLeaseDirectory(root), 'notes.txt'), 'not a lease');
    const before = listing(root);

    const refuse = () => { throw new Error('the routing status service must not contact anything'); };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(refuse);
    const connectSpy = vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(refuse);
    // ChildProcess.prototype.spawn is what spawn, exec and execFile all call; it is not in the public typings.
    const spawnSpy = vi.spyOn(ChildProcess.prototype as unknown as { spawn: () => void }, 'spawn').mockImplementation(refuse);

    const result = readRoutingStatus({ root, machineKey: MACHINE, now: NOW });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(connectSpy).not.toHaveBeenCalled();
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(listing(root)).toEqual(before);

    // the corrupt file is reported in words on both screens, not hidden
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.corrupt.map((entry) => path.basename(entry.filePath))).toEqual(['broken.json']);
    const qualification = qualificationViewOf(result);
    expect(qualification.corrupt?.message).toMatch(/^1 observation file did not verify and was not read/);
    expect(qualification.corrupt?.files.map((file) => path.basename(file.filePath))).toEqual(['broken.json']);
    expect(routingViewOf(result).corrupt?.message).toMatch(/Nothing was changed/);
    // and reading a second time still changes nothing
    readRoutingStatus({ root, machineKey: MACHINE, now: NOW });
    expect(listing(root)).toEqual(before);
  });

  it('(e) the new screens are in ScreenID and SCREEN_ORDER, and the application menu is unchanged', () => {
    const added: ScreenID[] = ['qualification', 'routing'];
    for (const id of added) expect(SCREEN_ORDER).toContain(id);
    expect(SCREEN_ORDER.slice(0, 9)).toEqual(['home', 'models', 'providers', 'benchmark', 'live', 'results', 'campaigns', 'history', 'settings']);

    const navigated: ScreenID[] = [];
    const actions: MenuActions = {
      navigate: (screen) => { navigated.push(screen); }, newBenchmark: () => undefined, exportEvidence: () => undefined,
      openEvidenceFolder: () => undefined, openDataFolder: () => undefined, revealLog: () => undefined, openOllamaDownload: () => undefined,
      openReadme: () => undefined, copyDiagnostics: () => undefined, checkOllama: () => undefined, about: () => undefined,
    };
    const template = menuTemplate({ platform: 'darwin', isDev: false, productName: 'Cernum' }, actions);
    const view = template.find((item) => item.label === 'View');
    const screens = (view?.submenu as { label?: string; accelerator?: string; click?: () => void }[])
      .filter((item) => item.accelerator?.startsWith('CmdOrCtrl+') && /^CmdOrCtrl\+[0-9]$/.test(item.accelerator));
    expect(screens.map((item) => [item.label, item.accelerator])).toEqual([
      ['Home', 'CmdOrCtrl+1'], ['Models', 'CmdOrCtrl+2'], ['Providers', 'CmdOrCtrl+3'], ['Benchmark', 'CmdOrCtrl+4'],
      ['Live Run', 'CmdOrCtrl+5'], ['Results', 'CmdOrCtrl+6'], ['History', 'CmdOrCtrl+7'], ['Settings', 'CmdOrCtrl+8'],
    ]);
    for (const item of screens) item.click?.();
    expect(navigated).toEqual(['home', 'models', 'providers', 'benchmark', 'live', 'results', 'history', 'settings']);
  });
});
