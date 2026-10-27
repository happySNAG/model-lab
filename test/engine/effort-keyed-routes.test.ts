// Effort-keyed routes (cek1): evidence gathered at an OBSERVED effort is keyed provider:model@effort,
// evidence whose effort nobody observed is keyed @unobservable:<requested>, the two are never pooled, and
// the pooled crq1 record and crc2 candidate set every existing caller reads are unchanged.
//
// The runs are REAL sealed workspace records from a scripted matrix (real `node` verification against real
// fixtures, no provider). The applied-effort fields on the keyed copies are fixture values standing in for
// what Codex telemetry writes; nothing here contacts a model.

import { afterAll, describe, expect, it } from 'vitest';
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
import { DEFAULT_QUALIFICATION_POLICY, V1_QUALIFICATION_POLICY, deriveRouteQualification } from '../../src/engine/route-qualification';
import { routeSpendPosture } from '../../src/engine/route-spend-posture';
import { ROUTING_CONTRACT_VERSION, qualifiedRouteCandidates } from '../../src/engine/routing-contract';
import { RouteAvailabilityObservation } from '../../src/engine/machine-availability';
import { deriveQualificationHistory } from '../../src/engine/qualification-history';
import { OBSERVATION_STORE_SCHEMA, ObservationStoreContents } from '../../src/engine/observation-store';
import { EFFORT_LEVELS } from '../../src/engine/provider';
import { COMMAND_SPECS } from '../../src/cli/command-spec';
import {
  EFFORT_KEYED_CANDIDATES_SCHEMA, EffortKey, EffortKeyedRecord, effortKeyedRouteCandidates, effortRouteKey, evidenceEffortOf,
  isEffortKeyedRecord, parseEffortRouteKey, routeEffortKeys, rowEffortKey, runsAtEffortKey,
} from '../../src/engine/effort-keyed-routes';

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

