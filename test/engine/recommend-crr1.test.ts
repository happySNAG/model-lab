// The advisory per-task recommendation (crr1): an Ordra task type mapped through ctt1 to a crc2 query, only
// qualified, unexpired, identity-proven and compatible routes ranked — reliability first, then zero marginal
// cost, then p90 latency (owner decision D-C6) — every excluded route with its reasons, the cfc1 fallback
// order beside it, and a reasons array. Never a selection, never a write, never a launch.
//
// FIXTURES ONLY. Records and run rows are hand-written; the command runs in a subprocess against a temporary
// root holding one fixture availability observation. No driver runs and no provider is contacted.

import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  RECOMMENDATION_IS_ADVISORY, RECOMMENDATION_ORDERING_RULE, ROUTE_RECOMMENDATION_RULE_VERSION, RecommendationEvidence,
  RouteRecommendation, RouteRecommendationRefusal, compareRecommendationEvidence, recommendRoutes,
} from '../../src/engine/route-recommendation';
import { FALLBACK_ORDERING_RULE, deriveFallbackChain } from '../../src/engine/fallback-chain';
import { RouteAvailabilitySource, RouteForQuery, qualifiedRouteCandidates } from '../../src/engine/routing-contract';
import { CapabilityQualification, RouteQualificationRecord, V1_QUALIFICATION_POLICY } from '../../src/engine/route-qualification';
import { routeSpendPosture } from '../../src/engine/route-spend-posture';
import { measuredQuantity, unavailableQuantity } from '../../src/engine/frontier-metrics';
import { deriveMetricsRollup } from '../../src/engine/metrics-rollup';
import { ModelDescription, known, unknown } from '../../src/engine/model-description';
import { WorkspaceCase } from '../../src/engine/workspace-case';
import { appendObservations, routeAvailabilityObservation } from '../../src/engine/observation-store';
import { ProviderID } from '../../src/engine/provider';
import { acceptedOptions, commandSpec } from '../../src/cli/command-spec';

const REPOSITORY = path.resolve(__dirname, '../..');
const NOW = new Date('2026-10-26T12:00:00Z');
const HERE = 'cmk1:recommend-machine';
// ctt1: implement → workspace:multiFileEditing.
const CAPABILITY = 'workspace:multiFileEditing';
const TIER = 'workspace-tier:tier2';
const hoursAgo = (hours: number): string => new Date(NOW.getTime() - hours * 3_600_000).toISOString();

const GEMMA = 'ollama:gemma3:4b';
const QWEN = 'ollama:qwen3:8b';
const HAIKU = 'claudeCLI:claude-haiku-4-5';
const SONNET = 'claudeCLI:claude-sonnet-4-5';
const CODEX = 'codexCLI:gpt-5-codex';
const PICKLE = 'opencodeCLI:opencode/big-pickle';

