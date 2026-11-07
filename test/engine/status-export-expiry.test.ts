// `cernum status-export --expiry-warnings` — cse1 version 2, which adds `expiryWarnings`: every route whose
// latest qualification verdict is safeToRoute and whose qualification expires within the qualification
// planner's renewal window (7 days), or has expired. Without the flag the document is version 1, unchanged.
//
// FIXTURES ONLY, built here. The sealed runs come from a scripted matrix (real `node` verification against
// the repository's fixtures, no provider) under a temporary root in os.tmpdir(), removed after each test; the
// engine tests re-time copies of those rows in memory at fixed instants. Hand-written cqh1 histories exercise
// the warning rule directly and are compared with the qualification planner's own output at the same
// instants. The command is spawned with --machine and --root and the network tripwire preloaded.

import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
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
  ObservationRecord, ObservationStoreContents, appendObservations, discoverySnapshotObservation, routeAvailabilityObservation,
} from '../../src/engine/observation-store';
import { QualificationHistory } from '../../src/engine/qualification-history';
import {
  QualificationPlan, RENEWAL_WINDOW_MILLISECONDS, deriveQualificationPlan, latestQualificationEvidence, qualificationExpiryState,
} from '../../src/engine/qualification-planner';
import { V1_QUALIFICATION_POLICY } from '../../src/engine/route-qualification';
import {
  STATUS_EXPORT_JSON_SCHEMA_PATH, STATUS_EXPORT_SCHEMA_VERSION, STATUS_EXPORT_SCHEMA_VERSION_EXPIRY_WARNINGS, StatusExport,
  StatusExportInputs, deriveExpiryWarnings, deriveStatusExport,
} from '../../src/engine/status-export';
import { acceptedOptions, commandSpec } from '../../src/cli/command-spec';

const REPOSITORY = path.resolve(__dirname, '../..');
const FIXTURE_ROOT = path.join(REPOSITORY, 'fixtures');
const PRELOAD = path.join(__dirname, 'fixtures', 'no-network-preload.cjs');
const SCHEMA = JSON.parse(fs.readFileSync(path.join(REPOSITORY, STATUS_EXPORT_JSON_SCHEMA_PATH), 'utf8')) as JsonSchema;
const HAIKU = 'claude-haiku-4-5';
const ROUTE = `claudeCLI:${HAIKU}`;
const MACHINE = 'cmk1:status-export-expiry-machine';

const hour = 3_600_000;
const day = 24 * hour;
const T0 = Date.parse('2026-10-01T00:00:00Z');
const iso = (milliseconds: number): string => new Date(milliseconds).toISOString().replace(/\.\d{3}Z$/, 'Z');

