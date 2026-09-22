// Structured model descriptions, discovery refresh and staleness, and machine availability — all pure,
// all driven by fixtures, none of them touching a provider or a runtime.
//
// The OpenCode catalogue entry below is the STRUCTURE of `~/.cache/opencode/models.json` as read on this
// machine (the `opencode` provider's `big-pickle` entry): `tool_call`, `reasoning_options`, `limit`,
// `cost`. Only its structured fields are used; its prose `description` routes nothing.

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  MODEL_DESCRIPTION_SCHEMA, OpenCodeCatalogueEntry, describeDiscoveredRoute, describeLocalModel, valueOf,
  withOpenCodeCatalogueEntry, withPublishedPrice, withZeroMarginalCostConfirmation,
} from '../../src/engine/model-description';
import {
  DiscoverySnapshot, RouteObservation, diffDiscoverySnapshots, observationsFromLocalModels, observationsFromProviderStatus,
  qualificationStaleness, refreshDiscovery, routeFreshness,
} from '../../src/engine/discovery-refresh';
import {
  availabilityOnMachine, machineKey, machinesForRoute, qualificationAppliesOn, qualificationScopeFor, readMachineFingerprint,
} from '../../src/engine/machine-availability';
import { DISCOVERY_EVIDENCE_MAX_AGE_MILLISECONDS } from '../../src/engine/discovery-store';
import { FREE_OPENCODE_DEVELOPMENT_POOL, ProviderStatus } from '../../src/engine/discovery';
import { publishedPriceFor } from '../../src/engine/opencode-pricing';

const NOW = new Date('2026-09-22T12:00:00Z');
const BIG_PICKLE: OpenCodeCatalogueEntry = {
  id: 'big-pickle', name: 'Big Pickle', reasoning: true, reasoning_options: [], tool_call: true,
  limit: { context: 200_000, input: 160_000, output: 32_000 }, cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
};

// MARK: - METADATA (23–27)

