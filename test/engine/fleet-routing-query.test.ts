// Pass 8 · the Ordra-facing candidate query, answered against PERSISTED fleet observations.
//
// The question is always "what can run HERE", and "here" is a machine key the caller names. Every
// test below is about the boundary between the two machines: which observations may answer a query
// about which machine, what an exclusion has to say, and what stays untouched while all of it runs.
//
// Nothing here contacts a provider, a runtime or a network.

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  RouteCandidateQuery, availabilityFromStore, qualifiedRouteCandidates, qualifiedRouteCandidatesFromStore,
} from '../../src/engine/routing-contract';
import { RouteQualificationRecord, V1_QUALIFICATION_POLICY } from '../../src/engine/route-qualification';
import { REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE } from '../../src/engine/identity-admission';
import { ROUTED_BUT_NOT_VERIFIED } from '../../src/engine/routing-policy';
import { routeSpendPosture } from '../../src/engine/route-spend-posture';
import { appendObservations, readObservationStore, routeAvailabilityObservation } from '../../src/engine/observation-store';
import { measuredQuantity } from '../../src/engine/frontier-metrics';
import { ZeroMarginalCostConfirmation } from '../../src/engine/cost-eligibility';

const NOW = new Date('2026-09-22T12:00:00Z');
const AT = '2026-09-22T11:00:00Z';
const HERE = 'cmk1:aaaaaaaaaaaaaaaaaaaaaaaa';
const THERE = 'cmk1:bbbbbbbbbbbbbbbbbbbbbbbb';
const CAPABILITY = 'workspace:multiFileEditing';