const temporaries: string[] = [];
afterEach(() => { for (const directory of temporaries.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
function temporary(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cernum-recommend-'));
  temporaries.push(directory);
  return directory;
}

const qualified = (capability: string): CapabilityQualification => ({
  capability, source: 'workspace', verdict: 'qualified', scoredRunCount: 3, successCount: 3,
  successRateMilli: measuredQuantity(1000), evidenceRefs: ['case-a'], reason: '3/3 scored runs passed (≥ 90%)',
});

function record(routeKey: string, over: Partial<RouteQualificationRecord> = {}): RouteQualificationRecord {
  const at = routeKey.indexOf(':');
  const provider = routeKey.slice(0, at) as ProviderID;
  const modelID = routeKey.slice(at + 1);
  return {
    schema: 'crq1', routeKey, provider, modelID, effort: 'any', policy: V1_QUALIFICATION_POLICY,
    qualificationScope: provider === 'ollama' ? 'machine' : 'route',
    locus: provider === 'ollama' ? { machineKey: HERE } : undefined,
    discovered: { state: 'currentlyDiscovered', reason: 'observed just now' },
    availableOnThisMachine: { state: 'available', reason: 'installed and signed in' },
    identityConfidence: provider === 'ollama' ? 'verifiedByLocalDigest' : 'verifiedByProvider',
    bindingIdentityStates: ['verified'], identityAdmitted: false, routingPolicyVersion: 'crp2',
    billing: routeSpendPosture({ provider, modelID, now: NOW }),
    evidence: {
      prose: { present: false, candidates: [] }, development: { present: false, candidates: [] },
      workspace: { present: true, runCount: 3, scoredRunCount: 3, packs: ['p'], recordRoots: [] },
    },
    capabilities: [qualified(CAPABILITY), qualified(TIER)],
    discriminator: [],
    lastSuccessfulQualificationAt: hoursAgo(24),
    efficiency: { medianWallClockMilliseconds: measuredQuantity(1000), medianTotalTokens: measuredQuantity(100), basis: 'medians' },
    staleness: { valid: true, reasons: ['qualificationStillValid'], detail: ['nothing moved'] },
    safeToRoute: true, routableCapabilities: [CAPABILITY, TIER], notRoutableBecause: [], blockers: [],
    disclosure: 'no universal score',
    ...over,
  };
}

const available = (): RouteAvailabilitySource => ({
  state: 'available', observedOnMachine: HERE, machineLabel: 'fixture-host', origin: 'observedHere',
  observedAt: hoursAgo(1), reason: 'installed and signed in',
});

const describedWith = (contextWindowTokens: ModelDescription['contextWindowTokens']): ModelDescription =>
  ({ contextWindowTokens, locality: 'remote' }) as unknown as ModelDescription;
const WIDE = describedWith(known(200_000, 'fixture catalogue'));

/** Three qualified, identity-proven, unexpired routes with a wide context window. */
function fleet(over: Record<string, Partial<RouteQualificationRecord>> = {}): RouteForQuery[] {
  return [GEMMA, HAIKU, QWEN].map((routeKey) => ({ record: record(routeKey, over[routeKey]), description: WIDE, availability: available() }));
}

/** Rollup rows: QWEN passed 3/3 slowly, HAIKU 2/3 quickly, GEMMA 3/3 at a middling pace. */
const CASES = [{ id: 'case-a', dimensions: ['multiFileEditing'] }] as unknown as WorkspaceCase[];
function rows(routeKey: string, statuses: string[], wallClock: number[]): { recordRoot: string; row: Record<string, unknown> }[] {
  const at = routeKey.indexOf(':');
  return statuses.map((status, index) => ({
    recordRoot: `/fixture/${routeKey}/${index}`,
    row: { provider: routeKey.slice(0, at), requestedModelID: routeKey.slice(at + 1), caseID: 'case-a', status,
      wallClockMilliseconds: wallClock[index], recordedAt: hoursAgo(30 - index) },
  }));
}
const METRICS = deriveMetricsRollup({
  workspaceRows: [
    ...rows(QWEN, ['pass', 'pass', 'pass'], [9000, 9000, 9000]),
    ...rows(HAIKU, ['pass', 'fail', 'pass'], [100, 100, 100]),
    ...rows(GEMMA, ['pass', 'pass', 'pass'], [5000, 5000, 5000]),
  ],
  workspaceCases: CASES,
});

const REQUEST = { machineKey: HERE, taskType: 'implement', tier: 2, contextTokens: 32_000 };

function recommend(routes: RouteForQuery[], over: Partial<typeof REQUEST> = {}, metrics = METRICS): RouteRecommendation {
  const answer = recommendRoutes({ ...REQUEST, ...over }, { now: NOW, routes, metrics });
  if (!answer.ok) throw new Error(`refused: ${answer.refusals.join('; ')}`);
  return answer;
}
const reasonsFor = (answer: RouteRecommendation, routeKey: string): string =>
  answer.excluded.find((entry) => entry.routeKey === routeKey)?.reasons.join(' | ') ?? '';

// ------------------------------------------------------------------ the task, through ctt1

describe('crr1 · the task goes through ctt1 to a crc2 query', () => {
  it('names its versions, its rule and its query on every answer', () => {
    expect(ROUTE_RECOMMENDATION_RULE_VERSION).toBe('crr1');
    const answer = recommend(fleet());
    expect(answer).toMatchObject({ schema: 'crr1', ok: true, taxonomyVersion: 'ctt1', contract: 'crc2', routingPolicyVersion: 'crp2',
      metricsSchema: 'cmr1', answeredAt: NOW.toISOString(), orderingRule: RECOMMENDATION_ORDERING_RULE });
    expect(answer.query).toMatchObject({ machineKey: HERE, capability: CAPABILITY, structuralTier: 'tier2', minimumContextTokens: 32_000,
      costPolicy: 'zeroMarginalCostOnly', requireVerifiedIdentity: true, requireFreshQualification: true });
    expect(answer.task).toMatchObject({ taskType: 'implement', tier: 'tier2', contextTokens: 32_000, row: { dimension: 'multiFileEditing' } });
    expect(answer.reasons[0]).toContain(`task 'implement' maps by task taxonomy ctt1 to ${CAPABILITY} at tier2`);
  });

  it('requires no tier or context it was not given, and says so rather than defaulting one', () => {
    const answer = recommend(fleet(), { tier: undefined, contextTokens: undefined });
    expect(answer.query.structuralTier).toBeUndefined();
    expect(answer.query.minimumContextTokens).toBeUndefined();
    expect(answer.task.tier).toBeUndefined();
    expect(answer.reasons[0]).toContain('no structural tier required (none was asked)');
    expect(answer.reasons[0]).toContain('no context requirement (none was asked)');
  });

  it('refuses an unknown task type, tier or context with every reason, and ranks nothing', () => {
    const refused = recommendRoutes({ machineKey: HERE, taskType: 'deploy', tier: 7, contextTokens: 'lots' },
      { now: NOW, routes: fleet(), metrics: METRICS }) as RouteRecommendationRefusal;
    expect(refused).toMatchObject({ schema: 'crr1', ok: false, taxonomyVersion: 'ctt1', isSelection: false, launches: false });
    expect(refused.refusals).toHaveLength(3);
    expect(refused.refusals.join(' ')).toContain("task type 'deploy' is not in task taxonomy ctt1");
    expect(Object.keys(refused)).not.toContain('ranking');
  });
});

// ------------------------------------------------------------------ the order

describe('crr1 · reliability first, then zero marginal cost, then latency (D-C6)', () => {
  it('ranks by task-category success rate first, however fast a less reliable route is', () => {
    const answer = recommend(fleet());
    // QWEN and GEMMA both passed 3/3; GEMMA's p90 is lower, so it leads. HAIKU is fastest and passed 2/3: last.
    expect(answer.order).toEqual([GEMMA, QWEN, HAIKU]);
    expect(answer.ranking.map((entry) => entry.rank)).toEqual([1, 2, 3]);
    expect(answer.ranking[0]!.rankedBy).toMatchObject({ successRateMilli: measuredQuantity(1000), scoredRunCount: 3, passCount: 3,
      group: 'zeroMarginalCost' });
    expect(answer.ranking[2]!.rankedBy.successRateMilli).toEqual(measuredQuantity(667));
    expect(answer.ranking[0]!.reasons).toContain(`ranked above ${QWEN} on latency: equal reliability and cost, p90 wall clock 5000 ms against 9000 ms`);
    expect(answer.ranking[1]!.reasons).toContain(`ranked above ${HAIKU} on reliability: 1000‰ against 667‰`);
    expect(answer.reasons).toContain(`${GEMMA} ranks first: reliability: 3/3 scored runs passed for ${CAPABILITY} (1000‰, metrics rollup cmr1)`);
  });

  it('puts zero marginal cost before metered only when reliability ties, and latency only after both', () => {
    const evidence = (successRate: number | undefined, group: RecommendationEvidence['group'], p90: number | undefined): RecommendationEvidence => ({
      successRateMilli: successRate === undefined ? unavailableQuantity('none') : measuredQuantity(successRate), group,
      p90WallClockMilliseconds: p90 === undefined ? unavailableQuantity('none') : measuredQuantity(p90),
    });
    const order = (entries: [string, RecommendationEvidence][]): string[] =>
      entries.map(([routeKey, rankedBy]) => ({ routeKey, rankedBy })).sort(compareRecommendationEvidence).map((entry) => entry.routeKey);
    // A more reliable metered route ranks above a less reliable free one: reliability is the first step.
    expect(order([['free', evidence(900, 'zeroMarginalCost', 10)], ['metered', evidence(950, 'meteredRequiresAuthorization', 9999)]]))
      .toEqual(['metered', 'free']);
    // Equal reliability: zero marginal cost first, however slow.
    expect(order([['metered', evidence(950, 'meteredRequiresAuthorization', 10)], ['free', evidence(950, 'zeroMarginalCost', 9999)]]))
      .toEqual(['free', 'metered']);
    // Equal reliability and cost: the lower p90; an unknown p90 after a known one; then route key.
    expect(order([['c', evidence(950, 'zeroMarginalCost', undefined)], ['b', evidence(950, 'zeroMarginalCost', 20)],
      ['a', evidence(950, 'zeroMarginalCost', 20)], ['d', evidence(950, 'zeroMarginalCost', 10)]])).toEqual(['d', 'a', 'b', 'c']);
  });

  it('ranks a route whose reliability is unknown last, and says so', () => {
    const onlySome = deriveMetricsRollup({ workspaceRows: rows(HAIKU, ['pass', 'fail', 'fail'], [1, 1, 1]), workspaceCases: CASES });
    const answer = recommend(fleet(), {}, onlySome);
    // HAIKU passed only 1/3, and still ranks above routes with no known rate at all.
    expect(answer.order).toEqual([HAIKU, GEMMA, QWEN]);
    const gemma = answer.ranking.find((entry) => entry.routeKey === GEMMA)!;
    expect(gemma.reliabilityUnknown).toBe(true);
    expect(gemma.reasons[0]).toContain(`reliability: UNKNOWN for ${CAPABILITY}`);
    expect(gemma.reasons[0]).toContain('an unknown rate ranks after every known one');
    expect(answer.reasons).toContain(`reliability is unknown for ${GEMMA}, ${QWEN}, so they rank after every route whose success rate is known`);

    const none = recommendRoutes(REQUEST, { now: NOW, routes: fleet() }) as RouteRecommendation;
    expect(none.metricsSchema).toBeUndefined();
    expect(none.ranking.every((entry) => entry.reliabilityUnknown)).toBe(true);
    // Every step ties, so the route key alone decides — and the reasons say that is all that did.
    expect(none.order).toEqual([HAIKU, GEMMA, QWEN]);
    expect(none.ranking[0]!.reasons).toContain(`ranked above ${GEMMA} by route key only: reliability, cost and latency were all equal or unknown`);
    expect(none.reasons).toContain('no metrics rollup was given, so reliability and latency are unknown for every route');
  });

  it('is the same ranking whatever order the routes arrive in', () => {
    expect(recommend([...fleet()].reverse()).order).toEqual(recommend(fleet()).order);
  });
});

// ------------------------------------------------------------------ what is excluded, and why

describe('crr1 · only qualified, unexpired, identity-proven, compatible routes are ranked', () => {
  const excludedFleet = (): RouteForQuery[] => [
    ...fleet(),
    // Expired: its qualification evidence is no longer current.
    { record: record(SONNET, { staleness: { valid: false, reasons: ['staleEvidenceExpired'], detail: ['qualified 40 days ago'] } }),
      description: WIDE, availability: available() },
    // Unverified identity: admitted under crp2, never proven.
    { record: record(CODEX, { identityConfidence: 'unverifiableSubstitutionDetectable', identityAdmitted: true,
      bindingIdentityStates: ['requestAcceptedIdentityUnverifiable'] }), description: WIDE, availability: available() },
    // Metered: incompatible with ctt1's zero-marginal-cost policy.
    { record: record(PICKLE, { billing: routeSpendPosture({ provider: 'opencodeCLI', modelID: 'opencode/big-pickle', now: NOW,
      overrides: [{ provider: 'opencodeCLI', modelID: 'opencode/big-pickle', overrides: 'metered', authorizedBy: 'the owner',
        authorizedAt: '2026-10-19', reason: 'a fixture metered route' }] }) }), description: WIDE, availability: available() },
  ];

  it('excludes expired, unverified-identity and metered routes with their reasons, and ranks none of them', () => {
    const answer = recommend(excludedFleet());
    expect(answer.order).toEqual([GEMMA, QWEN, HAIKU]);
    expect(answer.excluded.map((entry) => entry.routeKey)).toEqual([SONNET, CODEX, PICKLE]);
    expect(reasonsFor(answer, SONNET)).toContain('staleness: the query requires fresh qualification evidence');
    expect(reasonsFor(answer, SONNET)).toContain('qualified 40 days ago');
    expect(reasonsFor(answer, CODEX)).toMatch(/identity/i);
    expect(reasonsFor(answer, PICKLE)).toContain('cost:');
    for (const routeKey of [SONNET, CODEX, PICKLE]) {
      expect(answer.order).not.toContain(routeKey);
      expect(answer.fallback.chain).not.toContain(routeKey);
      expect(answer.fallback.entries.map((entry) => entry.routeKey)).not.toContain(routeKey);
    }
    expect(answer.reasons[1]).toBe('crr1 ranks only qualified, unexpired, identity-proven and compatible routes: 3 ranked, 3 excluded, '
      + 'each exclusion with its reasons');
  });

  it('excludes a route whose identity is unknown, or whose freshness was never established', () => {
    const answer = recommend([...fleet({ [QWEN]: { identityConfidence: 'unknown' }, [GEMMA]: { staleness: undefined } })]);
    expect(answer.order).toEqual([HAIKU]);
    expect(reasonsFor(answer, QWEN)).toMatch(/identity/);
    expect(reasonsFor(answer, GEMMA)).toContain('expiry: no qualification freshness was ever established');
  });

  it('excludes a route whose context window is too small or unknown, and one not qualified for the task or tier', () => {
    const routes = fleet({ [QWEN]: { capabilities: [qualified(CAPABILITY), { ...qualified(TIER), verdict: 'notQualified',
      reason: '1/3 scored runs passed' }] } });
    routes.push({ record: record(SONNET, { capabilities: [{ ...qualified(CAPABILITY), verdict: 'notQualified', reason: '1/3' }, qualified(TIER)] }),
      description: WIDE, availability: available() });
    routes[0] = { ...routes[0]!, description: describedWith(known(8_000, 'fixture catalogue')) };
    routes[1] = { ...routes[1]!, description: describedWith(unknown('no source published a context window')) };
    const answer = recommend(routes);
    expect(answer.order).toEqual([]);
    expect(reasonsFor(answer, GEMMA)).toContain('context: 8000 tokens (fixture catalogue) is below the 32000 required');
    expect(reasonsFor(answer, HAIKU)).toContain('context window is UNKNOWN');
    expect(reasonsFor(answer, QWEN)).toContain('tier: tier2 is notQualified');
    expect(reasonsFor(answer, SONNET)).toContain(`capability: ${CAPABILITY} is notQualified`);
    expect(answer.reasons).toContain('no route qualifies for this task, so there is nothing to rank; nothing is defaulted in its place');
    expect(answer.fallback.chain).toEqual([]);
  });
});

// ------------------------------------------------------------------ the cfc1 fallback order

describe('crr1 · carries the cfc1 fallback order over the same routes', () => {
  it('is exactly cfc1 over the ranked routes, and marks a throttled route in the ranking', () => {
    const routes = fleet({ [QWEN]: { lastSuccessfulQualificationAt: hoursAgo(2) } });
    const answer = recommend(routes);
    const set = qualifiedRouteCandidates(answer.query, routes);
    const chain = deriveFallbackChain(set, { now: NOW, metrics: METRICS });
    expect(answer.fallback.schema).toBe('cfc1');
    expect(answer.fallback.orderingRule).toBe(FALLBACK_ORDERING_RULE);
    expect(answer.fallback.chain).toEqual(chain.chain);
    // cfc1 orders by freshness before metrics; crr1 orders by reliability. The two orders differ, and both are carried.
    expect(answer.fallback.chain).toEqual([QWEN, GEMMA, HAIKU]);
    expect(answer.order).toEqual([GEMMA, QWEN, HAIKU]);
    expect(answer.reasons).toContain(`the cfc1 fallback order over the same routes is ${QWEN} → ${GEMMA} → ${HAIKU}`);

    const throttled = recommend(fleet({ [HAIKU]: { lastThrottle: { at: hoursAgo(1), detail: 'You\'ve hit your session limit' } } }));
    const haiku = throttled.ranking.find((entry) => entry.routeKey === HAIKU)!;
    expect(haiku.fallback.standing).toBe('fallsThrough');
    expect(haiku.reasons.some((reason) => reason.startsWith('fallback: cfc1 would fall through past this route right now'))).toBe(true);
    expect(throttled.fallback.chain).not.toContain(HAIKU);
    expect(throttled.order).toContain(HAIKU);
  });
});

// ------------------------------------------------------------------ advisory only

describe('crr1 · advisory only: it never selects, writes or launches', () => {
  it('says so on every answer and names no winner', () => {
    const answer = recommend(fleet());
    expect(answer.isSelection).toBe(false);
    expect(answer.launches).toBe(false);
    expect(answer.disclosure).toBe(RECOMMENDATION_IS_ADVISORY);
    expect(answer.disclosure).toContain('not a selection');
    expect(answer.reasons[answer.reasons.length - 1]).toBe(
      'advisory only: no route was selected, no routing state was written and nothing was launched');
    for (const forbidden of ['selected', 'selection', 'winner', 'best', 'chosen', 'launch', 'route']) {
      expect(Object.keys(answer)).not.toContain(forbidden);
      for (const entry of answer.ranking) expect(Object.keys(entry)).not.toContain(forbidden);
    }
  });

  it('leaves the routes and rollup it was given untouched', () => {
    const routes = fleet();
    const before = JSON.stringify([routes, METRICS]);
    recommend(routes);
    expect(JSON.stringify([routes, METRICS])).toBe(before);
  });

  it('imports nothing that can send a request, write a file or start a process', () => {
    const source = fs.readFileSync(path.join(REPOSITORY, 'src/engine/route-recommendation.ts'), 'utf8');
    expect(source).not.toMatch(/from '(node:)?(child_process|http|https|net|fs)'|fetch\(|spawn\(|-adapter'|-driver'|routing-decision-log/);
  });
});

// ------------------------------------------------------------------ the command, in a subprocess

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

describe('cernum recommend <task-type> --json', () => {
  it('is declared read-only, with --tier, --context and --json', () => {
    const spec = commandSpec('recommend')!;
    expect(spec.effect).toBe('readOnly');
    expect(spec.positional).toBe('<task-type>');
    expect(acceptedOptions(spec).map((option) => option.name)).toEqual(expect.arrayContaining(['tier', 'context', 'json', 'machine']));
  });

  it('answers a versioned advisory recommendation with every exclusion and its reasons, and writes nothing', async () => {
    const root = temporary();
    const observedAt = new Date(Date.now() - 60_000).toISOString();
    appendObservations(root, [routeAvailabilityObservation({ routeKey: HAIKU, machineKey: HERE, machineLabel: 'fixture-host',
      observedAt, available: true, reason: 'signed in (fixture)' }, 'claudeCLI', 'a fixture availability reading')],
    { origin: 'observedHere', receivedAt: observedAt });
    const before = fs.readdirSync(root, { recursive: true }).map(String).sort();

    const result = await cernum('recommend', 'implement', '--tier', '2', '--context', '32000', '--json', '--machine', HERE, '--root', root);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const answer = JSON.parse(result.stdout) as RouteRecommendation;
    expect(answer).toMatchObject({ schema: 'crr1', ok: true, taxonomyVersion: 'ctt1', contract: 'crc2', isSelection: false,
      launches: false, metricsSchema: 'cmr1', disclosure: RECOMMENDATION_IS_ADVISORY, orderingRule: RECOMMENDATION_ORDERING_RULE });
    expect(answer.query).toMatchObject({ machineKey: HERE, capability: CAPABILITY, structuralTier: 'tier2', minimumContextTokens: 32_000 });
    // No benchmark evidence in the fixture root: nothing is ranked, and the route is excluded with its reasons.
    expect(answer.order).toEqual([]);
    expect(answer.fallback).toMatchObject({ schema: 'cfc1', chain: [] });
    expect(answer.excluded.map((entry) => entry.routeKey)).toEqual([HAIKU]);
    expect(answer.excluded[0]!.reasons.length).toBeGreaterThan(0);
    expect(answer.reasons.length).toBeGreaterThan(0);
    expect(fs.readdirSync(root, { recursive: true }).map(String).sort()).toEqual(before);

    const text = await cernum('recommend', 'implement', '--machine', HERE, '--root', root);
    expect(text.status).toBe(0);
    expect(text.stdout).toContain('Recommendation crr1');
    expect(text.stdout.replace(/\s+/g, ' ')).toContain('not a selection');
  });

  it('refuses an unknown task type with exit 2, reading nothing', async () => {
    const root = temporary();
    const result = await cernum('recommend', 'deploy', '--json', '--machine', HERE, '--root', root);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("task type 'deploy' is not in task taxonomy ctt1");
    expect(result.stdout).toBe('');
    expect(fs.readdirSync(root)).toEqual([]);
  });
});
