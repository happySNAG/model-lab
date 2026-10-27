// The recommendation contract crr2, beside crr1: a versioned document validated against
// docs/ordra-lane/recommend-crr2.schema.json — the query, the first-ranked configuration (route key, exact
// model id, effort or effort-unobservable, machine key), the ranking, the cfc1 chain re-ordered reliability
// first as cfc2, expected reliability with its sample size and a Wilson 95% interval, expected duration,
// resource posture, qualification policy and expiry, confidence with named uncertainties, and exclusions with
// reasons. Reliability, then zero marginal cost, then latency, everywhere (owner, 2026-10-26). Subscription-only
// unless metered routes are explicitly allowed. crr1 and cfc1 stay exactly as they were. Advisory only.
//
// FIXTURES ONLY. Records and run rows are hand-written; the command runs in a subprocess against a temporary
// root holding one fixture availability observation. No driver runs and no provider is contacted.

import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  CFC2_ORDERING_RULE, CRR2_IS_ADVISORY, CRR2_ORDERING_RULE, CRR2_SUBSCRIPTION_ONLY_REASON, Crr2OrderingEvidence,
  Crr2Recommendation, Crr2Refusal, Crr2Request, ROUTE_RECOMMENDATION_CRR2_JSON_SCHEMA, compareCrr2Evidence, recommendRoutesCrr2,
  wilsonInterval95Milli,
} from '../../src/engine/route-recommendation-crr2';
import {
  RECOMMENDATION_ORDERING_RULE, RouteRecommendation, recommendRoutes,
} from '../../src/engine/route-recommendation';
import { FALLBACK_ORDERING_RULE, deriveFallbackChain } from '../../src/engine/fallback-chain';
import { RouteAvailabilitySource, RouteForQuery, qualifiedRouteCandidates } from '../../src/engine/routing-contract';
import { CapabilityQualification, RouteQualificationRecord, V1_QUALIFICATION_POLICY } from '../../src/engine/route-qualification';
import { QUALIFICATION_MAX_AGE_MILLISECONDS } from '../../src/engine/discovery-refresh';
import { EvidenceEffort } from '../../src/engine/effort-keyed-routes';
import { routeSpendPosture } from '../../src/engine/route-spend-posture';
import { measuredQuantity, unavailableQuantity } from '../../src/engine/frontier-metrics';
import { MetricsRollup, deriveMetricsRollup } from '../../src/engine/metrics-rollup';
import { ModelDescription, known } from '../../src/engine/model-description';
import { WorkspaceCase } from '../../src/engine/workspace-case';
import { appendObservations, routeAvailabilityObservation } from '../../src/engine/observation-store';
import { ProviderID } from '../../src/engine/provider';
import { acceptedOptions, commandSpec } from '../../src/cli/command-spec';
import { JsonSchema, validateAgainstSchema } from './json-schema-subset';

const REPOSITORY = path.resolve(__dirname, '../..');
const SCHEMA = JSON.parse(fs.readFileSync(path.join(REPOSITORY, ROUTE_RECOMMENDATION_CRR2_JSON_SCHEMA), 'utf8')) as JsonSchema;
const NOW = new Date('2026-10-26T12:00:00Z');
const HERE = 'cmk1:recommend-crr2-machine';
// ctt1: implement → workspace:multiFileEditing.
const CAPABILITY = 'workspace:multiFileEditing';
const TIER = 'workspace-tier:tier2';
const hoursAgo = (hours: number): string => new Date(NOW.getTime() - hours * 3_600_000).toISOString();

const GEMMA = 'ollama:gemma3:4b';
const QWEN = 'ollama:qwen3:8b';
const HAIKU = 'claudeCLI:claude-haiku-4-5';
const PICKLE = 'opencodeCLI:opencode/big-pickle';
const CODEX = 'codexCLI:gpt-5-codex';