const temporaries: string[] = [];
afterEach(() => { for (const directory of temporaries.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
function temporary(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cernum-fleet-'));
  temporaries.push(directory);
  return directory;
}

const CONFIRMATION: ZeroMarginalCostConfirmation = {
  provider: 'opencodeCLI', modelID: 'opencode/big-pickle', accountBasis: 'the configured credential',
  observedBillingRecord: 'account usage page, September statement: $0.00', observedAt: '2026-09-21T00:00:00Z',
  confirmedBy: 'the repository owner',
};

function record(over: Partial<RouteQualificationRecord> & Pick<RouteQualificationRecord, 'routeKey' | 'provider' | 'modelID'>):
RouteQualificationRecord {
  return {
    schema: 'crq1', effort: 'none', policy: V1_QUALIFICATION_POLICY, qualificationScope: 'route',
    discovered: { state: 'currentlyDiscovered', reason: 'observed just now' },
    availableOnThisMachine: { state: 'available', reason: 'installed and signed in' },
    identityConfidence: 'verifiedByProvider', bindingIdentityStates: ['verified'], identityAdmitted: false,
    routingPolicyVersion: 'crp2',
    billing: routeSpendPosture({ provider: over.provider, modelID: over.modelID, confirmations: [CONFIRMATION], now: NOW }),
    evidence: {
      prose: { present: false, candidates: [] }, development: { present: false, candidates: [] },
      workspace: { present: true, runCount: 6, scoredRunCount: 6, packs: ['p'], recordRoots: [] },
    },
    capabilities: [{
      capability: CAPABILITY, source: 'workspace', verdict: 'qualified', scoredRunCount: 6, successCount: 6,
      successRateMilli: measuredQuantity(1000), evidenceRefs: ['case-a'], reason: '6/6 scored runs passed (≥ 90%)',
    }],
    discriminator: [],
    efficiency: { medianWallClockMilliseconds: measuredQuantity(1000), medianTotalTokens: measuredQuantity(100), basis: 'medians' },
    staleness: { valid: true, reasons: ['qualificationStillValid'], detail: ['nothing moved'] },
    safeToRoute: true, routableCapabilities: [CAPABILITY], notRoutableBecause: [], blockers: [],
    disclosure: 'no universal score',
    ...over,
  };
}

const LOCAL = record({ routeKey: 'ollama:gemma3:4b', provider: 'ollama', modelID: 'gemma3:4b',
  qualificationScope: 'machine', identityConfidence: 'verifiedByLocalDigest' });
const HOSTED = record({ routeKey: 'claudeCLI:claude-haiku-4-5', provider: 'claudeCLI', modelID: 'claude-haiku-4-5' });
const ADMITTED = record({ routeKey: 'opencodeCLI:opencode/big-pickle', provider: 'opencodeCLI', modelID: 'opencode/big-pickle',
  identityConfidence: 'unverifiableSubstitutionUndetectable', bindingIdentityStates: [REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE],
  identityAdmitted: true, identityDisclosure: ROUTED_BUT_NOT_VERIFIED });

const seen = (routeKey: string, machineKey: string, available: boolean, over: { observedAt?: string; runtimeDigest?: string } = {}) =>
  routeAvailabilityObservation({
    routeKey, machineKey, machineLabel: machineKey === HERE ? 'this-one' : 'the-other',
    observedAt: over.observedAt ?? AT, available, reason: available ? 'installed and signed in' : 'not installed',
    ...(over.runtimeDigest === undefined ? {} : { runtimeDigest: over.runtimeDigest }),
  }, routeKey.startsWith('ollama') ? 'ollama' : routeKey.startsWith('claude') ? 'claudeCLI' : 'opencodeCLI', 'a test');

/** A store holding what each machine saw. Both machines' observations, in one place, on purpose. */
function fleetStore(): string {
  const root = temporary();
  appendObservations(root, [
    seen('ollama:gemma3:4b', HERE, true, { runtimeDigest: 'sha256:aaa' }),
    seen('claudeCLI:claude-haiku-4-5', HERE, true),
    seen('opencodeCLI:opencode/big-pickle', HERE, true),
  ], { origin: 'observedHere', receivedAt: AT });
  appendObservations(root, [
    // The other machine has a local model this one does not, and lacks a CLI this one has.
    seen('ollama:qwen3:8b', THERE, true, { runtimeDigest: 'sha256:zzz' }),
    seen('claudeCLI:claude-haiku-4-5', THERE, false),
    seen('opencodeCLI:opencode/big-pickle', THERE, true),
  ], { origin: 'imported', receivedAt: AT, importedFromMachine: THERE });
  return root;
}

const query = (over: Partial<RouteCandidateQuery> = {}): RouteCandidateQuery => ({
  machineKey: HERE, capability: CAPABILITY, costPolicy: 'zeroMarginalCostOnly', ...over,
});
const reasonsFor = (set: ReturnType<typeof qualifiedRouteCandidates>, routeKey: string): string =>
  (set.excluded.find((entry) => entry.routeKey === routeKey)?.reasons ?? []).join(' | ');

// 29–33 ─────────────────────────────────────────────────────────────────────────────────────────────
describe('29–33 · the query is answered for the machine it names, under the constraints it carries', () => {
  it('29 · uses the REQUESTED machine, and an observation from the other one never answers for this one', () => {
    const root = fleetStore();
    const contents = readObservationStore(root);
    const routes = [{ record: LOCAL }, { record: HOSTED }, { record: ADMITTED }];

    const here = qualifiedRouteCandidatesFromStore(query(), contents, routes, NOW);
    expect(here.candidates.map((entry) => entry.routeKey).sort())
      .toEqual(['claudeCLI:claude-haiku-4-5', 'ollama:gemma3:4b', 'opencodeCLI:opencode/big-pickle']);
    expect(here.candidates.every((entry) => entry.availability.observedOnMachine === HERE)).toBe(true);

    // The SAME store, asked about the other machine, gives a different answer — and gives it from
    // that machine's own observations, not from this machine's.
    const there = qualifiedRouteCandidatesFromStore(query({ machineKey: THERE }), contents, routes, NOW);
    expect(there.candidates.map((entry) => entry.routeKey)).toEqual(['opencodeCLI:opencode/big-pickle']);
    expect(reasonsFor(there, 'claudeCLI:claude-haiku-4-5')).toContain('not installed');
    // gemma3 was observed HERE and never there, so there it has never been observed at all.
    expect(reasonsFor(there, 'ollama:gemma3:4b')).toContain('never been observed from this machine');
    expect(there.candidates[0]!.availability.observedOnMachine).toBe(THERE);
    expect(there.candidates[0]!.availability.origin).toBe('imported');
  });

  it('30 · a local-only query keeps hosted routes out, with the locality reason', () => {
    const contents = readObservationStore(fleetStore());
    const set = qualifiedRouteCandidatesFromStore(query({ localOnly: true }), contents,
      [{ record: LOCAL }, { record: HOSTED }, { record: ADMITTED }], NOW);
    expect(set.candidates.map((entry) => entry.routeKey)).toEqual(['ollama:gemma3:4b']);
    expect(set.candidates[0]!.locality).toBe('local');
    for (const hosted of ['claudeCLI:claude-haiku-4-5', 'opencodeCLI:opencode/big-pickle']) {
      expect(reasonsFor(set, hosted)).toContain('the query is local-only and this route is hosted');
    }
  });

  it('31 · requireVerifiedIdentity removes the admitted route and leaves the verified ones', () => {
    const contents = readObservationStore(fleetStore());
    const routes = [{ record: LOCAL }, { record: HOSTED }, { record: ADMITTED }];
    const strict = qualifiedRouteCandidatesFromStore(query({ requireVerifiedIdentity: true }), contents, routes, NOW);
    expect(strict.candidates.map((entry) => entry.routeKey).sort())
      .toEqual(['claudeCLI:claude-haiku-4-5', 'ollama:gemma3:4b']);
    expect(reasonsFor(strict, 'opencodeCLI:opencode/big-pickle')).toContain('requireVerifiedIdentity');
    // The same route, same store, next query: a candidate again. The fleet did not change.
    expect(qualifiedRouteCandidatesFromStore(query(), contents, routes, NOW)
      .candidates.map((entry) => entry.routeKey)).toContain('opencodeCLI:opencode/big-pickle');
  });

  it('32 · a freshness limit excludes an observation that has aged out, and says which window it missed', () => {
    const root = temporary();
    appendObservations(root, [seen('claudeCLI:claude-haiku-4-5', HERE, true, { observedAt: '2026-09-01T00:00:00Z' })],
      { origin: 'observedHere', receivedAt: AT });
    const contents = readObservationStore(root);
    const set = qualifiedRouteCandidatesFromStore(query(), contents, [{ record: HOSTED }], NOW);
    expect(set.candidates).toHaveLength(0);
    expect(reasonsFor(set, 'claudeCLI:claude-haiku-4-5')).toContain('availability window');

    // A narrower window supplied by the query stales an observation the default would have accepted.
    const recent = temporary();
    appendObservations(recent, [seen('claudeCLI:claude-haiku-4-5', HERE, true)], { origin: 'observedHere', receivedAt: AT });
    const fresh = readObservationStore(recent);
    expect(qualifiedRouteCandidatesFromStore(query(), fresh, [{ record: HOSTED }], NOW).candidates).toHaveLength(1);
    const narrow = qualifiedRouteCandidatesFromStore(
      query({ maximumAvailabilityAgeMilliseconds: 60_000 }), fresh, [{ record: HOSTED }], NOW);
    expect(narrow.candidates).toHaveLength(0);
    expect(reasonsFor(narrow, 'claudeCLI:claude-haiku-4-5')).toContain('re-run discovery here');

    // Stale DISCOVERY and stale QUALIFICATION are separate constraints with separate sentences.
    const staleDiscovery = record({ routeKey: 'claudeCLI:claude-haiku-4-5', provider: 'claudeCLI', modelID: 'claude-haiku-4-5',
      discovered: { state: 'discoveredButStale', reason: 'older than the 7-day discovery window' } });
    expect(reasonsFor(qualifiedRouteCandidatesFromStore(query({ requireFreshDiscovery: true }), fresh,
      [{ record: staleDiscovery }], NOW), 'claudeCLI:claude-haiku-4-5')).toContain('requires fresh discovery');
  });

  it('33 · every exclusion carries EVERY reason, not the first one that matched', () => {
    const contents = readObservationStore(fleetStore());
    const broken = record({
      routeKey: 'opencodeCLI:opencode/big-pickle', provider: 'opencodeCLI', modelID: 'opencode/big-pickle',
      identityConfidence: 'unverifiableSubstitutionUndetectable', identityAdmitted: true,
      capabilities: [{ capability: CAPABILITY, source: 'workspace', verdict: 'notQualified', scoredRunCount: 6,
        successCount: 1, successRateMilli: measuredQuantity(166), evidenceRefs: [], reason: '1/6 scored runs passed (< 90%)' }],
      staleness: { valid: false, reasons: ['staleEvidenceExpired'], detail: ['qualified 2026-06-01, older than 30 days'] },
      blockers: [{ kind: 'staleness', reason: 'qualified 2026-06-01, older than 30 days' }],
      safeToRoute: false, routableCapabilities: [],
    });
    const set = qualifiedRouteCandidatesFromStore(query({ requireVerifiedIdentity: true, minimumContextTokens: 400_000 }),
      contents, [{ record: broken }], NOW);
    const reasons = set.excluded.find((entry) => entry.routeKey === 'opencodeCLI:opencode/big-pickle')!.reasons;
    // Four independent refusals, each stated: identity, staleness, capability, context.
    expect(reasons.some((reason) => reason.includes('requireVerifiedIdentity'))).toBe(true);
    expect(reasons.some((reason) => reason.startsWith('staleness:'))).toBe(true);
    expect(reasons.some((reason) => reason.startsWith('capability:'))).toBe(true);
    expect(reasons.some((reason) => reason.startsWith('context:'))).toBe(true);
    expect(reasons.length).toBeGreaterThanOrEqual(4);
  });
});

// 34 ────────────────────────────────────────────────────────────────────────────────────────────────
describe('34 · a candidate SET, never a winner', () => {
  it('returns every qualified route, orders them by group and key, and scores none of them', () => {
    const contents = readObservationStore(fleetStore());
    const set = qualifiedRouteCandidatesFromStore(query(), contents,
      [{ record: ADMITTED }, { record: LOCAL }, { record: HOSTED }], NOW);
    expect(set.candidates.length).toBeGreaterThan(1);
    // Zero-marginal-cost first, then route key. No rank, no score, no "best" anywhere in the shape.
    expect(set.candidates.map((entry) => entry.routeKey))
      .toEqual(['claudeCLI:claude-haiku-4-5', 'ollama:gemma3:4b', 'opencodeCLI:opencode/big-pickle']);
    expect(set.ordering).toContain('NO preference within a group');
    expect(set.disclosure).toContain('not a choice among them');
    for (const candidate of set.candidates) {
      for (const forbidden of ['score', 'rank', 'best', 'winner', 'recommended']) {
        expect(Object.keys(candidate)).not.toContain(forbidden);
      }
    }
    // Reordering the input does not reorder the output: the answer is a set, not a queue.
    const shuffled = qualifiedRouteCandidatesFromStore(query(), contents,
      [{ record: HOSTED }, { record: ADMITTED }, { record: LOCAL }], NOW);
    expect(shuffled.candidates.map((entry) => entry.routeKey)).toEqual(set.candidates.map((entry) => entry.routeKey));
  });

  it('groups a metered route separately and never lets zero cost substitute for evidence', () => {
    const contents = readObservationStore(fleetStore());
    const metered = record({ routeKey: 'opencodeCLI:opencode/big-pickle', provider: 'opencodeCLI',
      modelID: 'opencode/big-pickle',
      billing: routeSpendPosture({ provider: 'opencodeCLI', modelID: 'opencode/big-pickle', now: NOW,
        overrides: [{ provider: 'opencodeCLI', modelID: 'opencode/big-pickle', overrides: 'metered',
          authorizedBy: 'the owner', authorizedAt: '2026-09-22', reason: 'a benchmark the owner asked for' }] }) });
    const zeroOnly = qualifiedRouteCandidatesFromStore(query(), contents, [{ record: metered }], NOW);
    expect(zeroOnly.candidates).toHaveLength(0);
    expect(reasonsFor(zeroOnly, 'opencodeCLI:opencode/big-pickle')).toContain('admits only zero-marginal-cost routes');

    const allowed = qualifiedRouteCandidatesFromStore(query({ costPolicy: 'allowMeteredWithAuthorization' }),
      contents, [{ record: metered }], NOW);
    expect(allowed.candidates[0]).toMatchObject({ group: 'meteredRequiresAuthorization', requiresSpendingAuthorization: true });

    // A FREE route that is not qualified stays out, however free it is.
    const freeButUnqualified = record({ routeKey: 'opencodeCLI:opencode/big-pickle', provider: 'opencodeCLI',
      modelID: 'opencode/big-pickle', capabilities: [] });
    expect(qualifiedRouteCandidatesFromStore(query(), contents, [{ record: freeButUnqualified }], NOW).candidates)
      .toHaveLength(0);
  });
});

// 36–40 ─────────────────────────────────────────────────────────────────────────────────────────────
describe('36–40 · what this pass did NOT change', () => {
  it('36 · 37 · the OpenCode and Ollama drivers are untouched by any of it', () => {
    const engine = path.resolve(__dirname, '../../src/engine');
    for (const file of ['workspace-opencode-driver.ts', 'workspace-ollama-driver.ts']) {
      const source = fs.readFileSync(path.join(engine, file), 'utf8');
      // No driver imports the fleet, the policy or the store. Execution and governance stay apart.
      for (const forbidden of ['observation-store', 'routing-policy', 'zero-cost-authorization', 'routing-contract']) {
        expect(source).not.toContain(forbidden);
      }
    }
  });

  it('38 · 39 · the Claude and Codex drivers, and cell selection and continuation, import none of it either', () => {
    const engine = path.resolve(__dirname, '../../src/engine');
    for (const file of ['workspace-claude-driver.ts', 'workspace-codex-driver.ts', 'workspace-cell-selection.ts',
      'workspace-continuation.ts', 'workspace-matrix.ts']) {
      const source = fs.readFileSync(path.join(engine, file), 'utf8');
      for (const forbidden of ['observation-store', 'routing-policy', 'zero-cost-authorization']) {
        expect(source).not.toContain(forbidden);
      }
    }
    // And `isRoutable` — the crp1 rule sealed records cite — is still called by ranking and retention,
    // which is where Pass 6 said it would be. crp2 did not reach into either.
    for (const file of ['ranking.ts', 'retention.ts']) {
      const source = fs.readFileSync(path.join(engine, file), 'utf8');
      expect(source).not.toContain('routing-policy');
    }
  });

  it('40 · nothing in this pass can send a request: no adapter, no spawn, no fetch in any new module', () => {
    const engine = path.resolve(__dirname, '../../src/engine');
    for (const file of ['observation-store.ts', 'routing-policy.ts', 'zero-cost-authorization.ts', 'routing-contract.ts']) {
      const source = fs.readFileSync(path.join(engine, file), 'utf8');
      for (const forbidden of [/\bfetch\s*\(/, /child_process/, /\bspawn\s*\(/, /\bexecFile\s*\(/, /buildAdapter/,
        /LiveHost/, /identitySmokeTest/]) {
        expect(source).not.toMatch(forbidden);
      }
    }
  });

  it('resolves availability from the store without deciding anything else about the route', () => {
    const contents = readObservationStore(fleetStore());
    const here = availabilityFromStore(contents, 'ollama:gemma3:4b', HERE, NOW);
    expect(here).toMatchObject({ state: 'available', observedOnMachine: HERE, origin: 'observedHere' });
    const there = availabilityFromStore(contents, 'ollama:gemma3:4b', THERE, NOW);
    expect(there).toMatchObject({ state: 'neverObserved', observedOnMachine: THERE });
    // An imported observation about the other machine is reported AS imported, and as about it.
    const imported = availabilityFromStore(contents, 'ollama:qwen3:8b', THERE, NOW);
    expect(imported).toMatchObject({ state: 'available', observedOnMachine: THERE, origin: 'imported',
      importedFromMachine: THERE });
  });

  // REGRESSION FOUND BY REVIEW OF THIS PASS. Availability is re-decided per machine; qualification
  // is not, and a fresh availability observation must never stand in for a local measurement.
  it('refuses a LOCAL route on a machine other than the one its qualification was measured on', () => {
    const root = temporary();
    // The route is genuinely available on BOTH machines, with different weights on each.
    appendObservations(root, [
      seen('ollama:gemma3:4b', HERE, true, { runtimeDigest: 'sha256:aaa' }),
      seen('ollama:gemma3:4b', THERE, true, { runtimeDigest: 'sha256:zzz' }),
    ], { origin: 'observedHere', receivedAt: AT });
    const contents = readObservationStore(root);
    // A record measured HERE, on this machine's weights.
    const measuredHere = { ...LOCAL, locus: { machineKey: HERE, runtimeDigest: 'sha256:aaa' } };

    expect(qualifiedRouteCandidatesFromStore(query(), contents, [{ record: measuredHere }], NOW)
      .candidates.map((entry) => entry.routeKey)).toEqual(['ollama:gemma3:4b']);

    // The same record, asked about the OTHER machine, where the route is available and the weights
    // are different. Availability says yes; the qualification was never established there.
    const elsewhere = qualifiedRouteCandidatesFromStore(query({ machineKey: THERE }), contents,
      [{ record: measuredHere }], NOW);
    expect(elsewhere.candidates).toHaveLength(0);
    const reasons = reasonsFor(elsewhere, 'ollama:gemma3:4b');
    expect(reasons).toContain('LOCAL route whose qualification was measured on');
    expect(reasons).toContain('Re-qualify on the machine that will run it');

    // A HOSTED route is not refused this way: its qualification is a fact about the route, and only
    // its availability is per machine.
    appendObservations(root, [seen('claudeCLI:claude-haiku-4-5', THERE, true)], { origin: 'observedHere', receivedAt: AT });
    expect(qualifiedRouteCandidatesFromStore(query({ machineKey: THERE }), readObservationStore(root),
      [{ record: HOSTED }], NOW).candidates.map((entry) => entry.routeKey)).toEqual(['claudeCLI:claude-haiku-4-5']);
  });

  it('falls back to the record\'s own availability when the caller resolved none', () => {
    // The pure function is still usable with no store at all, exactly as crc1 was.
    const set = qualifiedRouteCandidates(query(), [{ record: HOSTED }]);
    expect(set.candidates).toHaveLength(1);
    expect(set.candidates[0]!.availability).toMatchObject({ state: 'available', observedOnMachine: HERE, origin: 'observedHere' });
    expect(set.contract).toBe('crc2');
  });
});
