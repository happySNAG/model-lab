// Qualification policy cqp2 (owner decision D-C5, 2026-10-25): every cqp1 requirement, the 90% threshold
// included, plus scored runs from at least 2 separate sessions or 2 separate UTC calendar days. Proven over
// REAL sealed workspace records from a scripted matrix (real `node` verification, no provider), whose rows
// are then re-dated or re-rooted in memory to place them in one or two sessions and days. cqp1 stays the
// default; cqp2 is chosen only by passing it.

import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DiscoveryEvidence } from '../../src/engine/discovery-store';
import { SYNTHETIC_HARDWARE } from '../../src/engine/synthetic';
import { provenModel } from './frontier-harness';
import { BROKEN_SUM_MEAN, allWorkspaceCases } from '../../src/engine/workspace-catalog';
import { makeWorkspaceBenchmarkPack } from '../../src/engine/workspace-pack';
import { ScriptedAttempt, ScriptedWorkspaceAgent, WorkspaceAgentDriver, WorkspaceAgentRequest } from '../../src/engine/workspace-agent';
import { WorkspaceMatrixRequest, buildWorkspaceMatrixPlan, runWorkspaceMatrix } from '../../src/engine/workspace-matrix';
import { WorkspaceRunRow, collectWorkspaceRunRows } from '../../src/engine/workspace-aggregate';
import { registeredWorkspaceDifficultyProfiles } from '../../src/engine/workspace-difficulty-catalog';
import { DevelopmentCandidateReport } from '../../src/engine/development-report';
import {
  DEFAULT_QUALIFICATION_POLICY, QUALIFICATION_POLICY_IDS, RouteQualificationRecord, V1_QUALIFICATION_POLICY, V2_QUALIFICATION_POLICY,
  deriveRouteQualification, independenceShortfall, qualificationPolicy, runIndependence,
} from '../../src/engine/route-qualification';
import { routeSpendPosture } from '../../src/engine/route-spend-posture';
import { RouteAvailabilityObservation } from '../../src/engine/machine-availability';

const FIXTURE_ROOT = path.resolve(__dirname, '../../fixtures');
const HAIKU = 'claude-haiku-4-5';
const SONNET = 'claude-sonnet-5';
const MACHINE = 'cmk1:this-machine';

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
const CHANGES_NOTHING: ScriptedAttempt = { steps: [{ do: 'say', text: 'looks fine' }], finalMessage: 'no change' };

