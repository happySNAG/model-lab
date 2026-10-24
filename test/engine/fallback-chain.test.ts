// The advisory fallback chain (cfc1): the qualified candidate set in one documented, versioned order —
// zero marginal cost first, then qualification freshness, then the metrics rollup — with every excluded
// route and its reasons, and an unavailable or throttled route falling through to the next. Never a selection.
//
// FIXTURES ONLY. Records and run rows are hand-written; the command runs in a subprocess against a temporary
// root holding one fixture availability observation. No driver runs and no provider is contacted.

import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  FALLBACK_CHAIN_IS_NOT_A_SELECTION, FALLBACK_CHAIN_RULE_VERSION, FALLBACK_ORDERING_RULE, FallbackChain,
  FallbackThrottleEvidence, deriveFallbackChain, throttleEvidenceFromRecords,
} from '../../src/engine/fallback-chain';
import {
  ROUTE_CANDIDATES_ARE_NOT_A_CHOICE, RouteAvailabilitySource, RouteCandidateQuery, RouteCandidateSet, qualifiedRouteCandidates,
} from '../../src/engine/routing-contract';
import { RouteQualificationRecord, V1_QUALIFICATION_POLICY } from '../../src/engine/route-qualification';
import { routeSpendPosture } from '../../src/engine/route-spend-posture';
import { measuredQuantity } from '../../src/engine/frontier-metrics';
import { deriveMetricsRollup } from '../../src/engine/metrics-rollup';
import { WorkspaceCase } from '../../src/engine/workspace-case';
import { appendObservations, routeAvailabilityObservation } from '../../src/engine/observation-store';
import { ProviderID } from '../../src/engine/provider';
import { acceptedOptions, commandSpec } from '../../src/cli/command-spec';

const REPOSITORY = path.resolve(__dirname, '../..');
const NOW = new Date('2026-10-20T12:00:00Z');
const HERE = 'cmk1:fallback-chain-machine';
const CAPABILITY = 'workspace:multiFileEditing';
const hoursAgo = (hours: number): string => new Date(NOW.getTime() - hours * 3_600_000).toISOString();

const GEMMA = 'ollama:gemma3:4b';
const QWEN = 'ollama:qwen3:8b';
const HAIKU = 'claudeCLI:claude-haiku-4-5';
const SONNET = 'claudeCLI:claude-sonnet-4-5';
const PICKLE = 'opencodeCLI:opencode/big-pickle';