describe('23 · 24 · 25 · 26 · 27 · structured descriptions: unknown stays unknown, and every value names its source', () => {
  it('23 · a route nobody described is unknown field by field, never false, zero or empty', () => {
    const description = describeDiscoveredRoute({
      provider: 'opencodeCLI', modelID: 'opencode/some-model', displayName: 'Some Model', availability: 'unproven',
      evidence: 'catalogue', verifiedModelID: '', desiredEfforts: [], discoveredAt: '2026-09-21T00:00:00Z',
    }, { evidenceMaxAgeMilliseconds: DISCOVERY_EVIDENCE_MAX_AGE_MILLISECONDS });
    expect(description.schema).toBe(MODEL_DESCRIPTION_SCHEMA);
    for (const field of ['contextWindowTokens', 'maxOutputTokens', 'toolUse', 'codingAgentic', 'reasoningEffortLevels', 'price'] as const) {
      expect(description[field].state).toBe('unknown');
      expect((description[field] as { reason: string }).reason.length).toBeGreaterThan(0);
    }
    expect(description.billingClass.state).toBe('unknown');
  });

  it('24 · 25 · context, output limit and tool use come from STRUCTURED catalogue fields, labelled as the catalogue\'s claim', () => {
    const base = describeDiscoveredRoute({ provider: 'opencodeCLI', modelID: 'opencode/big-pickle', displayName: 'Big Pickle',
      availability: 'unproven', evidence: 'x', verifiedModelID: '', desiredEfforts: [], discoveredAt: '2026-09-21T00:00:00Z' },
    { evidenceMaxAgeMilliseconds: DISCOVERY_EVIDENCE_MAX_AGE_MILLISECONDS });
    const described = withOpenCodeCatalogueEntry(base, BIG_PICKLE, { source: 'opencode models.json', readAt: '2026-09-20T20:31:54Z' });
    expect(described.contextWindowTokens).toMatchObject({ state: 'known', value: 200_000, observedAt: '2026-09-20T20:31:54Z' });
    expect(described.maxOutputTokens).toMatchObject({ state: 'known', value: 32_000 });
    expect(described.toolUse).toMatchObject({ state: 'known', value: true });
    expect((described.toolUse as { source: string }).source).toContain('catalogue');
    expect(described.reasoningEffortLevels).toMatchObject({ state: 'known', value: [] });
    // Coding intent is only in PROSE in the catalogue, so it stays unknown. Nothing is read off a name.
    expect(described.codingAgentic.state).toBe('unknown');
  });

  it('25 · never infers a capability from a name: a "-coder-free" identifier with no structured field is still unknown', () => {
    const description = describeDiscoveredRoute({ provider: 'opencodeCLI', modelID: 'opencode/super-coder-free', displayName: 'Super Coder Free',
      availability: 'unproven', evidence: 'x', verifiedModelID: '', desiredEfforts: [], discoveredAt: '2026-09-21T00:00:00Z' },
    { evidenceMaxAgeMilliseconds: DISCOVERY_EVIDENCE_MAX_AGE_MILLISECONDS });
    expect(description.codingAgentic.state).toBe('unknown');
    expect(description.toolUse.state).toBe('unknown');
    expect(description.freeStatus.state).toBe('unknown');
    // And the engine's own source never tests a model id for such words.
    const source = fs.readFileSync(path.resolve(__dirname, '../../src/engine/model-description.ts'), 'utf8');
    expect(source).not.toMatch(/modelID\.(includes|match|startsWith|endsWith)\(/);
  });

  it('26 · a published $0 is a published price; only a signed confirmation makes the route free, and each names its evidence', () => {
    const base = describeDiscoveredRoute({ provider: 'opencodeCLI', modelID: 'opencode/big-pickle', displayName: 'Big Pickle',
      availability: 'unproven', evidence: 'x', verifiedModelID: '', desiredEfforts: [], discoveredAt: '2026-09-21T00:00:00Z' },
    { evidenceMaxAgeMilliseconds: DISCOVERY_EVIDENCE_MAX_AGE_MILLISECONDS });
    const priced = withPublishedPrice(base, publishedPriceFor('opencode/big-pickle')!);
    expect(priced.freeStatus).toMatchObject({ state: 'known', value: 'publishedZeroListPrice' });
    expect(priced.billingClass.state).toBe('unknown');
    expect((priced.price as { source: string }).source).toContain('PUBLISHED LIST PRICE');
    const confirmed = withZeroMarginalCostConfirmation(priced, { observedAt: '2026-09-21T10:00:00Z',
      observedBillingRecord: 'account usage page, September statement', confirmedBy: 'the repository owner' });
    expect(confirmed.freeStatus).toMatchObject({ state: 'known', value: 'confirmedZeroMarginalCost', observedAt: '2026-09-21T10:00:00Z' });
    expect(confirmed.billingClass).toMatchObject({ state: 'known', value: 'free_confirmed' });
    expect(confirmed.provenance.join(' ')).toContain('September statement');
  });

  it('27 · a hosted description expires with its discovery evidence; a local one stays current until its digest moves', () => {
    const hosted = describeDiscoveredRoute({ provider: 'claudeCLI', modelID: 'claude-haiku-4-5', displayName: 'Haiku', availability: 'proven',
      evidence: 'smoke', verifiedModelID: 'claude-haiku-4-5', desiredEfforts: ['none'], discoveredAt: '2026-09-20T00:00:00Z' },
    { evidenceMaxAgeMilliseconds: DISCOVERY_EVIDENCE_MAX_AGE_MILLISECONDS });
    expect(valueOf(hosted.expiresAt)).toBe('2026-09-27T00:00:00Z');
    expect(hosted.identityConfidence).toBe('verifiedByProvider');
    const local = describeLocalModel({ modelID: 'gemma3:4b', runtimeDigest: 'sha256:aaa' },
      { machine: 'cmk1:a', observedAt: '2026-09-22T00:00:00Z', endpoint: 'http://127.0.0.1:11434' });
    expect(local.expiresAt.state).toBe('unknown');
    expect(local.identityConfidence).toBe('verifiedByLocalDigest');
  });
});

// MARK: - DISCOVERY DELTA (46–53)

const obs = (modelID: string, over: Partial<RouteObservation> = {}): RouteObservation => ({
  routeKey: `opencodeCLI:${modelID}`, provider: 'opencodeCLI', modelID, listed: true, availability: 'unproven',
  priceFingerprint: 'in:0/out:0', publishedFree: true, contextWindowTokens: 200_000, runtimeVersion: '1.18.31',
  observedAt: '2026-09-21T00:00:00Z', ...over,
});
const snapshot = (routes: RouteObservation[],
  providers: DiscoverySnapshot['providers'] = [{ provider: 'opencodeCLI', refreshed: true, detail: 'ok' }]): DiscoverySnapshot =>
  ({ schema: 'cds1', machineKey: 'cmk1:a', takenAt: '2026-09-21T00:00:00Z', providers, routes });

describe('46–53 · the discovery delta names exactly what moved, and says so when nothing did', () => {
  const kindsOf = (before: DiscoverySnapshot | undefined, after: DiscoverySnapshot, key: string) =>
    diffDiscoverySnapshots(before, after).find((delta) => delta.routeKey === key)!;

  it('46 · a new model', () => {
    const delta = kindsOf(snapshot([]), snapshot([obs('opencode/big-pickle')]), 'opencodeCLI:opencode/big-pickle');
    expect(delta.kinds).toEqual(['newlyDiscovered']);
    expect(delta.qualificationNowStale).toBe(false);
  });

  it('47 · a removed model, which stales its qualification', () => {
    const delta = kindsOf(snapshot([obs('opencode/union-alpha')]), snapshot([obs('opencode/union-alpha', { listed: false })]), 'opencodeCLI:opencode/union-alpha');
    expect(delta.kinds).toEqual(['disappeared']);
    expect(delta.qualificationNowStale).toBe(true);
  });

  it('48 · a model that returned', () => {
    const delta = kindsOf(snapshot([obs('opencode/union-alpha', { listed: false })]), snapshot([obs('opencode/union-alpha')]), 'opencodeCLI:opencode/union-alpha');
    expect(delta.kinds).toEqual(['returned']);
  });

  it('49 · 50 · a price change and a free-status change', () => {
    const delta = kindsOf(snapshot([obs('opencode/big-pickle')]),
      snapshot([obs('opencode/big-pickle', { priceFingerprint: 'in:500000/out:2000000', publishedFree: false })]), 'opencodeCLI:opencode/big-pickle');
    expect(delta.kinds).toEqual(['priceChanged', 'freeStatusChanged']);
    expect(delta.detail.join(' ')).toContain('in:0/out:0 → in:500000/out:2000000');
    expect(delta.qualificationNowStale).toBe(true);
  });

  it('51 · a context change', () => {
    const delta = kindsOf(snapshot([obs('opencode/big-pickle')]), snapshot([obs('opencode/big-pickle', { contextWindowTokens: 128_000 })]),
      'opencodeCLI:opencode/big-pickle');
    expect(delta.kinds).toEqual(['contextChanged']);
  });

  it('52 · a runtime digest change on a local route', () => {
    const local = (digest: string): RouteObservation => ({ routeKey: 'ollama:gemma3:4b', provider: 'ollama', modelID: 'gemma3:4b',
      listed: true, availability: 'installedLocally', runtimeDigest: digest, observedAt: '2026-09-21T00:00:00Z' });
    const delta = kindsOf(snapshot([local('sha256:a')], [{ provider: 'ollama', refreshed: true, detail: 'ok' }]),
      snapshot([local('sha256:b')], [{ provider: 'ollama', refreshed: true, detail: 'ok' }]), 'ollama:gemma3:4b');
    expect(delta.kinds).toEqual(['runtimeDigestChanged']);
    expect(delta.qualificationNowStale).toBe(true);
  });

  it('53 · no material change is an answer, not an absence', () => {
    const delta = kindsOf(snapshot([obs('opencode/big-pickle')]), snapshot([obs('opencode/big-pickle', { observedAt: '2026-09-22T00:00:00Z' })]),
      'opencodeCLI:opencode/big-pickle');
    expect(delta.kinds).toEqual(['noMaterialChange']);
    expect(delta.qualificationNowStale).toBe(false);
  });

  it('a provider that did not answer is NOT read as every model disappearing', async () => {
    const previous = snapshot([obs('opencode/big-pickle')]);
    const { snapshot: next, deltas } = await refreshDiscovery({
      previous, machineKey: 'cmk1:a', now: NOW,
      probes: { opencodeCLI: async () => { throw new Error('opencode timed out'); } },
    });
    expect(next.routes).toEqual(previous.routes);
    expect(deltas[0].kinds).toEqual(['notRefreshed']);
    expect(deltas[0].qualificationNowStale).toBe(false);
  });

  it('refresh carries an unnamed route forward as listed:false, so a return can be seen later', async () => {
    const previous = snapshot([obs('opencode/big-pickle'), obs('opencode/union-alpha')]);
    const { snapshot: next, deltas } = await refreshDiscovery({
      previous, machineKey: 'cmk1:a', now: NOW,
      probes: { opencodeCLI: async () => ({ refreshed: true, detail: 'ok', routes: [obs('opencode/big-pickle')] }) },
    });
    expect(next.routes.find((route) => route.modelID === 'opencode/union-alpha')?.listed).toBe(false);
    expect(deltas.find((delta) => delta.routeKey.endsWith('union-alpha'))?.kinds).toEqual(['disappeared']);
    await expect(refreshDiscovery({ previous, machineKey: 'cmk1:b', now: NOW, probes: {} })).rejects.toThrow(/never diffed across machines/);
  });

  it('reads existing discovery output into observations without guessing: Union Alpha stays not listed', () => {
    const status: ProviderStatus = {
      provider: 'opencodeCLI', label: 'OpenCode', executionClass: 'meteredAPI', billingBasis: 'meteredAPI', reachability: 'ready',
      detail: 'x', probe: 'invoked', version: '1.18.31', checkedAt: '2026-09-20T00:00:00Z',
      models: [
        { provider: 'opencodeCLI', modelID: 'opencode/big-pickle', displayName: 'Big Pickle', availability: 'unproven', evidence: 'listed',
          verifiedModelID: '', desiredEfforts: ['none'], discoveredAt: '2026-09-20T00:00:00Z' },
        { provider: 'opencodeCLI', modelID: 'opencode/union-alpha', displayName: 'Union Alpha', availability: 'refused', evidence: 'not named',
          verifiedModelID: '', desiredEfforts: ['none'], discoveredAt: '2026-09-20T00:00:00Z' },
      ],
    };
    const observations = observationsFromProviderStatus(status, FREE_OPENCODE_DEVELOPMENT_POOL.map((entry) => publishedPriceFor(entry.modelID)!));
    expect(observations.find((entry) => entry.modelID === 'opencode/union-alpha')?.listed).toBe(false);
    expect(observations.find((entry) => entry.modelID === 'opencode/big-pickle')).toMatchObject({ listed: true, publishedFree: true, priceFingerprint: 'in:0/out:0' });
    expect(observationsFromLocalModels([{ modelID: 'gemma3:4b', runtimeDigest: 'sha256:a' }], '2026-09-22T00:00:00Z')[0])
      .toMatchObject({ routeKey: 'ollama:gemma3:4b', listed: true, runtimeDigest: 'sha256:a' });
  });
});

describe('6 · staleness distinguishes every way a route or its qualification can go out of date', () => {
  it('currently discovered · discovered but stale · unavailable · no longer listed · never discovered', () => {
    const current = snapshot([obs('a/fresh', { observedAt: '2026-09-21T00:00:00Z' }), obs('a/old', { observedAt: '2026-08-01T00:00:00Z' }),
      obs('a/refused', { availability: 'refused' }), obs('a/gone', { listed: false })]);
    expect(routeFreshness(current, 'opencodeCLI:a/fresh', NOW).state).toBe('currentlyDiscovered');
    expect(routeFreshness(current, 'opencodeCLI:a/old', NOW).state).toBe('discoveredButStale');
    expect(routeFreshness(current, 'opencodeCLI:a/refused', NOW).state).toBe('unavailable');
    expect(routeFreshness(current, 'opencodeCLI:a/gone', NOW).state).toBe('noLongerListed');
    expect(routeFreshness(current, 'opencodeCLI:a/never', NOW).state).toBe('neverDiscovered');
  });

  it('qualification stale because the model materially changed · the route changed · the digest changed · still valid', () => {
    const basis = { routeKey: 'opencodeCLI:opencode/big-pickle', qualifiedAt: '2026-09-20T00:00:00Z', driverID: 'driver.opencode-cli.workspace',
      driverVersion: '1.18.31', priceFingerprint: 'in:0/out:0', publishedFree: true, contextWindowTokens: 200_000 };
    const context = { driverID: 'driver.opencode-cli.workspace', driverVersion: '1.18.31', now: NOW };
    expect(qualificationStaleness(basis, obs('opencode/big-pickle'), context)).toMatchObject({ valid: true, reasons: ['qualificationStillValid'] });
    expect(qualificationStaleness(basis, obs('opencode/big-pickle', { publishedFree: false, priceFingerprint: 'in:1/out:1' }), context).reasons)
      .toEqual(['staleModelMateriallyChanged']);
    expect(qualificationStaleness(basis, obs('opencode/big-pickle'), { ...context, driverVersion: '1.19.0' }).reasons).toEqual(['staleRouteChanged']);
    expect(qualificationStaleness(basis, obs('opencode/big-pickle', { listed: false }), context).reasons).toEqual(['staleRouteNoLongerAvailable']);
    expect(qualificationStaleness(basis, obs('opencode/big-pickle'), { ...context, now: new Date('2026-11-30T00:00:00Z') }).reasons)
      .toEqual(['staleEvidenceExpired']);
  });
});

// MARK: - CROSS MACHINE (28–31)

describe('28–31 · availability is per machine, and a local qualification does not travel', () => {
  const A = 'cmk1:machine-a';
  const B = 'cmk1:machine-b';
  const seen = (routeKey: string, machine: string, available: boolean, digest?: string) => ({
    routeKey, machineKey: machine, machineLabel: machine, observedAt: '2026-09-22T10:00:00Z', available,
    reason: available ? 'installed and signed in' : 'not installed', ...(digest === undefined ? {} : { runtimeDigest: digest }),
  });

  it('28 · the same remote route on two machines: one qualification, availability observed on each', () => {
    const observations = [seen('claudeCLI:claude-haiku-4-5', A, true), seen('claudeCLI:claude-haiku-4-5', B, false)];
    expect(availabilityOnMachine(observations, 'claudeCLI:claude-haiku-4-5', A, NOW).state).toBe('available');
    expect(availabilityOnMachine(observations, 'claudeCLI:claude-haiku-4-5', B, NOW).state).toBe('unavailable');
    expect(qualificationScopeFor('claudeCLI')).toBe('route');
    expect(qualificationAppliesOn({ provider: 'claudeCLI', machineKey: A }, { machineKey: B }).applies).toBe(true);
    expect(machinesForRoute(observations, 'claudeCLI:claude-haiku-4-5', NOW)).toHaveLength(2);
  });

  it('29 · a local route available on only one machine; the other has never observed it', () => {
    const observations = [seen('ollama:gemma3:4b', A, true, 'sha256:a')];
    expect(availabilityOnMachine(observations, 'ollama:gemma3:4b', A, NOW).state).toBe('available');
    expect(availabilityOnMachine(observations, 'ollama:gemma3:4b', B, NOW).state).toBe('neverObserved');
    expect(qualificationScopeFor('ollama')).toBe('machine');
    expect(qualificationAppliesOn({ provider: 'ollama', machineKey: A, runtimeDigest: 'sha256:a' }, { machineKey: B, runtimeDigest: 'sha256:a' }))
      .toMatchObject({ applies: false });
  });

  it('30 · a stale local digest on the same machine requires requalification; a stale observation is stale', () => {
    expect(qualificationAppliesOn({ provider: 'ollama', machineKey: A, runtimeDigest: 'sha256:a' }, { machineKey: A, runtimeDigest: 'sha256:b' }).reason)
      .toContain('requalifyOnThisMachine');
    expect(qualificationAppliesOn({ provider: 'ollama', machineKey: A, runtimeDigest: 'sha256:a' }, { machineKey: A, runtimeDigest: 'sha256:a' }).applies)
      .toBe(true);
    const old = [{ ...seen('ollama:gemma3:4b', A, true), observedAt: '2026-09-19T00:00:00Z' }];
    expect(availabilityOnMachine(old, 'ollama:gemma3:4b', A, NOW).state).toBe('stale');
  });

  it('31 · machines are identified by what they report, and no machine name is written into the engine', () => {
    const fingerprint = readMachineFingerprint();
    expect(machineKey(fingerprint)).toMatch(/^cmk1:[0-9a-f]{24}$/);
    expect(machineKey({ ...fingerprint, totalMemoryBytes: fingerprint.totalMemoryBytes + 1 })).not.toBe(machineKey(fingerprint));
    const engine = path.resolve(__dirname, '../../src/engine');
    for (const file of ['machine-availability.ts', 'route-qualification.ts', 'routing-contract.ts', 'discovery-refresh.ts',
      'workspace-ollama-driver.ts', 'workspace-opencode-driver.ts', 'model-description.ts', 'route-spend-posture.ts']) {
      const source = fs.readFileSync(path.join(engine, file), 'utf8');
      expect(source).not.toMatch(/mac ?mini|macbook/i);
    }
  });
});