/** One session: Haiku fixes the broken-sum case 3/3, Sonnet 0/3. Every record in one evidence root. */
async function sealedRecords(): Promise<WorkspaceRunRow[]> {
  const root = sharedTemporary('cernum-cqp2-root-');
  const request: WorkspaceMatrixRequest = {
    pack: makeWorkspaceBenchmarkPack({ id: 'pack.test.cqp2', version: '1', caseIDs: [BROKEN_SUM_MEAN.id], repeatsPerCase: 3 }),
    cases: allWorkspaceCases(), provider: 'claudeCLI', modelIDs: [HAIKU, SONNET], effort: 'none',
    discovery: { writtenAt: new Date().toISOString(), models: [HAIKU, SONNET].map((id) => ({ ...provenModel('claudeCLI', id), discoveredAt: new Date().toISOString() })) },
    campaignRoot: root, fixtureRoot: FIXTURE_ROOT, sandboxRoot: sharedTemporary('cernum-cqp2-sandbox-'), runLabel: 'cqp2',
    environmentSource: { PATH: process.env.PATH, HOME: '/tmp/home', USER: 'somebody' },
    driverFactory: (binding) => {
      const driver: WorkspaceAgentDriver = {
        driverID: 'driver.scripted', provider: 'claudeCLI', capabilities: new ScriptedWorkspaceAgent([]).capabilities,
        async run(agentRequest: WorkspaceAgentRequest) {
          const script = binding.requestedModelID === HAIKU ? [FIXES_BROKEN_SUM] : [CHANGES_NOTHING];
          const result = await new ScriptedWorkspaceAgent(script).run(agentRequest);
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

let cached: Promise<WorkspaceRunRow[]> | undefined;
const records = () => { cached = cached ?? sealedRecords(); return cached; };

const NOW = new Date('2026-10-25T12:00:00.000Z');
const available = (routeKey: string): RouteAvailabilityObservation => ({
  routeKey, machineKey: MACHINE, machineLabel: 'this', observedAt: NOW.toISOString(), available: true, reason: 'signed in',
});
const proven = (id: string): DiscoveryEvidence => ({ writtenAt: NOW.toISOString(),
  models: [{ ...provenModel('claudeCLI', id), discoveredAt: NOW.toISOString() }] });

function recordFor(rows: WorkspaceRunRow[], modelID: string, extra: Partial<Parameters<typeof deriveRouteQualification>[0]> = {}):
  RouteQualificationRecord {
  return deriveRouteQualification({
    provider: 'claudeCLI', modelID, machineKey: MACHINE, now: NOW,
    discovery: proven(modelID), availability: [available(`claudeCLI:${modelID}`)],
    workspaceRows: rows, workspaceCases: allWorkspaceCases(), difficultyProfiles: registeredWorkspaceDifficultyProfiles(),
    spend: routeSpendPosture({ provider: 'claudeCLI', modelID, now: NOW }),
    ...extra,
  });
}

/** The route's rows, re-dated in memory (index → ISO time) and optionally moved to another evidence root. */
function placed(rows: WorkspaceRunRow[], modelID: string, at: (index: number) => string,
                root: (index: number, run: WorkspaceRunRow) => string = (_index, run) => run.recordRoot,
                extra: (index: number) => Record<string, unknown> = () => ({})): WorkspaceRunRow[] {
  return rows.filter(({ row }) => row.requestedModelID === modelID)
    .map((run, index) => ({ recordRoot: root(index, run), row: { ...run.row, recordedAt: at(index), ...extra(index) } }));
}
const sameDay = (index: number) => `2026-10-24T10:0${index}:00.000Z`;
const twoDays = (index: number) => (index === 0 ? '2026-10-23T23:59:00.000Z' : `2026-10-24T00:0${index}:00.000Z`);
const otherRoot = (index: number, run: WorkspaceRunRow) => (index === 0 ? run.recordRoot
  : path.join(path.dirname(path.dirname(run.recordRoot)) + '-second-session', path.basename(path.dirname(run.recordRoot)), path.basename(run.recordRoot)));

const caseCapability = (record: RouteQualificationRecord) => record.capabilities.find((entry) => entry.source === 'workspace'
  && !entry.capability.startsWith('workspace-tier:') && entry.evidenceRefs.includes(BROKEN_SUM_MEAN.id))!;

describe('cqp2 · the policy as numbers', () => {
  it('keeps every cqp1 requirement, the 90% threshold included, and adds 2 separate sessions or UTC days', () => {
    expect(V2_QUALIFICATION_POLICY).toEqual({ ...V1_QUALIFICATION_POLICY, policyID: 'cqp2', minimumSeparateSessionsOrUtcDays: 2 });
    expect(V2_QUALIFICATION_POLICY.minimumSuccessRateMilli).toBe(900);
    expect(V2_QUALIFICATION_POLICY.minimumScoredRuns).toBe(V1_QUALIFICATION_POLICY.minimumScoredRuns);
    expect(V2_QUALIFICATION_POLICY.allowCaseNeverPassed).toBe(false);
  });

  it('leaves cqp1 readable and unchanged, and the default', () => {
    expect(V1_QUALIFICATION_POLICY).toEqual({ policyID: 'cqp1', minimumScoredRuns: 3, minimumSuccessRateMilli: 900,
      allowCaseNeverPassed: false, maximumAgeMilliseconds: 30 * 24 * 60 * 60 * 1_000 });
    expect(Object.prototype.hasOwnProperty.call(V1_QUALIFICATION_POLICY, 'minimumSeparateSessionsOrUtcDays')).toBe(false);
    expect(DEFAULT_QUALIFICATION_POLICY).toBe(V1_QUALIFICATION_POLICY);
  });

  it('is selectable explicitly by id, and an unknown id is refused rather than mapped', () => {
    expect(QUALIFICATION_POLICY_IDS).toEqual(['cqp1', 'cqp2']);
    expect(qualificationPolicy('cqp1')).toBe(V1_QUALIFICATION_POLICY);
    expect(qualificationPolicy('cqp2')).toBe(V2_QUALIFICATION_POLICY);
    expect(() => qualificationPolicy('cqp3')).toThrow(/unknown qualification policy 'cqp3'/);
  });

  it('counts sessions by sessionID or evidence root, and days by the UTC date of recordedAt', () => {
    const run = (recordRoot: string, row: Record<string, unknown>): WorkspaceRunRow => ({ recordRoot, row });
    expect(runIndependence([
      run('/a/workspace/r1', { recordedAt: '2026-10-24T23:30:00-02:00' }),
      run('/a/workspace/r2', { recordedAt: '2026-10-25T00:10:00.000Z' }),
      run('/a/workspace/r3', { recordedAt: 'not a time', sessionID: 's-1' }),
    ])).toEqual({ sessions: ['root:/a/workspace', 'session:s-1'], utcDays: ['2026-10-25'] });
    expect(independenceShortfall(V1_QUALIFICATION_POLICY, undefined)).toBeUndefined();
    expect(independenceShortfall(V2_QUALIFICATION_POLICY, { sessions: ['x'], utcDays: ['2026-10-25'] }))
      .toMatch(/cqp2 asks for scored runs from at least 2 separate sessions or UTC calendar days; these came from 1 session\(s\) on 1 UTC day\(s\)/);
    expect(independenceShortfall(V2_QUALIFICATION_POLICY, { sessions: ['x'], utcDays: ['2026-10-24', '2026-10-25'] })).toBeUndefined();
    expect(independenceShortfall(V2_QUALIFICATION_POLICY, { sessions: ['x', 'y'], utcDays: ['2026-10-25'] })).toBeUndefined();
  });
});

describe('cqp2 · over sealed workspace records', () => {
  it('without a policy argument the record is decided under cqp1, exactly as before', async () => {
    const rows = placed(await records(), HAIKU, sameDay);
    const record = recordFor(rows, HAIKU);
    expect(record.policy).toEqual(V1_QUALIFICATION_POLICY);
    expect(caseCapability(record).verdict).toBe('qualified');
    expect(record.safeToRoute).toBe(true);
  }, 120_000);

  it('a route cqp1 qualifies from one session on one day is not qualified under cqp2, with that blocker named', async () => {
    const rows = placed(await records(), HAIKU, sameDay);
    expect(recordFor(rows, HAIKU, { policy: V1_QUALIFICATION_POLICY }).safeToRoute).toBe(true);

    const record = recordFor(rows, HAIKU, { policy: V2_QUALIFICATION_POLICY });
    expect(record.policy.policyID).toBe('cqp2');
    expect(record.safeToRoute).toBe(false);
    expect(record.routableCapabilities).toEqual([]);
    expect(record.capabilities.some((entry) => entry.verdict === 'qualified')).toBe(false);
    const capability = caseCapability(record);
    expect(capability.verdict).toBe('insufficientEvidence');
    expect(capability.reason).toContain('3/3 scored runs passed');
    expect(capability.reason).toContain('cqp2 asks for scored runs from at least 2 separate sessions or UTC calendar days');
    const blocker = record.blockers.find((entry) => entry.kind === 'qualification')!;
    expect(blocker.reason).toMatch(/no capability reached cqp2: .*met every cqp1 requirement, but cqp2 asks for scored runs from at least 2 separate sessions or UTC calendar days; these came from 1 session\(s\) on 1 UTC day\(s\)/);
    expect(record.notRoutableBecause.some((reason) => reason.includes('1 session(s) on 1 UTC day(s)'))).toBe(true);
  }, 120_000);

  it('qualifies under cqp2 when the scored runs span 2 UTC calendar days in one session', async () => {
    const record = recordFor(placed(await records(), HAIKU, twoDays), HAIKU, { policy: V2_QUALIFICATION_POLICY });
    expect(caseCapability(record).verdict).toBe('qualified');
    expect(record.safeToRoute).toBe(true);
  }, 120_000);

  it('qualifies under cqp2 when the scored runs come from 2 evidence roots on one day', async () => {
    const record = recordFor(placed(await records(), HAIKU, sameDay, otherRoot), HAIKU, { policy: V2_QUALIFICATION_POLICY });
    expect(caseCapability(record).verdict).toBe('qualified');
    expect(record.safeToRoute).toBe(true);
  }, 120_000);

  it('qualifies under cqp2 when the rows name 2 separate sessions', async () => {
    const rows = placed(await records(), HAIKU, sameDay, undefined, (index) => ({ sessionID: index === 0 ? 'session-a' : 'session-b' }));
    expect(recordFor(rows, HAIKU, { policy: V2_QUALIFICATION_POLICY }).safeToRoute).toBe(true);
  }, 120_000);

  it('keeps the 90% threshold: a route that fails it is notQualified under cqp2 however many days it spans', async () => {
    const record = recordFor(placed(await records(), SONNET, twoDays), SONNET, { policy: V2_QUALIFICATION_POLICY });
    expect(caseCapability(record).verdict).toBe('notQualified');
    expect(record.safeToRoute).toBe(false);
  }, 120_000);

  it('keeps the minimum scored runs: 2 runs on 2 days are insufficientEvidence for cqp1 reasons', async () => {
    const rows = placed(await records(), HAIKU, twoDays).slice(0, 2);
    const capability = caseCapability(recordFor(rows, HAIKU, { policy: V2_QUALIFICATION_POLICY }));
    expect(capability.verdict).toBe('insufficientEvidence');
    expect(capability.reason).toContain('cqp2 asks for at least 3');
  }, 120_000);

  it('holds back a qualified development role under cqp2, since its report cannot show sessions or days', async () => {
    const development = { candidate: 'claude-haiku', provider: 'claudeCLI', modelID: HAIKU, effort: 'none', terminalAttempts: 6,
      statusCounts: { pass: 6, partial: 0, fail: 0, timeout: 0, unevaluable: 0 },
      roles: [{ role: 'repository reader', summary: 's', qualified: true, reason: 'answered 6/6', structuralStanding: 'measured',
        interpretation: 'This is an interpretation of the measurements, not a measurement.' }],
      eligibility: { verdict: 'measurementIncomplete', because: 'x', outstandingDimensions: [] },
    } as unknown as DevelopmentCandidateReport;
    const rows = placed(await records(), HAIKU, sameDay);
    const role = (policy: typeof V1_QUALIFICATION_POLICY) => recordFor(rows, HAIKU, { policy, developmentReports: [development] })
      .capabilities.find((entry) => entry.capability === 'development:repository reader')!;
    expect(role(V1_QUALIFICATION_POLICY).verdict).toBe('qualified');
    expect(role(V2_QUALIFICATION_POLICY).verdict).toBe('insufficientEvidence');
    expect(role(V2_QUALIFICATION_POLICY).reason).toContain('does not say which session or day');
  }, 120_000);
});