/** Sealed records: Haiku fixes the broken-sum case every time and never the registry one; Sonnet does nothing. */
async function sealedRecords(): Promise<WorkspaceRunRow[]> {
  const root = sharedTemporary('cernum-ek-root-');
  const request: WorkspaceMatrixRequest = {
    pack: makeWorkspaceBenchmarkPack({ id: 'pack.test.ek', version: '1', caseIDs: [BROKEN_SUM_MEAN.id, REGISTRY_ISOLATION_RECOVER.id], repeatsPerCase: 3 }),
    cases: allWorkspaceCases(), provider: 'claudeCLI', modelIDs: [HAIKU, SONNET], effort: 'none',
    discovery: { writtenAt: new Date().toISOString(), models: [HAIKU, SONNET].map((id) => ({ ...provenModel('claudeCLI', id), discoveredAt: new Date().toISOString() })) },
    campaignRoot: root, fixtureRoot: FIXTURE_ROOT, sandboxRoot: sharedTemporary('cernum-ek-sandbox-'), runLabel: 'ek',
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
  return collectWorkspaceRunRows(root);
}

let cached: Promise<WorkspaceRunRow[]> | undefined;
const sealed = () => { cached = cached ?? sealedRecords(); return cached; };

/** A copy of a run under another label, with the effort fields a driver would have written. */
function relabel(runs: WorkspaceRunRow[], label: string, fields: Record<string, unknown>): WorkspaceRunRow[] {
  return runs.map(({ recordRoot, row }) => ({ recordRoot, row: { ...row, requestedModelID: HAIKU,
    candidate: `${String(row.candidate)}#${label}`, comparabilityKey: `${String(row.comparabilityKey)}#${label}`, ...fields } }));
}

/**
 * Three experiments on ONE route, `claudeCLI:claude-haiku-4-5`:
 *   - the sealed Haiku runs as written (no telemetry, effort none): unobservable:none, passes broken-sum 3/3;
 *   - Sonnet's do-nothing runs relabelled as Haiku with telemetry that VERIFIED medium: observed medium, fails all;
 *   - the Haiku runs asked for high, telemetry unavailable: unobservable:high, passes broken-sum 3/3.
 */
async function threeExperiments(): Promise<{ original: WorkspaceRunRow[]; all: WorkspaceRunRow[] }> {
  const rows = await sealed();
  const haiku = rows.filter(({ row }) => row.requestedModelID === HAIKU);
  const sonnet = rows.filter(({ row }) => row.requestedModelID === SONNET);
  const medium = relabel(sonnet, 'medium', { effort: 'medium', requestedEffort: 'medium', appliedEffort: 'medium',
    appliedEffortVerdict: 'appliedEffortVerified', appliedEffortEvidenceSource: 'otlp:codex.sse_event.model_reasoning_effort' });
  const high = relabel(haiku, 'high', { effort: 'high', requestedEffort: 'high', appliedEffortVerdict: 'appliedEffortUnavailable' });
  return { original: haiku, all: [...haiku, ...medium, ...high] };
}

const available = (routeKey: string, now: Date): RouteAvailabilityObservation => ({
  routeKey, machineKey: MACHINE, machineLabel: 'this', observedAt: now.toISOString(), available: true, reason: 'signed in',
});
const proven = (id: string, now: Date): DiscoveryEvidence => ({ writtenAt: now.toISOString(),
  models: [{ ...provenModel('claudeCLI', id), discoveredAt: now.toISOString() }] });

function haikuRecord(rows: WorkspaceRunRow[], extra: Partial<Parameters<typeof deriveRouteQualification>[0]> = {}, now = new Date()) {
  return deriveRouteQualification({
    provider: 'claudeCLI', modelID: HAIKU, machineKey: MACHINE, now,
    discovery: proven(HAIKU, now), availability: [available(`claudeCLI:${HAIKU}`, now)],
    workspaceRows: rows, workspaceCases: allWorkspaceCases(), difficultyProfiles: registeredWorkspaceDifficultyProfiles(),
    spend: routeSpendPosture({ provider: 'claudeCLI', modelID: HAIKU, now }),
    ...extra,
  });
}

const MEDIUM: EffortKey = { state: 'observed', effort: 'medium' };
const UNOBSERVED_NONE: EffortKey = { state: 'unobservable', requestedEffort: 'none' };
const UNOBSERVED_HIGH: EffortKey = { state: 'unobservable', requestedEffort: 'high' };

describe('a row\'s effort key: observed only when telemetry measured it, never read from a name', () => {
  it('keys a verified or mismatched run at the APPLIED effort, and everything else as unobservable under its request', () => {
    expect(rowEffortKey({ effort: 'medium', requestedEffort: 'medium', appliedEffort: 'medium', appliedEffortVerdict: 'appliedEffortVerified' }).key)
      .toEqual({ state: 'observed', effort: 'medium' });
    // A mismatch is evidence at the effort the work actually ran at, not the one asked for.
    const mismatch = rowEffortKey({ effort: 'high', requestedEffort: 'high', appliedEffort: 'medium', appliedEffortVerdict: 'appliedEffortMismatch' });
    expect(mismatch.key).toEqual({ state: 'observed', effort: 'medium' });
    expect(mismatch.requestedEffort).toBe('high');
    // Telemetry that could not establish the effort is not an observation.
    for (const verdict of ['appliedEffortUnavailable', 'appliedEffortAmbiguous']) {
      expect(rowEffortKey({ effort: 'high', requestedEffort: 'high', appliedEffortVerdict: verdict }).key)
        .toEqual({ state: 'unobservable', requestedEffort: 'high' });
    }
    // An accepted request with no measurement at all (every Claude run) is not an observation either.
    const claude = rowEffortKey({ effort: 'max' });
    expect(claude.key).toEqual({ state: 'unobservable', requestedEffort: 'max' });
    expect(claude.basis).toContain('an accepted request is not an observed effort');
    // A measured value the engine does not model is refused, not mapped to a neighbour.
    expect(rowEffortKey({ effort: 'high', appliedEffort: 'turbo', appliedEffortVerdict: 'appliedEffortVerified' }).key)
      .toEqual({ state: 'unobservable', requestedEffort: 'high' });
    // A model NAME that looks like an effort says nothing about effort.
    expect(rowEffortKey({ requestedModelID: 'gpt-6-astra-high', candidate: 'codexCLI:gpt-6-astra@max' }).key)
      .toEqual({ state: 'unobservable', requestedEffort: 'unrecorded' });
  });

  it('writes provider:model@effort, with @none explicit, and @unobservable:<requested> beside it — and parses them back', () => {
    expect(effortRouteKey('codexCLI', 'gpt-6-astra', MEDIUM)).toBe('codexCLI:gpt-6-astra@medium');
    expect(effortRouteKey('ollama', 'gemma3:4b', { state: 'observed', effort: 'none' })).toBe('ollama:gemma3:4b@none');
    expect(effortRouteKey('claudeCLI', HAIKU, UNOBSERVED_HIGH)).toBe(`claudeCLI:${HAIKU}@unobservable:high`);
    expect(effortRouteKey('claudeCLI', HAIKU, { state: 'unobservable', requestedEffort: 'unrecorded' }))
      .toBe(`claudeCLI:${HAIKU}@unobservable:unrecorded`);
    expect(parseEffortRouteKey('ollama:gemma3:4b@none')).toEqual({ provider: 'ollama', modelID: 'gemma3:4b',
      routeKey: 'ollama:gemma3:4b', effortKey: { state: 'observed', effort: 'none' } });
    expect(parseEffortRouteKey(`claudeCLI:${HAIKU}@unobservable:high`).effortKey).toEqual(UNOBSERVED_HIGH);
    for (const level of EFFORT_LEVELS) {
      expect(parseEffortRouteKey(effortRouteKey('codexCLI', 'm', { state: 'observed', effort: level })).effortKey)
        .toEqual({ state: 'observed', effort: level });
    }
    for (const bad of ['codexCLI:m@turbo', 'codexCLI:m@unobservable:turbo', 'codexCLI:m', 'codexCLI:m@', '@high']) {
      expect(() => parseEffortRouteKey(bad)).toThrow();
    }
  });
});

describe('qualification per effort key', () => {
  it('finds each key a route\'s runs fall under, observed levels first, and never folds one into another', async () => {
    const { all } = await threeExperiments();
    expect(routeEffortKeys(all, 'claudeCLI', HAIKU)).toEqual([MEDIUM, UNOBSERVED_NONE, UNOBSERVED_HIGH]);
    expect(routeEffortKeys(all, 'claudeCLI', 'claude-never-run')).toEqual([]);
    for (const key of [MEDIUM, UNOBSERVED_NONE, UNOBSERVED_HIGH]) expect(runsAtEffortKey(all, 'claudeCLI', HAIKU, key)).toHaveLength(6);
  }, 120_000);

  it('derives a verdict per key, reporting the effort each record\'s evidence was gathered at', async () => {
    const { all } = await threeExperiments();
    const medium = haikuRecord(all, { effortKey: MEDIUM });
    const none = haikuRecord(all, { effortKey: UNOBSERVED_NONE });
    const high = haikuRecord(all, { effortKey: UNOBSERVED_HIGH });

    expect(medium.effort).toBe('medium');
    expect(medium.evidenceEffort).toMatchObject({ effortRouteKey: `claudeCLI:${HAIKU}@medium`, state: 'observed', effort: 'medium',
      requestedEfforts: ['medium'], runCount: 6, mismatchedRunCount: 0 });
    expect(medium.evidenceEffort!.basis[0]).toContain('appliedEffortVerified');
    expect(medium.evidence.workspace.runCount).toBe(6);
    expect(medium.safeToRoute).toBe(false);
    expect(medium.capabilities.every((entry) => entry.verdict !== 'qualified')).toBe(true);

    expect(none.effort).toBe('unobservable');
    expect(none.evidenceEffort).toMatchObject({ effortRouteKey: `claudeCLI:${HAIKU}@unobservable:none`, state: 'unobservable',
      requestedEfforts: ['none'], runCount: 6 });
    expect(none.evidenceEffort!.effort).toBeUndefined();
    expect(none.safeToRoute).toBe(true);
    expect(high.evidenceEffort).toMatchObject({ effortRouteKey: `claudeCLI:${HAIKU}@unobservable:high`, requestedEfforts: ['high'], runCount: 6 });
    expect(high.evidence.workspace.runCount).toBe(6);

    // The same capability, three verdicts: the medium key's failures did not drag the others down.
    const capability = none.routableCapabilities.find((entry) => entry.startsWith('workspace:'))!;
    const verdictOf = (record: typeof none) => record.capabilities.find((entry) => entry.capability === capability)?.verdict;
    expect([verdictOf(medium), verdictOf(none), verdictOf(high)]).toEqual(['notQualified', 'qualified', 'qualified']);
    // cqp1 decides every key; nothing about keying changes the policy.
    for (const record of [medium, none, high]) expect(record.policy).toEqual(DEFAULT_QUALIFICATION_POLICY);
    expect(DEFAULT_QUALIFICATION_POLICY).toEqual(V1_QUALIFICATION_POLICY);
    expect(V1_QUALIFICATION_POLICY.minimumSuccessRateMilli).toBe(900);
  }, 120_000);

  it('counts a mismatched run at its applied effort and says how many there were', async () => {
    const { original } = await threeExperiments();
    const mismatched = relabel(original, 'mismatch', { effort: 'high', requestedEffort: 'high', appliedEffort: 'medium',
      appliedEffortVerdict: 'appliedEffortMismatch', appliedEffortEvidenceSource: 'otlp:codex.sse_event.model_reasoning_effort' });
    expect(routeEffortKeys(mismatched, 'claudeCLI', HAIKU)).toEqual([MEDIUM]);
    const summary = evidenceEffortOf('claudeCLI', HAIKU, MEDIUM, runsAtEffortKey(mismatched, 'claudeCLI', HAIKU, MEDIUM));
    expect(summary).toMatchObject({ state: 'observed', effort: 'medium', requestedEfforts: ['high'], runCount: 6, mismatchedRunCount: 6 });
  }, 120_000);

  it('refuses an effort and an effort key together, because they select different runs', async () => {
    const { all } = await threeExperiments();
    expect(() => haikuRecord(all, { effort: 'medium', effortKey: MEDIUM })).toThrow(/not both/);
  }, 120_000);
});

describe('the pooled record and crc2 are unchanged for existing callers', () => {
  const CRQ1_KEYS = ['schema', 'routeKey', 'provider', 'modelID', 'effort', 'policy', 'qualificationScope', 'discovered',
    'availableOnThisMachine', 'identityConfidence', 'bindingIdentityStates', 'identityAdmitted', 'routingPolicyVersion', 'billing',
    'evidence', 'capabilities', 'discriminator', 'lastSuccessfulQualificationAt', 'lastProviderFailure', 'lastThrottle', 'efficiency',
    'locus', 'staleness', 'safeToRoute', 'routableCapabilities', 'notRoutableBecause', 'blockers', 'disclosure'];
  const CRC2_KEYS = ['contract', 'query', 'routingPolicyVersion', 'candidates', 'excluded', 'ordering', 'disclosure'];

  it('derives the pooled record exactly as before: no effort key, no evidenceEffort, effort any', async () => {
    const { original } = await threeExperiments();
    const now = new Date();
    const pooled = haikuRecord(original, {}, now);
    expect(Object.keys(pooled)).toEqual(CRQ1_KEYS);
    expect(pooled.effort).toBe('any');
    expect(JSON.stringify(pooled)).not.toMatch(/evidenceEffort|effortRouteKey|unobservable/);
    expect(isEffortKeyedRecord(pooled)).toBe(false);
    // A keyed record differs from the pooled one ONLY by its effort and the evidenceEffort beside it.
    const keyed = haikuRecord(original, { effortKey: UNOBSERVED_NONE }, now);
    const { evidenceEffort, effort, ...rest } = keyed;
    expect(evidenceEffort).toBeDefined();
    expect(effort).toBe('unobservable');
    const { effort: pooledEffort, ...pooledRest } = pooled;
    expect(pooledEffort).toBe('any');
    expect(JSON.stringify(rest)).toBe(JSON.stringify(pooledRest));
  }, 120_000);

  it('answers crc2 over pooled records with the crc2 shape and route keys, nothing effort-keyed in it', async () => {
    const { all } = await threeExperiments();
    const pooled = haikuRecord(all);
    const capability = haikuRecord(all, { effortKey: UNOBSERVED_NONE }).routableCapabilities.find((entry) => entry.startsWith('workspace:'))!;
    const set = qualifiedRouteCandidates({ machineKey: MACHINE, capability, costPolicy: 'zeroMarginalCostOnly' }, [{ record: pooled }]);
    expect(set.contract).toBe('crc2');
    expect(Object.keys(set)).toEqual(CRC2_KEYS);
    expect(JSON.stringify(set)).not.toMatch(/evidenceEffort|effortRouteKey|cek1/);
    // The pooled view still pools — 18 runs of three experiments under one route key. That is what --by-effort is for.
    expect(pooled.evidence.workspace.runCount).toBe(18);
  }, 120_000);
});

describe('candidates --by-effort (cek1): one answer per effort key, by the crc2 rules', () => {
  it('keeps the qualified keys, excludes the failed one with its own reasons, and reports each key\'s effort', async () => {
    const { all } = await threeExperiments();
    const records = [MEDIUM, UNOBSERVED_NONE, UNOBSERVED_HIGH].map((effortKey) => haikuRecord(all, { effortKey }))
      .filter(isEffortKeyedRecord) as EffortKeyedRecord[];
    expect(records).toHaveLength(3);
    const capability = records[1].routableCapabilities.find((entry) => entry.startsWith('workspace:'))!;
    const query = { machineKey: MACHINE, capability, costPolicy: 'zeroMarginalCostOnly' as const };
    const set = effortKeyedRouteCandidates(query, records.map((record) => ({ record })),
      [{ routeKey: 'ollama:gemma3:4b', reason: 'no sealed workspace run of this route exists at any effort' }]);

    expect(set.schema).toBe(EFFORT_KEYED_CANDIDATES_SCHEMA);
    expect(set.schema).toBe('cek1');
    expect(set.contract).toBe(ROUTING_CONTRACT_VERSION);
    expect(set.candidates.map((candidate) => candidate.effortRouteKey))
      .toEqual([`claudeCLI:${HAIKU}@unobservable:none`, `claudeCLI:${HAIKU}@unobservable:high`]);
    for (const candidate of set.candidates) {
      expect(candidate.routeKey).toBe(`claudeCLI:${HAIKU}`);
      expect(candidate.evidenceEffort.state).toBe('unobservable');
      expect(candidate.record.evidenceEffort).toEqual(candidate.evidenceEffort);
    }
    expect(set.excluded.map((entry) => entry.effortRouteKey)).toEqual([`claudeCLI:${HAIKU}@medium`]);
    expect(set.excluded[0].evidenceEffort).toMatchObject({ state: 'observed', effort: 'medium', runCount: 6 });
    expect(set.excluded[0].reasons.join(' ')).toContain(`capability: ${capability} is notQualified`);
    expect(set.unkeyed).toEqual([{ routeKey: 'ollama:gemma3:4b', reason: 'no sealed workspace run of this route exists at any effort' }]);
    expect(set.effortDisclosure).toContain('No key\'s evidence is pooled');
    expect(JSON.stringify(set)).not.toMatch(/"(winner|best|selected)"/);

    // Each key's answer is exactly what crc2 says about that key's record alone.
    for (const record of records) {
      const alone = qualifiedRouteCandidates(query, [{ record }]);
      const inKeyed = set.candidates.some((candidate) => candidate.effortRouteKey === record.evidenceEffort.effortRouteKey);
      expect(inKeyed).toBe(alone.candidates.length === 1);
    }
  }, 120_000);

  it('is an opt-in option of `candidates`, documented beside the others', () => {
    const spec = COMMAND_SPECS.find((entry) => entry.name === 'candidates')!;
    expect(spec.options.map((option) => option.name)).toContain('by-effort');
    expect(spec.options.find((option) => option.name === 'by-effort')!.takesValue).toBe(false);
    expect(fs.readFileSync(path.resolve(__dirname, '../../docs/ordra-lane/effort-keyed-routes.md'), 'utf8')).toContain('cek1');
    expect(fs.readFileSync(path.resolve(__dirname, '../../README.md'), 'utf8')).toContain('docs/ordra-lane/effort-keyed-routes.md');
  });
});

describe('qualification history per effort key', () => {
  const store: ObservationStoreContents = { schema: OBSERVATION_STORE_SCHEMA, root: '/nowhere', observations: [], corrupt: [] };

  it('re-derives each key\'s timeline from that key\'s runs alone, and names the key', async () => {
    const { all } = await threeExperiments();
    const history = (effortKey?: EffortKey) => deriveQualificationHistory({
      routeKey: `claudeCLI:${HAIKU}`, machineKey: MACHINE, contents: store, workspaceRows: all,
      workspaceCases: allWorkspaceCases(), difficultyProfiles: registeredWorkspaceDifficultyProfiles(),
      ...(effortKey === undefined ? {} : { effortKey }),
    });
    const medium = history(MEDIUM);
    const none = history(UNOBSERVED_NONE);
    const pooled = history();

    expect(medium.effort).toBe('medium');
    expect(medium.effortRouteKey).toBe(`claudeCLI:${HAIKU}@medium`);
    expect(none.effort).toBe('unobservable');
    expect(none.effortRouteKey).toBe(`claudeCLI:${HAIKU}@unobservable:none`);
    const last = (entries: typeof medium.entries) => entries[entries.length - 1];
    expect(last(medium.entries).evidenceWindow.workspaceRuns).toBe(6);
    expect(last(none.entries).evidenceWindow.workspaceRuns).toBe(6);
    expect(last(medium.entries).capabilities.every((entry) => entry.verdict !== 'qualified')).toBe(true);
    expect(last(none.entries).capabilities.some((entry) => entry.verdict === 'qualified')).toBe(true);
    for (const entry of [...medium.entries, ...none.entries]) expect(entry.policyID).toBe('cqp1');

    // The pooled history is the one it always was: no effort key on it, every run of the route in it.
    expect(pooled.effort).toBe('any');
    expect('effortRouteKey' in pooled).toBe(false);
    expect(last(pooled.entries).evidenceWindow.workspaceRuns).toBe(18);
  }, 120_000);
});