const temporaries: string[] = [];
afterEach(() => { for (const directory of temporaries.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
function temporary(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cernum-expiry-'));
  temporaries.push(directory);
  return directory;
}

// ------------------------------------------------------------------ fixtures, built here

const CORRECT_STATS = `'use strict';
function sum(values) { let total = 0; for (const value of values) total += value; return total; }
function mean(values) {
  if (values.length === 0) throw new RangeError('empty');
  return sum(values) / values.length;
}
module.exports = { sum, mean };
`;
const FIXES_BROKEN_SUM: ScriptedAttempt = { steps: [{ do: 'write', path: 'src/stats.js', contents: CORRECT_STATS }], finalMessage: 'fixed' };

function snapshot(at: string): DiscoverySnapshot {
  return {
    schema: 'cds1', machineKey: MACHINE, takenAt: at, providerAllowlist: 'cpa1',
    providers: [{ provider: 'claudeCLI', refreshed: true, detail: 'a fixture: no provider was contacted' }],
    routes: [{ routeKey: ROUTE, provider: 'claudeCLI', modelID: HAIKU, listed: true, availability: 'proven', observedAt: at }],
  };
}
const snapshotRecord = (at: string): ObservationRecord => discoverySnapshotObservation(snapshot(at), 'expiry-host', 'a fixture snapshot');
const availabilityRecord = (at: string): ObservationRecord =>
  routeAvailabilityObservation({ routeKey: ROUTE, machineKey: MACHINE, machineLabel: 'expiry-host', observedAt: at, available: true,
    reason: 'signed in (fixture)' }, 'claudeCLI', 'a fixture availability reading');
const storeOf = (records: ObservationRecord[]): ObservationStoreContents => ({
  schema: 'cos1', root: '/virtual/.observations', corrupt: [],
  observations: records.map((record) => ({ record, origin: 'observedHere', receivedAt: record.observedAt })),
});

/** A campaign root under a fresh temporary directory: an observation store and three passing sealed runs of Haiku. */
async function sealedRoot(): Promise<{ root: string; rows: WorkspaceRunRow[] }> {
  const base = temporary();
  const root = path.join(base, 'campaign');
  const sandboxRoot = path.join(base, 'sandbox');
  fs.mkdirSync(root);
  fs.mkdirSync(sandboxRoot);
  const observedAt = iso(Date.now() - 60_000);
  appendObservations(root, [snapshotRecord(observedAt), availabilityRecord(observedAt)], { origin: 'observedHere', receivedAt: observedAt });
  const request: WorkspaceMatrixRequest = {
    pack: makeWorkspaceBenchmarkPack({ id: 'pack.test.status-export-expiry', version: '1', caseIDs: [BROKEN_SUM_MEAN.id], repeatsPerCase: 3 }),
    cases: allWorkspaceCases(), provider: 'claudeCLI', modelIDs: [HAIKU], effort: 'none',
    discovery: { writtenAt: new Date().toISOString(), models: [{ ...provenModel('claudeCLI', HAIKU), discoveredAt: new Date().toISOString() }] },
    campaignRoot: root, fixtureRoot: FIXTURE_ROOT, sandboxRoot, runLabel: 'status-export-expiry',
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

/** Six passing copies of a sealed run, an hour apart from T0 + 1 h: the newest evidence is at T0 + 6 h. */
function retimed(rows: WorkspaceRunRow[]): WorkspaceRunRow[] {
  const template = rows.find((run) => run.row.status === 'pass')!;
  return [0, 1, 2, 3, 4, 5].map((index) => ({
    recordRoot: `${template.recordRoot}#copy-${index}`,
    row: { ...template.row, recordedAt: iso(T0 + (index + 1) * hour), repeatIndex: index, status: 'pass',
      wallClockMilliseconds: 1_000, totalTokens: 5_000 },
  }));
}

function inputsAt(rows: WorkspaceRunRow[], now: number, over: Partial<StatusExportInputs> = {}): StatusExportInputs {
  return {
    machineKey: MACHINE, contents: storeOf([snapshotRecord(iso(T0)), availabilityRecord(iso(T0))]), workspaceRows: rows,
    workspaceCases: allWorkspaceCases(), difficultyProfiles: registeredWorkspaceDifficultyProfiles(),
    spendFor: ({ provider, modelID }, at) => routeSpendPosture({ provider, modelID, now: at }),
    now: new Date(now), ...over,
  };
}

/** A one-entry cqh1 history, written by hand. */
function history(routeKey: string, verdict: 'safeToRoute' | 'notRoutable', evidenceTo: string): QualificationHistory {
  const at = routeKey.indexOf(':');
  return {
    schema: 'cqh1', routeKey, provider: routeKey.slice(0, at) as QualificationHistory['provider'], modelID: routeKey.slice(at + 1),
    effort: 'any', machineKey: MACHINE,
    entries: [{
      recordedAt: evidenceTo, policyID: 'cqp1', routingPolicyVersion: 'crp2', verdict, routableCapabilities: [], capabilities: [],
      blockers: [], evidenceWindow: { from: evidenceTo, to: evidenceTo, workspaceRuns: 3, observations: 1 },
      triggeredBy: [], stalenessRecorded: [], changed: true,
    }],
    undatedWorkspaceRuns: [], corrupt: [], disclosure: 'fixture history',
  };
}

/** The planner's renewal triggers, by route, from both its requests and its skips. */
function renewalsOf(plan: QualificationPlan): Map<string, { detail: string; qualificationExpiresAt?: string }> {
  const found = new Map<string, { detail: string; qualificationExpiresAt?: string }>();
  for (const request of plan.requests) {
    if (request.trigger.kind === 'renewal') {
      found.set(request.routeKey, { detail: request.trigger.detail.join(' '),
        ...(request.qualificationExpiresAt === undefined ? {} : { qualificationExpiresAt: request.qualificationExpiresAt }) });
    }
  }
  for (const skip of plan.skipped) {
    if (skip.trigger?.kind === 'renewal' && !found.has(skip.routeKey)) found.set(skip.routeKey, { detail: skip.trigger.detail.join(' ') });
  }
  return found;
}
const planAt = (histories: QualificationHistory[], now: number): QualificationPlan => deriveQualificationPlan({
  now: new Date(now), machineKey: MACHINE, histories,
  ledger: { records: [], corrupt: [], budget: 100, used: 0, ledgerDigest: 'fixture' },
});

// ------------------------------------------------------------------ the document, at fixed instants

describe('status-export --expiry-warnings: cse1 version 2, at fixed instants around the expiry', () => {
  it('warns 6 days and 1 day before expiry (expiring) and 1 day after (expired), not 8 days before; validates; version 1 unchanged', async () => {
    const { rows } = await sealedRoot();
    const workspaceRows = retimed(rows);

    // The expiry the planner computes, from the export's own history of the route.
    const baseline = deriveStatusExport(inputsAt(workspaceRows, T0 + 7 * hour, { expiryWarnings: true }));
    const routeHistory = baseline.recentQualificationResults.routes.find((route) => route.routeKey === ROUTE)!;
    expect(routeHistory.entries[routeHistory.entries.length - 1].verdict).toBe('safeToRoute');
    const evidence = latestQualificationEvidence({ ...history(ROUTE, 'safeToRoute', iso(T0)), entries: routeHistory.entries },
      V1_QUALIFICATION_POLICY)!;
    expect(evidence.safe).toBe(true);
    expect(evidence.evidenceTo).toBe(T0 + 6 * hour);
    const expiry = evidence.expiresAt;
    expect(expiry).toBe(T0 + 6 * hour + V1_QUALIFICATION_POLICY.maximumAgeMilliseconds);
    expect(RENEWAL_WINDOW_MILLISECONDS).toBe(7 * day);

    const cases: { label: string; now: number; state?: 'expiring' | 'expired' }[] = [
      { label: '8 days before', now: expiry - 8 * day },
      { label: '6 days before', now: expiry - 6 * day, state: 'expiring' },
      { label: '1 day before', now: expiry - 1 * day, state: 'expiring' },
      { label: '1 day after', now: expiry + 1 * day, state: 'expired' },
    ];
    for (const { label, now, state } of cases) {
      const v2 = deriveStatusExport(inputsAt(workspaceRows, now, { expiryWarnings: true }));
      expect(v2.schemaVersion, label).toBe(STATUS_EXPORT_SCHEMA_VERSION_EXPIRY_WARNINGS);
      expect(v2.schemaVersion, label).toBe(2);
      expect(validateAgainstSchema(JSON.parse(JSON.stringify(v2)), SCHEMA), label).toEqual([]);
      // expiryWarnings is the last key; every other key is version 1's, in version 1's order.
      expect(Object.keys(v2), label).toEqual([...Object.keys(deriveStatusExport(inputsAt(workspaceRows, now))), 'expiryWarnings']);
      if (state === undefined) {
        expect(v2.expiryWarnings, label).toEqual([]);
      } else {
        expect(v2.expiryWarnings, label).toHaveLength(1);
        const [warning] = v2.expiryWarnings!;
        expect(warning, label).toEqual({ routeKey: ROUTE, expiresAt: iso(expiry), state, reason: expect.any(String) });
        expect(Object.keys(warning).sort(), label).toEqual(['expiresAt', 'reason', 'routeKey', 'state']);
        expect(warning.reason, label).toContain(iso(expiry));
        expect(warning.reason, label).toContain('cqp1');
        expect(warning.reason, label).toContain(state === 'expired' ? 'expired' : 'expires');
      }

      // Version 1 at the same instant: no expiryWarnings, the schema's required keys exactly, and byte-identical
      // to the version 2 document with the added field taken out and the version put back.
      const v1 = deriveStatusExport(inputsAt(workspaceRows, now));
      expect(v1.schemaVersion, label).toBe(STATUS_EXPORT_SCHEMA_VERSION);
      expect(v1.schemaVersion, label).toBe(1);
      expect('expiryWarnings' in v1, label).toBe(false);
      expect(Object.keys(v1).sort(), label).toEqual([...(SCHEMA.required as string[])].sort());
      expect(validateAgainstSchema(JSON.parse(JSON.stringify(v1)), SCHEMA), label).toEqual([]);
      expect(JSON.stringify(deriveStatusExport(inputsAt(workspaceRows, now, { expiryWarnings: false })))).toBe(JSON.stringify(v1));
      const { expiryWarnings: _added, ...rest } = v2;
      expect(JSON.stringify({ ...rest, schemaVersion: 1 })).toBe(JSON.stringify(v1));

      // The planner, at the same instant over the same history, plans a renewal exactly when a warning is given,
      // naming the same expiry.
      const renewal = renewalsOf(planAt([{ ...history(ROUTE, 'safeToRoute', iso(T0)), entries: routeHistory.entries }], now)).get(ROUTE);
      if (state === undefined) {
        expect(renewal, label).toBeUndefined();
      } else {
        expect(renewal?.detail, label).toContain(`${state === 'expired' ? 'expired' : 'expires'} ${iso(expiry)}`);
        if (renewal?.qualificationExpiresAt !== undefined) expect(renewal.qualificationExpiresAt).toBe(iso(expiry));
      }
    }
  }, 240_000);

  it('the schema still refuses what is not this document, in both versions', () => {
    const base = { routeKey: ROUTE, expiresAt: '2026-11-01T00:00:00Z', state: 'expiring', reason: 'a reason' };
    const property = (SCHEMA.properties as Record<string, JsonSchema>).expiryWarnings;
    expect(validateAgainstSchema([base], { ...property, $defs: SCHEMA.$defs })).toEqual([]);
    expect(validateAgainstSchema([{ ...base, surprise: 1 }], { ...property, $defs: SCHEMA.$defs })).toEqual(["$[0]: 'surprise' is not allowed"]);
    expect(validateAgainstSchema([{ ...base, state: 'current' }], { ...property, $defs: SCHEMA.$defs })).not.toEqual([]);
    const { reason: _dropped, ...withoutReason } = base;
    expect(validateAgainstSchema([withoutReason], { ...property, $defs: SCHEMA.$defs })).not.toEqual([]);
    expect((SCHEMA.properties as Record<string, JsonSchema>).schemaVersion).toEqual({ enum: [1, 2] });
    expect(SCHEMA.required as string[]).not.toContain('expiryWarnings');
    expect(SCHEMA.$id).toBe('cernum:status-export:cse1:1');
  });
});

// ------------------------------------------------------------------ the rule, over hand-written histories

describe('deriveExpiryWarnings: the planner\'s rule, called and not copied', () => {
  const EXPIRY_OF = (evidenceTo: string) => Date.parse(evidenceTo) + V1_QUALIFICATION_POLICY.maximumAgeMilliseconds;

  it('agrees with the planner at 8, 6 and 1 days before and 1 day after expiry, and at the window\'s edge', () => {
    const evidenceTo = '2026-10-03T00:00:00Z';
    const expiry = EXPIRY_OF(evidenceTo);
    const histories = [history(ROUTE, 'safeToRoute', evidenceTo)];
    const expected: [number, 'current' | 'expiring' | 'expired'][] = [
      [expiry - 8 * day, 'current'], [expiry - 7 * day - 1_000, 'current'], [expiry - 7 * day, 'expiring'],
      [expiry - 6 * day, 'expiring'], [expiry - 1 * day, 'expiring'], [expiry, 'expired'], [expiry + 1 * day, 'expired'],
    ];
    for (const [now, state] of expected) {
      expect(qualificationExpiryState(expiry, now), iso(now)).toBe(state);
      const warnings = deriveExpiryWarnings(histories, V1_QUALIFICATION_POLICY, new Date(now));
      const renewal = renewalsOf(planAt(histories, now)).get(ROUTE);
      if (state === 'current') {
        expect(warnings, iso(now)).toEqual([]);
        expect(renewal, iso(now)).toBeUndefined();
      } else {
        expect(warnings, iso(now)).toEqual([{ routeKey: ROUTE, expiresAt: iso(expiry), state, reason: expect.any(String) }]);
        expect(renewal?.detail, iso(now)).toContain(`${state === 'expired' ? 'expired' : 'expires'} ${iso(expiry)}`);
      }
    }
  });

  it('gives no entry to a route whose latest verdict is not safe or that has no entry, and sorts by expiresAt then routeKey', () => {
    const now = new Date('2026-10-30T00:00:00Z');
    const histories = [
      history('zeta:late', 'safeToRoute', '2026-10-05T00:00:00Z'),
      history('beta:same', 'safeToRoute', '2026-09-25T00:00:00Z'),
      history('alpha:same', 'safeToRoute', '2026-09-25T00:00:00Z'),
      history('gamma:unsafe', 'notRoutable', '2026-09-25T00:00:00Z'),
      history('delta:current', 'safeToRoute', '2026-10-29T00:00:00Z'),
      { ...history('epsilon:empty', 'safeToRoute', '2026-09-25T00:00:00Z'), entries: [] },
    ];
    const warnings = deriveExpiryWarnings(histories, V1_QUALIFICATION_POLICY, now);
    expect(warnings.map((warning) => [warning.routeKey, warning.state, warning.expiresAt])).toEqual([
      ['alpha:same', 'expired', '2026-10-25T00:00:00Z'],
      ['beta:same', 'expired', '2026-10-25T00:00:00Z'],
      ['zeta:late', 'expiring', '2026-11-04T00:00:00Z'],
    ]);
    // The planner plans renewals for exactly the same routes.
    expect([...renewalsOf(planAt(histories, now.getTime())).keys()].sort()).toEqual(['alpha:same', 'beta:same', 'zeta:late']);
  });
});

// ------------------------------------------------------------------ the command, in a subprocess

function cernum(networkLog: string, ...args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(path.join(REPOSITORY, 'node_modules', '.bin', 'tsx'), ['src/cli/cernum.ts', ...args], {
      cwd: REPOSITORY,
      env: { ...process.env, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
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

describe('cernum status-export --expiry-warnings', () => {
  it('is a declared boolean option, documented in the help and the feature page', () => {
    const option = acceptedOptions(commandSpec('status-export')!).find((entry) => entry.name === 'expiry-warnings');
    expect(option).toMatchObject({ name: 'expiry-warnings', takesValue: false });
    expect((commandSpec('status-export')!.detail ?? []).join(' ')).toContain('--expiry-warnings');
    const documented = fs.readFileSync(path.join(REPOSITORY, 'docs/ordra-lane/status-export.md'), 'utf8');
    for (const phrase of ['--expiry-warnings', 'version 2', '`expiryWarnings`', 'RENEWAL_WINDOW_MILLISECONDS']) expect(documented).toContain(phrase);
  });

  it('--expiry-warnings --json emits version 2 with expiryWarnings; without it, version 1 without the field; both validate', async () => {
    const { root } = await sealedRoot();
    const networkLog = path.join(temporary(), 'network.log');
    const withWarnings = await cernum(networkLog, 'status-export', '--expiry-warnings', '--json', '--machine', MACHINE, '--root', root);
    expect(withWarnings.stderr).toBe('');
    expect(withWarnings.status).toBe(0);
    const v2 = JSON.parse(withWarnings.stdout) as StatusExport;
    expect(validateAgainstSchema(v2, SCHEMA)).toEqual([]);
    expect(v2.schemaVersion).toBe(2);
    // Runs sealed moments ago are 30 days from expiry: nothing is due.
    expect(v2.expiryWarnings).toEqual([]);
    expect(Object.keys(v2)[Object.keys(v2).length - 1]).toBe('expiryWarnings');

    const without = await cernum(networkLog, 'status-export', '--json', '--machine', MACHINE, '--root', root);
    expect(without.status).toBe(0);
    const v1 = JSON.parse(without.stdout) as StatusExport;
    expect(validateAgainstSchema(v1, SCHEMA)).toEqual([]);
    expect(v1.schemaVersion).toBe(1);
    expect('expiryWarnings' in v1).toBe(false);
    expect(Object.keys(v1).sort()).toEqual([...(SCHEMA.required as string[])].sort());
    const { expiryWarnings: _added, ...rest } = v2;
    expect(Object.keys(rest)).toEqual(Object.keys(v1));

    const summary = await cernum(networkLog, 'status-export', '--expiry-warnings', '--machine', MACHINE, '--root', root);
    expect(summary.status).toBe(0);
    expect(summary.stdout).toContain('Status export cse1 v2');
    expect(summary.stdout).toContain('expiry warnings     0');
  }, 240_000);
});
