// The unified route qualification read model, the spend posture, and the Ordra-facing candidate query —
// proven over REAL sealed workspace records produced by a scripted matrix (real `node` verification
// against real fixtures, no provider), plus supplied development and prose evidence.

import { afterAll, afterEach, describe, expect, it } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DiscoveryEvidence } from '../../src/engine/discovery-store';
import { SYNTHETIC_HARDWARE } from '../../src/engine/synthetic';
import { provenModel } from './frontier-harness';
import { BROKEN_SUM_MEAN, REGISTRY_ISOLATION_RECOVER, allWorkspaceCases } from '../../src/engine/workspace-catalog';
import { makeWorkspaceBenchmarkPack } from '../../src/engine/workspace-pack';
import { ScriptedAttempt, ScriptedWorkspaceAgent, WorkspaceAgentDriver, WorkspaceAgentRequest } from '../../src/engine/workspace-agent';
import { WorkspaceMatrixRequest, buildWorkspaceMatrixPlan, runWorkspaceMatrix } from '../../src/engine/workspace-matrix';
import { WorkspaceRunRow, collectWorkspaceRunRows } from '../../src/engine/workspace-aggregate';
import { registeredWorkspaceDifficultyProfiles } from '../../src/engine/workspace-difficulty-catalog';
import { DevelopmentCandidateReport } from '../../src/engine/development-report';
import { RouteQualificationRecord, deriveRouteQualification, V1_QUALIFICATION_POLICY } from '../../src/engine/route-qualification';
import { routeSpendPosture } from '../../src/engine/route-spend-posture';
import { qualifiedRouteCandidates } from '../../src/engine/routing-contract';
import { describeLocalModel, known, unknown, ModelDescription, describeDiscoveredRoute } from '../../src/engine/model-description';
import { RouteAvailabilityObservation } from '../../src/engine/machine-availability';
import { AUTHORIZED_COST_ELIGIBILITIES, BLOCKED_COST_ELIGIBILITIES } from '../../src/engine/cost-eligibility';

const FIXTURE_ROOT = path.resolve(__dirname, '../../fixtures');
const HAIKU = 'claude-haiku-4-5';
const SONNET = 'claude-sonnet-5';
const MACHINE = 'cmk1:this-machine';