const temporaries: string[] = [];
afterEach(() => { for (const directory of temporaries.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
function temporary(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cernum-recommend-crr2-'));
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

const keyedAt = (routeKey: string, suffix: string, over: Partial<EvidenceEffort> = {}): EvidenceEffort => ({
  effortRouteKey: `${routeKey}@${suffix}`,
  state: suffix.startsWith('unobservable') ? 'unobservable' : 'observed',
  ...(suffix.startsWith('unobservable') ? {} : { effort: suffix as EvidenceEffort['effort'] }),
  requestedEfforts: [(suffix.startsWith('unobservable:') ? suffix.slice('unobservable:'.length) : suffix) as EvidenceEffort['requestedEfforts'][number]],
  runCount: 10, mismatchedRunCount: 0,
  basis: [suffix.startsWith('unobservable') ? 'this run\'s driver measures no applied effort' : 'appliedEffortVerified: fixture telemetry'],
  notKeyed: [], ...over,
});

const available = (): RouteAvailabilitySource => ({
  state: 'available', observedOnMachine: HERE, machineLabel: 'fixture-host', origin: 'observedHere',
  observedAt: hoursAgo(1), reason: 'installed and signed in',
});
const WIDE = ({ contextWindowTokens: known(200_000, 'fixture catalogue'), locality: 'remote' }) as unknown as ModelDescription;

function fleet(over: Record<string, Partial<RouteQualificationRecord>> = {}): RouteForQuery[] {
  return [GEMMA, HAIKU, QWEN].map((routeKey) => ({ record: record(routeKey, over[routeKey]), description: WIDE, availability: available() }));
}

const CASES = [{ id: 'case-a', dimensions: ['multiFileEditing'] }] as unknown as WorkspaceCase[];
function rows(routeKey: string, passes: number, runs: number, wallClock: number): { recordRoot: string; row: Record<string, unknown> }[] {
  const at = routeKey.indexOf(':');
  return Array.from({ length: runs }, (_, index) => ({
    recordRoot: `/fixture/${routeKey}/${index}`,
    row: { provider: routeKey.slice(0, at), requestedModelID: routeKey.slice(at + 1), caseID: 'case-a',
      status: index < passes ? 'pass' : 'fail', wallClockMilliseconds: wallClock, recordedAt: hoursAgo(40 - index) },
  }));
}
const rollup = (...sets: ReturnType<typeof rows>[]): MetricsRollup => deriveMetricsRollup({ workspaceRows: sets.flat(), workspaceCases: CASES });

// GEMMA 29/30 at 5 s; HAIKU 10/10 at 9 s; QWEN 3/3 at 0.1 s. crr1 (point rate) puts QWEN and HAIKU first;
// crr2 (Wilson lower bound) puts GEMMA first, because twenty-nine of thirty says more than three of three.
const METRICS = rollup(rows(GEMMA, 29, 30, 5000), rows(HAIKU, 10, 10, 9000), rows(QWEN, 3, 3, 100));

const REQUEST: Crr2Request = { machineKey: HERE, taskType: 'implement', tier: 2, contextTokens: 32_000 };

function crr2(routes: RouteForQuery[], over: Partial<Crr2Request> = {}, inputs: Partial<Parameters<typeof recommendRoutesCrr2>[1]> = {}): Crr2Recommendation {
  const answer = recommendRoutesCrr2({ ...REQUEST, ...over }, { now: NOW, routes, metrics: METRICS, ...inputs });
  if (!answer.ok) throw new Error(`refused: ${answer.refusals.join('; ')}`);
  return answer;
}
const valid = (document: unknown): string[] => validateAgainstSchema(JSON.parse(JSON.stringify(document)), SCHEMA);
const reasonsFor = (answer: Crr2Recommendation, key: string): string =>
  answer.exclusions.find((entry) => entry.key === key)?.reasons.join(' | ') ?? '';

// ------------------------------------------------------------------ the document and its schema

describe('crr2 · a versioned document validated against docs/ordra-lane/recommend-crr2.schema.json', () => {
  it('names its contract, version, schema, query and rule on every answer', () => {
    const answer = crr2(fleet());
    expect(answer).toMatchObject({ contract: 'crr2', contractVersion: 1, jsonSchema: 'docs/ordra-lane/recommend-crr2.schema.json',
      ok: true, taxonomyVersion: 'ctt1', routingContract: 'crc2', routingPolicyVersion: 'crp2', metricsSchema: 'cmr1',
      answeredAt: NOW.toISOString(), orderingRule: CRR2_ORDERING_RULE });
    expect(answer.query).toMatchObject({ taskType: 'implement', tier: 'tier2', contextTokens: 32_000, machineKey: HERE,
      capability: CAPABILITY, allowMetered: false, costPolicy: 'zeroMarginalCostOnly' });
    expect(answer.query.routeQuery).toMatchObject({ requireVerifiedIdentity: true, requireFreshQualification: true,
      costPolicy: 'zeroMarginalCostOnly', structuralTier: 'tier2', minimumContextTokens: 32_000 });
    expect(SCHEMA.$id).toBe('cernum:recommendation:crr2:1');
  });

  it('validates against the schema whatever the answer holds: a ranking, nothing ranked, metered allowed, effort-keyed', () => {
    expect(valid(crr2(fleet()))).toEqual([]);
    expect(valid(crr2(fleet({ [GEMMA]: { staleness: undefined }, [HAIKU]: { staleness: undefined }, [QWEN]: { staleness: undefined } })))).toEqual([]);
    expect(valid(recommendRoutesCrr2({ ...REQUEST, tier: undefined, contextTokens: undefined }, { now: NOW, routes: fleet() }))).toEqual([]);
    expect(valid(crr2(meteredFleet(), { allowMetered: true }))).toEqual([]);
    expect(valid(crr2(keyedFleet(), {}, { keyedMetrics: KEYED_METRICS }))).toEqual([]);
  });

  it('is refused by the schema when it is not this document: the validator is not a rubber stamp', () => {
    const answer = JSON.parse(JSON.stringify(crr2(fleet()))) as Record<string, unknown>;
    expect(validateAgainstSchema({ ...answer, contract: 'crr1' }, SCHEMA)).toEqual(['$.contract: expected "crr2", found "crr1"']);
    expect(validateAgainstSchema({ ...answer, isSelection: true }, SCHEMA)).toEqual(['$.isSelection: expected false, found true']);
    const { confidence: _dropped, ...withoutConfidence } = answer;
    expect(validateAgainstSchema(withoutConfidence, SCHEMA)).toEqual(["$: missing required 'confidence'"]);
    expect(validateAgainstSchema({ ...answer, winner: GEMMA }, SCHEMA)).toEqual(["$: 'winner' is not allowed"]);
  });

  it('refuses an unknown task type, tier or context with every reason, and ranks nothing', () => {
    const refused = recommendRoutesCrr2({ machineKey: HERE, taskType: 'deploy', tier: 7, contextTokens: 'lots' },
      { now: NOW, routes: fleet(), metrics: METRICS }) as Crr2Refusal;
    expect(refused).toMatchObject({ contract: 'crr2', ok: false, taxonomyVersion: 'ctt1', isSelection: false, launches: false });
    expect(refused.refusals).toHaveLength(3);
    expect(Object.keys(refused)).not.toContain('ranking');
  });
});

// ------------------------------------------------------------------ the selected configuration

describe('crr2 · the first-ranked configuration: route, exact model id, effort or effort-unobservable, machine key', () => {
  it('names a pooled record\'s effort as unobservable, never reading one from the model name', () => {
    const answer = crr2(fleet());
    expect(answer.selected).toEqual({ key: GEMMA, routeKey: GEMMA, provider: 'ollama', modelID: 'gemma3:4b', machineKey: HERE,
      effort: { state: 'unobservable', pooled: true, requestedEfforts: [], basis: [expect.stringContaining('pools every effort')] } });
    expect(answer.ranking[0]).toMatchObject({ rank: 1, key: GEMMA, modelID: 'gemma3:4b', machineKey: HERE });
  });

  it('names an effort-keyed record by its observed effort, and its unobservable sibling apart from it', () => {
    const answer = crr2(keyedFleet(), {}, { keyedMetrics: KEYED_METRICS });
    expect(answer.selected).toMatchObject({ key: `${HAIKU}@high`, routeKey: HAIKU, modelID: 'claude-haiku-4-5', machineKey: HERE,
      effort: { state: 'observed', effort: 'high', effortRouteKey: `${HAIKU}@high`, pooled: false, requestedEfforts: ['high'] } });
    const sibling = answer.ranking.find((entry) => entry.key === `${HAIKU}@unobservable:max`)!;
    expect(sibling.effort).toMatchObject({ state: 'unobservable', pooled: false, requestedEfforts: ['max'] });
    expect(sibling.effort.effort).toBeUndefined();
    // Two efforts of one route are two entries, each read from its own runs alone.
    expect(sibling.reliability).toMatchObject({ sampleSize: 3, passCount: 1 });
    expect(answer.ranking.find((entry) => entry.key === `${HAIKU}@high`)!.reliability).toMatchObject({ sampleSize: 40, passCount: 40 });
  });

  it('never pools another effort\'s runs into a keyed record: no keyed rollup means unknown, with the reason', () => {
    const answer = crr2(keyedFleet(), {}, { keyedMetrics: {} });
    const high = answer.ranking.find((entry) => entry.key === `${HAIKU}@high`)!;
    expect(high.reliability.successRateMilli.provenance).toBe('unavailable');
    expect(high.reliability.source).toContain('evidence of another effort is never pooled in');
    expect(high.uncertainties.map((entry) => entry.code)).toContain('reliabilityUnknown');
  });

  it('has no selected configuration when nothing is ranked, and says so', () => {
    const answer = crr2(fleet({ [GEMMA]: { staleness: undefined }, [HAIKU]: { staleness: undefined }, [QWEN]: { staleness: undefined } }));
    expect(answer.selected).toBeUndefined();
    expect(answer.expectedReliability).toBeUndefined();
    expect(answer.confidence).toEqual({ level: 'none', basis: ['nothing is ranked'] });
    expect(answer.uncertainties.map((entry) => entry.code)).toEqual(['nothingRanked']);
    expect(answer.reasons).toContain('no route qualifies for this task, so there is nothing to rank; nothing is defaulted in its place');
  });
});

// ------------------------------------------------------------------ the order

describe('crr2 · reliability, then zero marginal cost, then latency — for the ranking and the fallback chain', () => {
  it('ranks by the Wilson 95% lower bound, so a large sample outranks a small perfect one', () => {
    const answer = crr2(fleet());
    expect(answer.order).toEqual([GEMMA, HAIKU, QWEN]);
    // crr1, by the point rate, orders the same evidence differently — and is unchanged.
    const crr1 = recommendRoutes(REQUEST, { now: NOW, routes: fleet(), metrics: METRICS }) as RouteRecommendation;
    expect(crr1.order).toEqual([QWEN, HAIKU, GEMMA]);
    expect(answer.ranking[0]!.reasons[3]).toBe(`ranked above ${HAIKU} on reliability: Wilson 95% lower bound 833‰ against 722‰ `
      + '(point rate 967‰ against 1000‰)');
  });

  it('puts zero marginal cost before metered only when reliability ties, and latency only after both', () => {
    const q = (value: number | undefined) => (value === undefined ? unavailableQuantity('none') : measuredQuantity(value));
    const evidence = (key: string, lower: number | undefined, rate: number | undefined, group: Crr2OrderingEvidence['group'],
                      p90: number | undefined, median?: number): Crr2OrderingEvidence => ({
      key, group, reliability: { successRateMilli: q(rate), interval95: { method: 'wilson', z: 1.96, lowerMilli: q(lower), upperMilli: q(1000) } },
      duration: { p90Milliseconds: q(p90), medianMilliseconds: q(median ?? p90) },
    });
    const order = (entries: Crr2OrderingEvidence[]): string[] => [...entries].sort(compareCrr2Evidence).map((entry) => entry.key);
    // A more reliable metered route ranks above a less reliable free one.
    expect(order([evidence('free', 800, 900, 'zeroMarginalCost', 10), evidence('metered', 850, 900, 'meteredRequiresAuthorization', 9999)]))
      .toEqual(['metered', 'free']);
    // Equal lower bound: the point rate breaks it before cost does.
    expect(order([evidence('a', 800, 900, 'zeroMarginalCost', 10), evidence('b', 800, 950, 'meteredRequiresAuthorization', 10)]))
      .toEqual(['b', 'a']);
    // Equal reliability: zero marginal cost first, however slow.
    expect(order([evidence('metered', 800, 900, 'meteredRequiresAuthorization', 10), evidence('free', 800, 900, 'zeroMarginalCost', 9999)]))
      .toEqual(['free', 'metered']);
    // Equal reliability and cost: lower p90, then lower median, unknown after known, then key.
    expect(order([evidence('c', 800, 900, 'zeroMarginalCost', undefined), evidence('b', 800, 900, 'zeroMarginalCost', 20, 9),
      evidence('a', 800, 900, 'zeroMarginalCost', 20, 9), evidence('e', 800, 900, 'zeroMarginalCost', 20, 5),
      evidence('d', 800, 900, 'zeroMarginalCost', 10)])).toEqual(['d', 'e', 'a', 'b', 'c']);
    // An unknown reliability after every known one, however low.
    expect(order([evidence('unknown', undefined, undefined, 'zeroMarginalCost', 1), evidence('poor', 1, 100, 'meteredRequiresAuthorization', 9)]))
      .toEqual(['poor', 'unknown']);
  });

  it('re-orders the cfc1 chain reliability first as cfc2, and carries cfc1 beside it unchanged', () => {
    const routes = fleet();
    const answer = crr2(routes);
    const cfc1 = deriveFallbackChain(qualifiedRouteCandidates(answer.query.routeQuery, routes), { now: NOW, metrics: METRICS });
    expect(answer.fallback).toMatchObject({ schema: 'cfc2', basedOn: 'cfc1', orderingRule: CFC2_ORDERING_RULE });
    expect(answer.fallback.cfc1).toEqual({ schema: 'cfc1', orderingRule: FALLBACK_ORDERING_RULE, chain: cfc1.chain });
    // cfc1 orders by failure rate then p90; cfc2 by the crr2 rule. Same routes, different order, both carried.
    expect(cfc1.chain).toEqual([QWEN, HAIKU, GEMMA]);
    expect(answer.fallback.chain).toEqual([GEMMA, HAIKU, QWEN]);
    expect(answer.fallback.entries.map((entry) => [entry.key, entry.position, entry.cfc1Position]))
      .toEqual([[GEMMA, 1, 3], [HAIKU, 2, 2], [QWEN, 3, 1]]);
  });

  it('keeps a throttled route in place in cfc2, marked falling through with cfc1\'s reasons', () => {
    const answer = crr2(fleet({ [HAIKU]: { lastThrottle: { at: hoursAgo(1), detail: 'You\'ve hit your session limit' } } }));
    const haiku = answer.fallback.entries.find((entry) => entry.key === HAIKU)!;
    expect(haiku).toMatchObject({ position: 2, standing: 'fallsThrough' });
    expect(haiku.fallsThroughBecause[0]).toContain('throttle:');
    expect(answer.fallback.chain).toEqual([GEMMA, QWEN]);
    expect(answer.order).toEqual([GEMMA, HAIKU, QWEN]);
    const ranked = answer.ranking.find((entry) => entry.key === HAIKU)!;
    expect(ranked.uncertainties.map((entry) => entry.code)).toContain('fallsThroughNow');
    expect(ranked.reasons.some((reason) => reason.startsWith('fallback: cfc2 would fall through past this route right now'))).toBe(true);
  });

  it('is the same answer whatever order the routes arrive in', () => {
    expect(crr2([...fleet()].reverse()).order).toEqual(crr2(fleet()).order);
    expect(crr2([...keyedFleet()].reverse(), {}, { keyedMetrics: KEYED_METRICS }).order)
      .toEqual(crr2(keyedFleet(), {}, { keyedMetrics: KEYED_METRICS }).order);
  });
});

// ------------------------------------------------------------------ the figures

describe('crr2 · expected reliability, duration, resource posture and qualification freshness', () => {
  it('computes the Wilson 95% interval in thousandths, lower floored and upper ceilinged', () => {
    expect(wilsonInterval95Milli(5, 10)).toEqual({ lowerMilli: 236, upperMilli: 764 });
    expect(wilsonInterval95Milli(10, 10)).toEqual({ lowerMilli: 722, upperMilli: 1000 });
    expect(wilsonInterval95Milli(3, 3)).toEqual({ lowerMilli: 438, upperMilli: 1000 });
    expect(wilsonInterval95Milli(0, 4)).toEqual({ lowerMilli: 0, upperMilli: 490 });
    expect(wilsonInterval95Milli(0, 0)).toBeUndefined();
    expect(wilsonInterval95Milli(4, 3)).toBeUndefined();
  });

  it('states the selected route\'s reliability with its sample size, its duration, posture and qualification expiry', () => {
    const answer = crr2(fleet());
    expect(answer.expectedReliability).toEqual({ capability: CAPABILITY, sampleSize: 30, passCount: 29,
      successRateMilli: measuredQuantity(967),
      interval95: { method: 'wilson', z: 1.96, lowerMilli: measuredQuantity(833), upperMilli: measuredQuantity(995) },
      source: 'metrics rollup cmr1' });
    expect(answer.expectedDuration).toMatchObject({ capability: CAPABILITY, sampleSize: 30,
      medianMilliseconds: { value: 5000 }, p90Milliseconds: { value: 5000 } });
    expect(answer.resourcePosture).toMatchObject({ posture: 'zeroMarginalCost', group: 'zeroMarginalCost',
      requiresSpendingAuthorization: false, eligibility: 'local' });
    const qualifiedAt = hoursAgo(24);
    expect(answer.qualification).toEqual({ defaultPolicyID: 'cqp1', selected: {
      policyID: 'cqp1', defaultPolicyID: 'cqp1', capabilityVerdict: 'qualified', tierVerdict: 'qualified', qualifiedAt,
      expiresAt: new Date(Date.parse(qualifiedAt) + QUALIFICATION_MAX_AGE_MILLISECONDS).toISOString(),
      maxAgeMilliseconds: QUALIFICATION_MAX_AGE_MILLISECONDS,
      remainingMilliseconds: QUALIFICATION_MAX_AGE_MILLISECONDS - 24 * 3_600_000, current: true, detail: ['nothing moved'] } });
  });

  it('states an unobserved duration as unknown with its reason, never a guess', () => {
    const answer = crr2(fleet(), {}, { metrics: rollup(rows(GEMMA, 29, 30, 5000)) });
    const qwen = answer.ranking.find((entry) => entry.key === QWEN)!;
    expect(qwen.duration.p90Milliseconds.provenance).toBe('unavailable');
    expect(qwen.duration.sampleSize).toBe(0);
    expect(qwen.uncertainties.map((entry) => entry.code)).toEqual(['reliabilityUnknown', 'effortUnobservable', 'durationUnknown']);
  });
});

// ------------------------------------------------------------------ confidence and uncertainties

describe('crr2 · confidence, with every uncertainty named', () => {
  it('is medium for a well-sampled route whose effort is pooled, and names that uncertainty', () => {
    const answer = crr2(fleet());
    expect(answer.uncertainties).toEqual([{ code: 'effortUnobservable', key: GEMMA,
      detail: 'the evidence pools every effort; no single effort was observed' }]);
    expect(answer.confidence.level).toBe('medium');
    expect(answer.confidence.basis).toEqual([`effortUnobservable (${GEMMA}): the evidence pools every effort; no single effort was observed`]);
  });

  it('is high only with a known, well-sampled reliability, an observed effort and duration, and a fallback behind it', () => {
    const answer = crr2(keyedFleet(), {}, { keyedMetrics: KEYED_METRICS });
    expect(answer.uncertainties).toEqual([]);
    expect(answer.confidence.level).toBe('high');
  });

  it('is low on a small sample, and names the wide interval and the missing fallback', () => {
    const answer = crr2([fleet()[2]!]);
    expect(answer.selected?.key).toBe(QWEN);
    expect(answer.uncertainties.map((entry) => entry.code)).toEqual(['smallSample', 'wideInterval', 'effortUnobservable', 'noFallback']);
    expect(answer.confidence.level).toBe('low');
    const none = recommendRoutesCrr2(REQUEST, { now: NOW, routes: fleet() }) as Crr2Recommendation;
    expect(none.uncertainties[0]).toMatchObject({ code: 'noMetrics' });
    expect(none.confidence.level).toBe('low');
  });
});

// ------------------------------------------------------------------ subscription-only by default

function meteredFleet(): RouteForQuery[] {
  return [...fleet(), { record: record(PICKLE, { billing: routeSpendPosture({ provider: 'opencodeCLI', modelID: 'opencode/big-pickle', now: NOW,
    overrides: [{ provider: 'opencodeCLI', modelID: 'opencode/big-pickle', overrides: 'metered', authorizedBy: 'the owner',
      authorizedAt: '2026-10-19', reason: 'a fixture metered route' }] }) }), description: WIDE, availability: available() }];
}
const METERED_METRICS = rollup(rows(GEMMA, 29, 30, 5000), rows(HAIKU, 10, 10, 9000), rows(QWEN, 3, 3, 100), rows(PICKLE, 30, 30, 50));

describe('crr2 · subscription-only unless metered routes are explicitly allowed', () => {
  it('excludes a metered route by default, with the subscription-only reason, however reliable it is', () => {
    const answer = crr2(meteredFleet(), {}, { metrics: METERED_METRICS });
    expect(answer.order).toEqual([GEMMA, HAIKU, QWEN]);
    expect(reasonsFor(answer, PICKLE)).toContain('cost: the query admits only zero-marginal-cost routes');
    expect(reasonsFor(answer, PICKLE)).toContain(CRR2_SUBSCRIPTION_ONLY_REASON);
    expect(answer.fallback.chain).not.toContain(PICKLE);
    expect(answer.reasons[1]).toContain('subscription-only (the default)');
  });

  it('ranks it, by the same rule, only when allowMetered is given — and says it needs a spending authorization', () => {
    const answer = crr2(meteredFleet(), { allowMetered: true }, { metrics: METERED_METRICS });
    expect(answer.query).toMatchObject({ allowMetered: true, costPolicy: 'allowMeteredWithAuthorization' });
    // 30/30 metered has the highest lower bound: reliability comes before cost.
    expect(answer.order).toEqual([PICKLE, GEMMA, HAIKU, QWEN]);
    expect(answer.resourcePosture).toMatchObject({ posture: 'metered', group: 'meteredRequiresAuthorization', requiresSpendingAuthorization: true });
    expect(answer.ranking[0]!.reasons[1]).toBe('cost: metered — requires a spending authorization before any use');
    expect(answer.exclusions).toEqual([]);
  });
});

// ------------------------------------------------------------------ exclusions

describe('crr2 · only qualified, unexpired, identity-proven, compatible routes are ranked; every other is excluded with reasons', () => {
  it('excludes an expired and an unverified-identity route by key, with their reasons', () => {
    const routes = [...fleet({ [QWEN]: { staleness: { valid: false, reasons: ['staleEvidenceExpired'], detail: ['qualified 40 days ago'] } } }),
      { record: record(CODEX, { identityConfidence: 'unverifiableSubstitutionDetectable', identityAdmitted: true,
        bindingIdentityStates: ['requestAcceptedIdentityUnverifiable'] }), description: WIDE, availability: available() }];
    const answer = crr2(routes);
    expect(answer.order).toEqual([GEMMA, HAIKU]);
    expect(answer.exclusions.map((entry) => entry.key)).toEqual([CODEX, QWEN]);
    expect(reasonsFor(answer, QWEN)).toContain('qualified 40 days ago');
    expect(reasonsFor(answer, CODEX)).toMatch(/identity/i);
    expect(answer.exclusions[0]!.effort).toMatchObject({ state: 'unobservable', pooled: true });
  });
});

// ------------------------------------------------------------------ crr1 and cfc1 unchanged; advisory only

describe('crr2 · beside crr1 and cfc1, never in place of them; advisory only', () => {
  it('leaves crr1 answering exactly as it did', () => {
    const crr1 = recommendRoutes(REQUEST, { now: NOW, routes: fleet(), metrics: METRICS }) as RouteRecommendation;
    expect(crr1).toMatchObject({ schema: 'crr1', contract: 'crc2', orderingRule: RECOMMENDATION_ORDERING_RULE });
    expect(crr1.fallback.schema).toBe('cfc1');
    for (const added of ['contractVersion', 'selected', 'expectedReliability', 'confidence', 'uncertainties', 'exclusions']) {
      expect(Object.keys(crr1)).not.toContain(added);
    }
  });

  it('says it is advisory on every answer, and leaves its inputs untouched', () => {
    const routes = fleet();
    const before = JSON.stringify([routes, METRICS]);
    const answer = crr2(routes);
    expect(JSON.stringify([routes, METRICS])).toBe(before);
    expect(answer).toMatchObject({ advisory: true, isSelection: false, launches: false, disclosure: CRR2_IS_ADVISORY });
    expect(answer.reasons[answer.reasons.length - 1]).toBe('advisory only: no route was selected, no routing state was written and nothing was launched');
  });

  it('imports nothing that can send a request, write a file or start a process', () => {
    const source = fs.readFileSync(path.join(REPOSITORY, 'src/engine/route-recommendation-crr2.ts'), 'utf8');
    expect(source).not.toMatch(/from '(node:)?(child_process|http|https|net|fs)'|fetch\(|spawn\(|-adapter'|-driver'|routing-decision-log/);
  });

  it('is documented beside its schema, and in the README row', () => {
    const page = fs.readFileSync(path.join(REPOSITORY, 'docs/ordra-lane/recommend-crr2.md'), 'utf8');
    for (const phrase of ['`crr2`', 'recommend-crr2.schema.json', 'cfc2', 'Wilson', '--allow-metered', 'reliability, then zero marginal cost, then latency']) {
      expect(page).toContain(phrase);
    }
    const readme = fs.readFileSync(path.join(REPOSITORY, 'README.md'), 'utf8');
    expect(readme).toContain('--contract crr2');
    expect(readme).toContain('docs/ordra-lane/recommend-crr2.md');
  });
});

// ------------------------------------------------------------------ fixtures: effort-keyed records

/** HAIKU at an observed `high` (40/40, lower bound 912‰) and at `unobservable:max` (1/3), and GEMMA at an observed `medium` (29/30). */
function keyedFleet(): RouteForQuery[] {
  return [
    { record: record(HAIKU, { evidenceEffort: keyedAt(HAIKU, 'high') }), description: WIDE, availability: available() },
    { record: record(HAIKU, { evidenceEffort: keyedAt(HAIKU, 'unobservable:max', { runCount: 3 }) }), description: WIDE, availability: available() },
    { record: record(GEMMA, { evidenceEffort: keyedAt(GEMMA, 'medium', { runCount: 30 }) }), description: WIDE, availability: available() },
  ];
}
const KEYED_METRICS: Record<string, MetricsRollup> = {
  [`${HAIKU}@high`]: rollup(rows(HAIKU, 40, 40, 9000)),
  [`${HAIKU}@unobservable:max`]: rollup(rows(HAIKU, 1, 3, 100)),
  [`${GEMMA}@medium`]: rollup(rows(GEMMA, 29, 30, 5000)),
};

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

function fixtureRoot(): string {
  const root = temporary();
  const observedAt = new Date(Date.now() - 60_000).toISOString();
  appendObservations(root, [routeAvailabilityObservation({ routeKey: HAIKU, machineKey: HERE, machineLabel: 'fixture-host',
    observedAt, available: true, reason: 'signed in (fixture)' }, 'claudeCLI', 'a fixture availability reading')],
  { origin: 'observedHere', receivedAt: observedAt });
  return root;
}

describe('cernum recommend <task-type> --contract crr2 --json', () => {
  it('is declared read-only, with --contract and --allow-metered beside the crr1 options', () => {
    const spec = commandSpec('recommend')!;
    expect(spec.effect).toBe('readOnly');
    expect(acceptedOptions(spec).map((option) => option.name))
      .toEqual(expect.arrayContaining(['tier', 'context', 'json', 'machine', 'policy', 'contract', 'allow-metered']));
  });

  it('emits one schema-valid crr2 document with every exclusion and its reasons, and writes nothing', async () => {
    const root = fixtureRoot();
    const before = fs.readdirSync(root, { recursive: true }).map(String).sort();
    const result = await cernum('recommend', 'implement', '--contract', 'crr2', '--tier', '2', '--context', '32000', '--json',
      '--machine', HERE, '--root', root);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const answer = JSON.parse(result.stdout) as Crr2Recommendation;
    expect(validateAgainstSchema(answer, SCHEMA)).toEqual([]);
    expect(answer).toMatchObject({ contract: 'crr2', contractVersion: 1, isSelection: false, launches: false, advisory: true,
      query: { taskType: 'implement', tier: 'tier2', contextTokens: 32_000, machineKey: HERE, allowMetered: false },
      confidence: { level: 'none' } });
    // No benchmark evidence in the fixture root: nothing is ranked, and the route is excluded with its reasons.
    expect(answer.order).toEqual([]);
    expect(answer.selected).toBeUndefined();
    expect(answer.exclusions.map((entry) => entry.key)).toEqual([HAIKU]);
    expect(answer.exclusions[0]!.reasons.length).toBeGreaterThan(0);
    expect(fs.readdirSync(root, { recursive: true }).map(String).sort()).toEqual(before);

    const metered = await cernum('recommend', 'implement', '--contract', 'crr2', '--allow-metered', '--machine', HERE, '--root', root);
    expect(metered.status).toBe(0);
    expect(metered.stdout).toContain('Recommendation crr2 v1');
    expect(metered.stdout).toContain('metered allowed');
    expect(metered.stdout.replace(/\s+/g, ' ')).toContain('not a selection');
  });

  it('leaves the crr1 answer unchanged without --contract, and refuses --allow-metered or an unknown contract beside it', async () => {
    const root = fixtureRoot();
    const crr1 = await cernum('recommend', 'implement', '--json', '--machine', HERE, '--root', root);
    expect(crr1.status).toBe(0);
    const answer = JSON.parse(crr1.stdout) as RouteRecommendation;
    expect(answer).toMatchObject({ schema: 'crr1', contract: 'crc2', fallback: { schema: 'cfc1' } });
    expect(Object.keys(answer)).not.toContain('contractVersion');

    const refused = await cernum('recommend', 'implement', '--allow-metered', '--json', '--machine', HERE, '--root', root);
    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain('--allow-metered belongs to --contract crr2');
    expect(refused.stdout).toBe('');
    const unknownContract = await cernum('recommend', 'implement', '--contract', 'crr9', '--json', '--machine', HERE, '--root', root);
    expect(unknownContract.status).toBe(2);
    expect(unknownContract.stderr).toContain("--contract must be 'crr1' or 'crr2', not 'crr9'");
  });
});