const temporaries: string[] = [];
afterEach(() => { for (const directory of temporaries.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
function temporary(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cernum-fallback-chain-'));
  temporaries.push(directory);
  return directory;
}

function record(routeKey: string, over: Partial<RouteQualificationRecord> = {}): RouteQualificationRecord {
  const at = routeKey.indexOf(':');
  const provider = routeKey.slice(0, at) as ProviderID;
  const modelID = routeKey.slice(at + 1);
  return {
    schema: 'crq1', routeKey, provider, modelID, effort: 'any', policy: V1_QUALIFICATION_POLICY,
    qualificationScope: provider === 'ollama' ? 'machine' : 'route',
    discovered: { state: 'currentlyDiscovered', reason: 'observed just now' },
    availableOnThisMachine: { state: 'available', reason: 'installed and signed in' },
    identityConfidence: provider === 'ollama' ? 'verifiedByLocalDigest' : 'verifiedByProvider',
    bindingIdentityStates: ['verified'], identityAdmitted: false, routingPolicyVersion: 'crp2',
    billing: routeSpendPosture({ provider, modelID, now: NOW }),
    evidence: {
      prose: { present: false, candidates: [] }, development: { present: false, candidates: [] },
      workspace: { present: true, runCount: 3, scoredRunCount: 3, packs: ['p'], recordRoots: [] },
    },
    capabilities: [{
      capability: CAPABILITY, source: 'workspace', verdict: 'qualified', scoredRunCount: 3, successCount: 3,
      successRateMilli: measuredQuantity(1000), evidenceRefs: ['case-a'], reason: '3/3 scored runs passed (≥ 90%)',
    }],
    discriminator: [],
    lastSuccessfulQualificationAt: hoursAgo(48),
    efficiency: { medianWallClockMilliseconds: measuredQuantity(1000), medianTotalTokens: measuredQuantity(100), basis: 'medians' },
    staleness: { valid: true, reasons: ['qualificationStillValid'], detail: ['nothing moved'] },
    safeToRoute: true, routableCapabilities: [CAPABILITY], notRoutableBecause: [], blockers: [],
    disclosure: 'no universal score',
    ...over,
  };
}

const METERED_BILLING = routeSpendPosture({ provider: 'opencodeCLI', modelID: 'opencode/big-pickle', now: NOW,
  overrides: [{ provider: 'opencodeCLI', modelID: 'opencode/big-pickle', overrides: 'metered',
    authorizedBy: 'the owner', authorizedAt: '2026-10-19', reason: 'a fixture metered route' }] });

const available = (reason = 'installed and signed in'): RouteAvailabilitySource => ({
  state: 'available', observedOnMachine: HERE, machineLabel: 'fixture-host', origin: 'observedHere',
  observedAt: hoursAgo(1), reason,
});

const query = (over: Partial<RouteCandidateQuery> = {}): RouteCandidateQuery => ({
  machineKey: HERE, capability: CAPABILITY, costPolicy: 'allowMeteredWithAuthorization', ...over,
});

/** Four qualified routes: two local, one subscription, one metered — the metered one the freshest of all. */
function fleet(over: Record<string, Partial<RouteQualificationRecord>> = {}): RouteQualificationRecord[] {
  return [
    record(PICKLE, { billing: METERED_BILLING, lastSuccessfulQualificationAt: hoursAgo(2), ...over[PICKLE] }),
    record(GEMMA, { lastSuccessfulQualificationAt: hoursAgo(48), ...over[GEMMA] }),
    record(HAIKU, { lastSuccessfulQualificationAt: hoursAgo(24), ...over[HAIKU] }),
    record(QWEN, { lastSuccessfulQualificationAt: hoursAgo(24), ...over[QWEN] }),
  ];
}

function setOf(records: RouteQualificationRecord[], availability: Record<string, RouteAvailabilitySource> = {}): RouteCandidateSet {
  return qualifiedRouteCandidates(query(), records.map((entry) => ({ record: entry, availability: availability[entry.routeKey] ?? available() })));
}

/** Rows for the metrics rollup: QWEN failed none of its runs, HAIKU one of three. */
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
  workspaceRows: [...rows(QWEN, ['pass', 'pass', 'pass'], [9000, 9000, 9000]),
    ...rows(HAIKU, ['pass', 'fail', 'pass'], [100, 100, 100])],
  workspaceCases: CASES,
});

const keys = (chain: FallbackChain): string[] => chain.entries.map((entry) => entry.routeKey);
const entryFor = (chain: FallbackChain, routeKey: string) => chain.entries.find((entry) => entry.routeKey === routeKey)!;

// ------------------------------------------------------------------ the rule

describe('cfc1 · one documented, versioned ordering rule over recorded evidence', () => {
  it('names its version and its rule on every answer', () => {
    expect(FALLBACK_CHAIN_RULE_VERSION).toBe('cfc1');
    const chain = deriveFallbackChain(setOf(fleet()), { now: NOW, metrics: METRICS });
    expect(chain.schema).toBe('cfc1');
    expect(chain.contract).toBe('crc2');
    expect(chain.orderingRule).toBe(FALLBACK_ORDERING_RULE);
    expect(chain.metricsSchema).toBe('cmr1');
    expect(chain.answeredAt).toBe(NOW.toISOString());
  });

  it('puts zero marginal cost before metered, then fresher qualification first, then the metrics rollup', () => {
    const chain = deriveFallbackChain(setOf(fleet()), { now: NOW, metrics: METRICS });
    // HAIKU and QWEN were both last qualified 24 hours ago, so the rollup decides between them: QWEN failed
    // none of its runs and HAIKU one of three — failure rate first, however much faster HAIKU's p90 is.
    // GEMMA is older. PICKLE is the freshest of all and still last: it is metered.
    expect(keys(chain)).toEqual([QWEN, HAIKU, GEMMA, PICKLE]);
    expect(chain.chain).toEqual([QWEN, HAIKU, GEMMA, PICKLE]);
    expect(chain.entries.map((entry) => entry.position)).toEqual([1, 2, 3, 4]);
    expect(entryFor(chain, PICKLE).orderedBy.group).toBe('meteredRequiresAuthorization');
    expect(entryFor(chain, QWEN).orderedBy.failureRateMilli).toEqual(measuredQuantity(0));
    expect(entryFor(chain, HAIKU).orderedBy.failureRateMilli).toEqual(measuredQuantity(333));
    expect(entryFor(chain, HAIKU).orderedBy.p90WallClockMilliseconds.value).toBe(100);
  });

  it('breaks an equal failure rate by p90 wall clock, and orders nothing by metrics it was not given', () => {
    const even = deriveMetricsRollup({
      workspaceRows: [...rows(QWEN, ['pass', 'pass'], [9000, 9000]), ...rows(HAIKU, ['pass', 'pass'], [100, 200])],
      workspaceCases: CASES,
    });
    expect(keys(deriveFallbackChain(setOf(fleet()), { now: NOW, metrics: even }))).toEqual([HAIKU, QWEN, GEMMA, PICKLE]);
    // No rollup: the metrics step is unknown for everyone, stated, and the route key decides the tie.
    const none = deriveFallbackChain(setOf(fleet()), { now: NOW });
    expect(keys(none)).toEqual([HAIKU, QWEN, GEMMA, PICKLE]);
    expect(none.metricsSchema).toBeUndefined();
    expect(entryFor(none, QWEN).orderedBy.failureRateMilli).toMatchObject({ provenance: 'unavailable' });
  });

  it('sorts a route with no recorded passing run, or no metrics, after those that have them', () => {
    const chain = deriveFallbackChain(setOf(fleet({ [QWEN]: { lastSuccessfulQualificationAt: undefined } })),
      { now: NOW, metrics: METRICS });
    expect(keys(chain)).toEqual([HAIKU, GEMMA, QWEN, PICKLE]);
    const onlyHaiku = deriveMetricsRollup({ workspaceRows: rows(HAIKU, ['pass', 'fail'], [1, 1]), workspaceCases: CASES });
    expect(keys(deriveFallbackChain(setOf(fleet()), { now: NOW, metrics: onlyHaiku }))).toEqual([HAIKU, QWEN, GEMMA, PICKLE]);
  });

  it('is the same chain whatever order the routes arrive in', () => {
    const forward = deriveFallbackChain(setOf(fleet()), { now: NOW, metrics: METRICS });
    const reversed = deriveFallbackChain(setOf([...fleet()].reverse()), { now: NOW, metrics: METRICS });
    expect(keys(reversed)).toEqual(keys(forward));
  });
});

// ------------------------------------------------------------------ exclusions

describe('every excluded route stays excluded, with its reasons', () => {
  it('carries the candidate set\'s exclusions unchanged and lets none of them into the chain', () => {
    const unqualified = record(SONNET, { capabilities: [{ capability: CAPABILITY, source: 'workspace', verdict: 'notQualified',
      scoredRunCount: 3, successCount: 1, successRateMilli: measuredQuantity(333), evidenceRefs: [], reason: '1/3 scored runs passed' }],
    lastSuccessfulQualificationAt: hoursAgo(1) });
    const gone: RouteAvailabilitySource = { ...available(), state: 'unavailable', reason: 'not installed' };
    const set = setOf([...fleet(), unqualified], { [GEMMA]: gone });
    const chain = deriveFallbackChain(set, { now: NOW, metrics: METRICS });
    expect(chain.excluded).toEqual(set.excluded);
    expect(chain.excluded.map((entry) => entry.routeKey)).toEqual([SONNET, GEMMA].sort());
    expect(chain.excluded.find((entry) => entry.routeKey === GEMMA)!.reasons.join(' ')).toContain('availability: not installed');
    expect(chain.excluded.find((entry) => entry.routeKey === SONNET)!.reasons.join(' ')).toContain('capability:');
    for (const routeKey of [SONNET, GEMMA]) {
      expect(chain.chain).not.toContain(routeKey);
      expect(keys(chain)).not.toContain(routeKey);
    }
  });

  it('keeps a metered route out of a zero-marginal-cost query, however fresh it is', () => {
    const set = qualifiedRouteCandidates(query({ costPolicy: 'zeroMarginalCostOnly' }),
      fleet().map((entry) => ({ record: entry, availability: available() })));
    const chain = deriveFallbackChain(set, { now: NOW, metrics: METRICS });
    expect(chain.chain).not.toContain(PICKLE);
    expect(chain.excluded.find((entry) => entry.routeKey === PICKLE)!.reasons.join(' ')).toContain('zero-marginal-cost');
  });
});

// ------------------------------------------------------------------ fall-through

describe('an unavailable or throttled route falls through to the next', () => {
  it('falls through past a candidate whose availability is no longer available, keeping its place and reason', () => {
    const set = setOf(fleet());
    const stale = { ...set, candidates: set.candidates.map((candidate) => (candidate.routeKey === QWEN
      ? { ...candidate, availability: { ...candidate.availability, state: 'stale' as const, reason: 'last observed 30 hours ago' } }
      : candidate)) };
    const chain = deriveFallbackChain(stale, { now: NOW, metrics: METRICS });
    expect(keys(chain)).toEqual([QWEN, HAIKU, GEMMA, PICKLE]);
    expect(entryFor(chain, QWEN)).toMatchObject({ position: 1, standing: 'fallsThrough' });
    expect(entryFor(chain, QWEN).fallsThroughBecause[0]).toMatch(/^availability: stale on cmk1:fallback-chain-machine — last observed/);
    expect(chain.chain).toEqual([HAIKU, GEMMA, PICKLE]);
  });

  it('falls through past a route its own recorded throttle still reaches, and back in once it is lifted', () => {
    const declined = { lastThrottle: { at: hoursAgo(1), detail: 'You\'ve hit your session limit · resets 8:10pm (America/Chicago)' } };
    const chain = deriveFallbackChain(setOf(fleet({ [QWEN]: declined })), { now: NOW, metrics: METRICS });
    const qwen = entryFor(chain, QWEN);
    expect(qwen.standing).toBe('fallsThrough');
    expect(qwen.fallsThroughBecause[0]).toMatch(/^throttle: this route was declined/);
    expect(qwen.throttles[0]).toMatchObject({ observedOnRoute: QWEN, scope: 'provider', scopeDeclared: false });
    // The provider's reset words, verbatim; never parsed into a clock.
    expect(qwen.throttles[0]!.reset).toContain('resets 8:10pm (America/Chicago)');
    // ollama has declared no throttle scope, so the fallback scope is the whole provider: GEMMA falls through too.
    expect(entryFor(chain, GEMMA).standing).toBe('fallsThrough');
    expect(entryFor(chain, GEMMA).fallsThroughBecause[0]).toContain(`throttle: ${QWEN} was declined`);
    expect(entryFor(chain, GEMMA).fallsThroughBecause[0]).toContain('undeclared by the provider');
    expect(chain.chain).toEqual([HAIKU, PICKLE]);

    // A passing run AFTER the throttle lifts it.
    const passedSince = deriveFallbackChain(setOf(fleet({ [QWEN]: { ...declined, lastSuccessfulQualificationAt: hoursAgo(0.5) } })),
      { now: NOW, metrics: METRICS });
    expect(entryFor(passedSince, QWEN).standing).toBe('inChain');
    // A throttle older than the window no longer speaks to now.
    const old = deriveFallbackChain(setOf(fleet({ [QWEN]: { lastThrottle: { at: hoursAgo(25), detail: 'rate limited' } } })),
      { now: NOW, metrics: METRICS });
    expect(entryFor(old, QWEN).standing).toBe('inChain');
  });

  it('honours a retry-after delay only as the provider stated it', () => {
    const throttle = (at: string): FallbackThrottleEvidence[] => [{ routeKey: PICKLE, provider: 'opencodeCLI', at,
      detail: 'rateLimited: 429 Too Many Requests, retry-after: 120 seconds' }];
    const elapsed = deriveFallbackChain(setOf(fleet()), { now: NOW, throttles: throttle(hoursAgo(1)) });
    expect(entryFor(elapsed, PICKLE).standing).toBe('inChain');
    const pending = deriveFallbackChain(setOf(fleet()), { now: NOW, throttles: throttle(new Date(NOW.getTime() - 60_000).toISOString()) });
    expect(entryFor(pending, PICKLE).standing).toBe('fallsThrough');
    expect(entryFor(pending, PICKLE).throttles[0]!.reset).toContain('retry-after: 120');
  });

  it('lets a session-scoped throttle on an EXCLUDED sibling reach a candidate, and no other provider', () => {
    const sonnet = record(SONNET, { capabilities: [], lastThrottle: { at: hoursAgo(1), detail: 'You\'ve hit your session limit' } });
    const records = [...fleet(), sonnet];
    const set = setOf(records);
    expect(set.excluded.map((entry) => entry.routeKey)).toContain(SONNET);
    // Read from the candidates alone, Sonnet's throttle is not seen …
    expect(entryFor(deriveFallbackChain(set, { now: NOW }), HAIKU).standing).toBe('inChain');
    // … read from every derived record, as the command does, it reaches Haiku through the one Claude session.
    const chain = deriveFallbackChain(set, { now: NOW, metrics: METRICS, throttles: throttleEvidenceFromRecords(records) });
    expect(entryFor(chain, HAIKU)).toMatchObject({ standing: 'fallsThrough' });
    expect(entryFor(chain, HAIKU).throttles[0]).toMatchObject({ observedOnRoute: SONNET, scope: 'subscriptionSession', scopeDeclared: true });
    expect(entryFor(chain, HAIKU).fallsThroughBecause[0]).toContain(`throttle: ${SONNET} was declined`);
    expect(chain.chain).toEqual([QWEN, GEMMA, PICKLE]);
  });

  it('cannot place an undated throttle in time, so it does not make a route fall through', () => {
    const chain = deriveFallbackChain(setOf(fleet({ [QWEN]: { lastThrottle: { at: '', detail: 'rate limited' } } })), { now: NOW });
    expect(entryFor(chain, QWEN).standing).toBe('inChain');
  });
});

// ------------------------------------------------------------------ advisory, never a selection

describe('the chain is advisory and never a selection', () => {
  it('says so on every answer, beside the candidate set\'s own disclosure, and names no winner', () => {
    const chain = deriveFallbackChain(setOf(fleet()), { now: NOW, metrics: METRICS });
    expect(chain.isSelection).toBe(false);
    expect(chain.disclosure).toBe(FALLBACK_CHAIN_IS_NOT_A_SELECTION);
    expect(chain.disclosure).toContain('not a selection');
    expect(chain.candidateSetDisclosure).toBe(ROUTE_CANDIDATES_ARE_NOT_A_CHOICE);
    for (const forbidden of ['selected', 'selection', 'winner', 'best', 'recommended', 'recommendation', 'score']) {
      expect(Object.keys(chain)).not.toContain(forbidden);
      for (const entry of chain.entries) expect(Object.keys(entry)).not.toContain(forbidden);
    }
  });

  it('writes nothing and leaves the candidate set it was given untouched', () => {
    const set = setOf(fleet({ [QWEN]: { lastThrottle: { at: hoursAgo(1), detail: 'rate limited' } } }));
    const before = JSON.stringify(set);
    deriveFallbackChain(set, { now: NOW, metrics: METRICS });
    expect(JSON.stringify(set)).toBe(before);
  });

  it('imports nothing that can send a request', () => {
    const source = fs.readFileSync(path.join(REPOSITORY, 'src/engine/fallback-chain.ts'), 'utf8');
    expect(source).not.toMatch(/from '(node:)?(child_process|http|https|net|fs)'|fetch\(|spawn\(|-adapter'|-driver'/);
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

describe('cernum candidates --fallback --json', () => {
  it('declares --fallback on candidates', () => {
    expect(acceptedOptions(commandSpec('candidates')!).map((option) => option.name)).toContain('fallback');
  });

  it('answers the chain with every exclusion and its reasons, says it is not a selection, and writes nothing', async () => {
    const root = temporary();
    const observedAt = new Date(Date.now() - 60_000).toISOString();
    appendObservations(root, [routeAvailabilityObservation({ routeKey: HAIKU, machineKey: HERE, machineLabel: 'fixture-host',
      observedAt, available: true, reason: 'signed in (fixture)' }, 'claudeCLI', 'a fixture availability reading')],
    { origin: 'observedHere', receivedAt: observedAt });
    const before = fs.readdirSync(root).sort();

    const result = await cernum('candidates', CAPABILITY, '--fallback', '--json', '--machine', HERE, '--root', root);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const chain = JSON.parse(result.stdout) as FallbackChain;
    expect(chain).toMatchObject({ schema: 'cfc1', contract: 'crc2', isSelection: false, metricsSchema: 'cmr1',
      disclosure: FALLBACK_CHAIN_IS_NOT_A_SELECTION, orderingRule: FALLBACK_ORDERING_RULE });
    expect(chain.query).toMatchObject({ machineKey: HERE, capability: CAPABILITY });
    // No benchmark evidence in the fixture root: nothing to order, and the route is excluded with its reasons.
    expect(chain.chain).toEqual([]);
    expect(chain.excluded.map((entry) => entry.routeKey)).toEqual([HAIKU]);
    expect(chain.excluded[0]!.reasons.length).toBeGreaterThan(0);
    expect(fs.readdirSync(root).sort()).toEqual(before);

    const text = await cernum('candidates', CAPABILITY, '--fallback', '--machine', HERE, '--root', root);
    expect(text.status).toBe(0);
    expect(text.stdout).toContain('Fallback chain cfc1');
    expect(text.stdout).toContain('Chain: none');
    expect(text.stdout.replace(/\s+/g, ' ')).toContain('not a selection');
  });
});