const temporaries: string[] = [];
afterEach(() => { for (const directory of temporaries.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
function temporary(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaries.push(directory);
  return directory;
}
/** The sealed records are shared by every test in this file, so they outlive each test and go at the end. */
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

/** Sealed records: Haiku fixes the broken-sum case every time and never the registry one; Sonnet does nothing. */
async function sealedRecords(): Promise<{ root: string; rows: WorkspaceRunRow[] }> {
  const root = sharedTemporary('cernum-rq-root-');
  const request: WorkspaceMatrixRequest = {
    pack: makeWorkspaceBenchmarkPack({ id: 'pack.test.rq', version: '1', caseIDs: [BROKEN_SUM_MEAN.id, REGISTRY_ISOLATION_RECOVER.id], repeatsPerCase: 3 }),
    cases: allWorkspaceCases(), provider: 'claudeCLI', modelIDs: [HAIKU, SONNET], effort: 'none',
    discovery: { writtenAt: new Date().toISOString(), models: [HAIKU, SONNET].map((id) => ({ ...provenModel('claudeCLI', id), discoveredAt: new Date().toISOString() })) },
    campaignRoot: root, fixtureRoot: FIXTURE_ROOT, sandboxRoot: sharedTemporary('cernum-rq-sandbox-'), runLabel: 'rq',
    environmentSource: { PATH: process.env.PATH, HOME: '/tmp/home', USER: 'somebody' },
    driverFactory: (binding) => {
      const driver: WorkspaceAgentDriver = {
        driverID: 'driver.scripted', provider: 'claudeCLI', capabilities: new ScriptedWorkspaceAgent([]).capabilities,
        async run(agentRequest: WorkspaceAgentRequest) {
          const script = binding.requestedModelID === HAIKU && agentRequest.caseID === BROKEN_SUM_MEAN.id ? [FIXES_BROKEN_SUM] : [CHANGES_NOTHING];
          const result = await new ScriptedWorkspaceAgent(script).run(agentRequest);
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

const available = (routeKey: string): RouteAvailabilityObservation => ({
  routeKey, machineKey: MACHINE, machineLabel: 'this', observedAt: new Date().toISOString(), available: true, reason: 'signed in',
});
const proven = (id: string): DiscoveryEvidence => ({ writtenAt: new Date().toISOString(),
  models: [{ ...provenModel('claudeCLI', id), discoveredAt: new Date().toISOString() }] });

function recordFor(rows: WorkspaceRunRow[], modelID: string, extra: Partial<Parameters<typeof deriveRouteQualification>[0]> = {}) {
  return deriveRouteQualification({
    provider: 'claudeCLI', modelID, machineKey: MACHINE, now: new Date(),
    discovery: proven(modelID), availability: [available(`claudeCLI:${modelID}`)],
    workspaceRows: rows, workspaceCases: allWorkspaceCases(), difficultyProfiles: registeredWorkspaceDifficultyProfiles(),
    spend: routeSpendPosture({ provider: 'claudeCLI', modelID, now: new Date() }),
    ...extra,
  });
}

let cached: Promise<{ root: string; rows: WorkspaceRunRow[] }> | undefined;
const records = () => { cached = cached ?? sealedRecords(); return cached; };

// 32/33/34/35 ─────────────────────────────────────────────────────────────────────────────────────
describe('32–35 · one record per route, derived from evidence, capability by capability, writing nothing', () => {
  it('33 · 34 · includes workspace evidence and keeps it capability-specific — no universal score', async () => {
    const { rows } = await records();
    const record = recordFor(rows, HAIKU);
    expect(record.evidence.workspace).toMatchObject({ present: true, runCount: 6 });
    const byCase = (caseID: string) => record.capabilities.filter((entry) => entry.source === 'workspace' && entry.evidenceRefs.length === 1
      && entry.evidenceRefs[0] === caseID && !entry.capability.startsWith('workspace-tier:'));
    // The same route: qualified where it passed 3/3, NOT qualified where it passed 0/3.
    expect(byCase(BROKEN_SUM_MEAN.id).some((entry) => entry.verdict === 'qualified')).toBe(true);
    expect(byCase(REGISTRY_ISOLATION_RECOVER.id).every((entry) => entry.verdict !== 'qualified')).toBe(true);
    expect(record.routableCapabilities.length).toBeGreaterThan(0);
    expect(JSON.stringify(record)).not.toMatch(/"(overallScore|routeScore|universalScore)"/);
    expect(record.disclosure).toContain('no overall score');
    expect(record.safeToRoute).toBe(true);
    expect(record.policy).toEqual(V1_QUALIFICATION_POLICY);
  });

  it('32 · includes development evidence as its own capabilities, beside the workspace ones', async () => {
    const { rows } = await records();
    const development = { candidate: 'claude-haiku', provider: 'claudeCLI', modelID: HAIKU, effort: 'none', terminalAttempts: 6,
      statusCounts: { pass: 5, partial: 1, fail: 0, timeout: 0, unevaluable: 0 },
      roles: [{ role: 'repository reader', summary: 's', qualified: true, reason: 'answered 5/6', structuralStanding: 'measured',
        interpretation: 'This is an interpretation of the measurements, not a measurement.' },
      { role: 'multi-file editor', summary: 's', qualified: false, reason: 'not measured', structuralStanding: 'notMeasured',
        interpretation: 'This is an interpretation of the measurements, not a measurement.' }],
      eligibility: { verdict: 'measurementIncomplete', because: 'x', outstandingDimensions: [] },
    } as unknown as DevelopmentCandidateReport;
    const record = recordFor(rows, HAIKU, { developmentReports: [development] });
    expect(record.evidence.development).toMatchObject({ present: true, eligibility: 'measurementIncomplete' });
    expect(record.capabilities.find((entry) => entry.capability === 'development:repository reader')?.verdict).toBe('qualified');
    expect(record.capabilities.find((entry) => entry.capability === 'development:multi-file editor')?.verdict).toBe('notQualified');
  });

  it('57 · 58 · a subscription-CLI row is written exactly as before: no local, machine or zero-cost key appears on it', async () => {
    const { rows } = await records();
    for (const { row } of rows) {
      for (const key of ['localModelDigest', 'localRuntimeVersion', 'executionMachine', 'executionMachineLabel', 'executionPlatform',
        'zeroMarginalCostObservedAt', 'zeroMarginalCostConfirmedBy', 'commandExecutionScope']) {
        expect(Object.prototype.hasOwnProperty.call(row, key)).toBe(false);
      }
    }
  });

  it('35 · leaves historical evidence roots byte-for-byte untouched', async () => {
    const { root, rows } = await records();
    const before = digestTree(root);
    recordFor(rows, HAIKU);
    recordFor(rows, SONNET);
    expect(digestTree(root)).toBe(before);
  });
});

// 36–39 ────────────────────────────────────────────────────────────────────────────────────────────
describe('36–39 · failures, existence without qualification, unavailability and staleness stay distinct', () => {
  it('36 · preserves the last throttle and the last provider failure as their own facts', async () => {
    const { rows } = await records();
    const throttled: WorkspaceRunRow = { recordRoot: '/virtual/throttled', row: { ...rows[0].row, status: 'envelopeFailure',
      providerThrottled: true, terminationReason: 'providerDeclined', detail: 'session limit · resets 8pm', recordedAt: '2099-01-01T00:00:00Z' } };
    const broken: WorkspaceRunRow = { recordRoot: '/virtual/broken', row: { ...rows[0].row, status: 'runtimeError',
      terminationReason: 'driverUnavailable', detail: 'claude not on PATH', recordedAt: '2099-01-02T00:00:00Z' } };
    const record = recordFor([...rows, throttled, broken], HAIKU);
    expect(record.lastThrottle?.detail).toContain('session limit');
    expect(record.lastProviderFailure?.detail).toContain('not on PATH');
  });

  it('37 · a route can EXIST and not be QUALIFIED', async () => {
    const record = deriveRouteQualification({ provider: 'opencodeCLI', modelID: 'opencode/big-pickle', machineKey: MACHINE, now: new Date(),
      discovery: { writtenAt: '', models: [] }, availability: [], workspaceRows: [], workspaceCases: allWorkspaceCases() });
    expect(record.safeToRoute).toBe(false);
    expect(record.capabilities).toEqual([]);
    expect(record.blockers.find((entry) => entry.kind === 'qualification')?.reason).toContain('EXISTS and is not QUALIFIED');
  });

  it('38 · qualified but unavailable on this machine is its own refusal', async () => {
    const { rows } = await records();
    const record = recordFor(rows, HAIKU, { availability: [{ ...available(`claudeCLI:${HAIKU}`), available: false, reason: 'claude not installed here' }] });
    expect(record.capabilities.some((entry) => entry.verdict === 'qualified')).toBe(true);
    expect(record.safeToRoute).toBe(false);
    expect(record.blockers.map((entry) => entry.kind)).toEqual(['availability']);
    const elsewhere = recordFor(rows, HAIKU, { availability: [{ ...available(`claudeCLI:${HAIKU}`), machineKey: 'cmk1:another' }] });
    expect(elsewhere.availableOnThisMachine.state).toBe('neverObserved');
  });

  it('39 · a stale qualification is distinguished from a failed one', async () => {
    const { rows } = await records();
    const later = new Date(Date.now() + 40 * 24 * 60 * 60 * 1_000);
    const record = recordFor(rows, HAIKU, { now: later, availability: [{ ...available(`claudeCLI:${HAIKU}`), observedAt: later.toISOString() }],
      discovery: { writtenAt: '', models: [{ ...provenModel('claudeCLI', HAIKU), discoveredAt: later.toISOString() }] } });
    expect(record.staleness?.reasons).toContain('staleEvidenceExpired');
    expect(record.capabilities.some((entry) => entry.verdict === 'qualified')).toBe(true);
    expect(record.blockers.map((entry) => entry.kind)).toEqual(['staleness']);
  });

  // SUPERSEDED PROSPECTIVELY BY crp2 (Pass 8), AND STILL EVALUABLE. This was the unconditional rule
  // when this file was written; Pass 8 made it one of two policy VERSIONS rather than the only one.
  // The assertion is unchanged in substance — it now names the version it was always describing, so
  // that a build which routes admitted routes by default can still prove it refuses them under crp1.
  // The crp2 behaviour is asserted in `routing-policy-governance.test.ts`.
  it('keeps an identity-admitted route measured and NEVER routable under crp1, per the written approval', async () => {
    const { rows } = await records();
    const admitted = rows.map((run) => ({ ...run, row: { ...run.row, bindingIdentityState: 'requestAcceptedIdentityUnverifiable' } }));
    const record = recordFor(admitted, HAIKU, { routingPolicyVersion: 'crp1' });
    expect(record.routingPolicyVersion).toBe('crp1');
    expect(record.capabilities.some((entry) => entry.verdict === 'qualified')).toBe(true);
    expect(record.safeToRoute).toBe(false);
    expect(record.blockers.find((entry) => entry.kind === 'identity')?.reason).toContain('never a routing target');
  });
});

// 40–45 ────────────────────────────────────────────────────────────────────────────────────────────
describe('40–45 · every billing class is representable, and zero cost never overrides missing evidence', () => {
  const now = new Date('2026-09-22T12:00:00Z');
  const confirmation = { provider: 'opencodeCLI' as const, modelID: 'opencode/big-pickle', accountBasis: 'this credential',
    observedBillingRecord: 'account usage page, September statement: $0.00', observedAt: '2026-09-21T00:00:00Z', confirmedBy: 'the owner' };

  it('40 · 41 · 42 · free, subscription and local routes may be benchmarked, auto-spent and routed by default', () => {
    for (const posture of [
      routeSpendPosture({ provider: 'opencodeCLI', modelID: 'opencode/big-pickle', confirmations: [confirmation], now }),
      routeSpendPosture({ provider: 'claudeCLI', modelID: HAIKU, now }),
      routeSpendPosture({ provider: 'ollama', modelID: 'gemma3:4b', now }),
    ]) {
      expect(posture).toMatchObject({ routeExists: true, mayBenchmark: true, mayAutoSpend: true, mayRouteByDefault: true, zeroMarginalCost: true });
    }
    // An aged-out confirmation is no longer free for the purpose of spending without asking.
    const aged = routeSpendPosture({ provider: 'opencodeCLI', modelID: 'opencode/big-pickle', confirmations: [confirmation],
      now: new Date('2026-12-01T00:00:00Z') });
    expect(aged).toMatchObject({ eligibility: 'metered', mayAutoSpend: false, mayRouteByDefault: false });
  });

  it('43 · 44 · a metered route EXISTS, and is benchmarked only under an explicit override and a spending authorization', () => {
    const metered = routeSpendPosture({ provider: 'openaiAPI', modelID: 'gpt-5.6-sol', now });
    expect(metered).toMatchObject({ eligibility: 'metered', routeExists: true, mayBenchmark: false, mayAutoSpend: false,
      mayRouteByDefault: false, requiresSpendingAuthorization: true });
    const overridden = routeSpendPosture({ provider: 'openaiAPI', modelID: 'gpt-5.6-sol', now, overrides: [{ provider: 'openaiAPI',
      modelID: 'gpt-5.6-sol', overrides: 'metered', authorizedBy: 'the owner', authorizedAt: '2026-09-22', reason: 'identity ladder' }] });
    expect(overridden).toMatchObject({ mayBenchmark: true, mayAutoSpend: false, mayRouteByDefault: false, requiresSpendingAuthorization: true });
    // The existing gate is unchanged: the policy's authorized and blocked states are what they were.
    expect(AUTHORIZED_COST_ELIGIBILITIES).toEqual(['free_confirmed', 'subscription_included', 'local']);
    expect(BLOCKED_COST_ELIGIBILITIES).toEqual(['metered', 'unknown_cost']);
  });

  it('45 · zero marginal cost never overrides a missing or failed qualification, and the answer is a set, never a winner', async () => {
    const { rows } = await records();
    const haiku = recordFor(rows, HAIKU);
    const sonnet = recordFor(rows, SONNET);
    const capability = haiku.routableCapabilities.find((entry) => entry.startsWith('workspace:'))!;
    // A FREE local route with no evidence at all.
    const local = deriveRouteQualification({ provider: 'ollama', modelID: 'gemma3:4b', machineKey: MACHINE, now: new Date(),
      availability: [available('ollama:gemma3:4b')], workspaceRows: [], workspaceCases: allWorkspaceCases(),
      spend: routeSpendPosture({ provider: 'ollama', modelID: 'gemma3:4b', now: new Date() }) });
    const set = qualifiedRouteCandidates({ machineKey: MACHINE, capability, costPolicy: 'zeroMarginalCostOnly' },
      [{ record: sonnet }, { record: local }, { record: haiku }]);
    expect(set.candidates.map((candidate) => candidate.routeKey)).toEqual([`claudeCLI:${HAIKU}`]);
    expect(set.excluded.map((entry) => entry.routeKey)).toEqual(['claudeCLI:claude-sonnet-5', 'ollama:gemma3:4b']);
    expect(set.excluded.find((entry) => entry.routeKey === 'ollama:gemma3:4b')!.reasons.join(' ')).toContain('qualification');
    expect(set.ordering).toContain('NO preference within a group');
    expect(JSON.stringify(set)).not.toMatch(/"(winner|best|selected)"/);
  });

  it('refuses a context requirement on an UNKNOWN context, and honours local-only and tier', async () => {
    const { rows } = await records();
    const haiku = recordFor(rows, HAIKU);
    const capability = haiku.routableCapabilities.find((entry) => entry.startsWith('workspace:'))!;
    const withUnknown: ModelDescription = { ...describeDiscoveredRoute({ ...provenModel('claudeCLI', HAIKU), discoveredAt: new Date().toISOString() },
      { evidenceMaxAgeMilliseconds: 1 }), contextWindowTokens: unknown('no source published it') };
    const needsContext = qualifiedRouteCandidates({ machineKey: MACHINE, capability, costPolicy: 'zeroMarginalCostOnly', minimumContextTokens: 100_000 },
      [{ record: haiku, description: withUnknown }]);
    expect(needsContext.candidates).toEqual([]);
    expect(needsContext.excluded[0].reasons.join(' ')).toContain('UNKNOWN');
    const withKnown = { ...withUnknown, contextWindowTokens: known(200_000, 'fixture') };
    expect(qualifiedRouteCandidates({ machineKey: MACHINE, capability, costPolicy: 'zeroMarginalCostOnly', minimumContextTokens: 100_000 },
      [{ record: haiku, description: withKnown }]).candidates).toHaveLength(1);
    expect(qualifiedRouteCandidates({ machineKey: MACHINE, capability, costPolicy: 'zeroMarginalCostOnly', localOnly: true },
      [{ record: haiku, description: withKnown }]).excluded[0].reasons.join(' ')).toContain('local-only');
    expect(qualifiedRouteCandidates({ machineKey: MACHINE, capability, costPolicy: 'zeroMarginalCostOnly', structuralTier: 'tier3' },
      [{ record: haiku }]).excluded[0].reasons.join(' ')).toContain('tier');
  });

  it('lets a query that allows metered routes see them in their own group, flagged for authorization', async () => {
    const { rows } = await records();
    const base = recordFor(rows, HAIKU);
    const capability = base.routableCapabilities.find((entry) => entry.startsWith('workspace:'))!;
    // The same evidence, read as if this route billed per token under an explicit override.
    const meteredSpend = routeSpendPosture({ provider: 'openaiAPI', modelID: 'm', now: new Date(), overrides: [{ provider: 'openaiAPI',
      modelID: 'm', overrides: 'metered', authorizedBy: 'the owner', authorizedAt: '2026-09-22', reason: 'why' }] });
    const metered: RouteQualificationRecord = recordFor(rows, HAIKU, { spend: meteredSpend });
    expect(metered.blockers.map((entry) => entry.kind)).toEqual(['cost']);
    expect(qualifiedRouteCandidates({ machineKey: MACHINE, capability, costPolicy: 'zeroMarginalCostOnly' }, [{ record: metered }]).candidates)
      .toEqual([]);
    const allowed = qualifiedRouteCandidates({ machineKey: MACHINE, capability, costPolicy: 'allowMeteredWithAuthorization' }, [{ record: metered }]);
    expect(allowed.candidates[0]).toMatchObject({ group: 'meteredRequiresAuthorization', requiresSpendingAuthorization: true });
  });

  it('describes a local route as local in the candidate it becomes', () => {
    const description = describeLocalModel({ modelID: 'gemma3:4b', runtimeDigest: 'sha256:a', contextLengthTokens: 8_192 },
      { machine: MACHINE, observedAt: new Date().toISOString(), endpoint: 'http://127.0.0.1:11434' });
    expect(description.locality).toBe('local');
    expect(description.contextWindowTokens).toMatchObject({ state: 'known', value: 8_192 });
  });
});
