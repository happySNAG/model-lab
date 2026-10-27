// Substitution quarantine (csq1): a route with a recorded identity substitution — an identity smoke's
// `substituted` verdict, or an ingested Ordra outcome whose reported model is not the requested one — enters a
// sealed quarantine with its evidence, is excluded from candidates, recommend (crr1, crr2) and the fallback chain
// with the reason `quarantined`, and leaves only through an explicit, recorded release. Nothing is dropped.
//
// FIXTURES ONLY. Records are hand-written, the smoke is read from a fake response by `readSmoke`, outcomes come
// from fixtures/route-outcomes, and the command runs in a subprocess against a temporary root. Nothing is contacted.

import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ROUTE_QUARANTINE_DISCLOSURE, ROUTE_QUARANTINE_RULE, RouteQuarantineError, RouteQuarantineList, RouteQuarantineReleaseResult,
  listRouteQuarantine, outcomeSubstitutionQuarantines, recordOutcomeSubstitutionQuarantines, recordRouteQuarantineRelease,
  recordSmokeSubstitutionQuarantines, routeQuarantineEntriesFrom, routeQuarantineReleasesFrom, routeQuarantineStatus,
  smokeSubstitutionQuarantine,
} from '../../src/engine/route-quarantine';
import { ingestRouteOutcomeFile, ingestRouteOutcomes, routeOutcomesFrom } from '../../src/engine/route-outcome-ingest';
import {
  OBSERVATION_KINDS, ObservationStoreContents, appendObservations, readObservationStore, routeAvailabilityObservation,
  verifyObservationRecord,
} from '../../src/engine/observation-store';
import { readSmoke } from '../../src/engine/identity-smoke';
import { buildSmokeBinding } from '../../src/engine/smoke-binding';
import {
  RouteAvailabilitySource, RouteForQuery, qualifiedRouteCandidates, qualifiedRouteCandidatesFromStore,
} from '../../src/engine/routing-contract';
import { recommendRoutes } from '../../src/engine/route-recommendation';
import { Crr2Recommendation, recommendRoutesCrr2 } from '../../src/engine/route-recommendation-crr2';
import { deriveFallbackChain } from '../../src/engine/fallback-chain';
import { CapabilityQualification, RouteQualificationRecord, V1_QUALIFICATION_POLICY } from '../../src/engine/route-qualification';
import { routeSpendPosture } from '../../src/engine/route-spend-posture';
import { measuredQuantity } from '../../src/engine/frontier-metrics';
import { ModelDescription, known } from '../../src/engine/model-description';
import { ProviderID } from '../../src/engine/provider';
import { acceptedOptions, commandSpec } from '../../src/cli/command-spec';

const REPOSITORY = path.resolve(__dirname, '../..');
const OUTCOMES = path.join(REPOSITORY, 'fixtures', 'route-outcomes', 'ordra-route-telemetry.jsonl');
const NOW = new Date('2026-10-26T12:00:00Z');
const LATER = new Date('2026-10-27T12:00:00Z');
const HERE = 'cmk1:quarantine-machine';
const LABEL = 'fixture-host';
const CAPABILITY = 'workspace:multiFileEditing';
const TIER = 'workspace-tier:tier2';
const hoursAgo = (hours: number): string => new Date(NOW.getTime() - hours * 3_600_000).toISOString();

const HAIKU = 'claudeCLI:claude-haiku-4-5';
const SONNET = 'claudeCLI:claude-sonnet-5';
const GEMMA = 'ollama:gemma3:4b';

const temporaries: string[] = [];
afterEach(() => { for (const directory of temporaries.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
function temporary(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cernum-quarantine-'));
  temporaries.push(directory);
  return directory;
}
const files = (root: string): string[] => fs.existsSync(root) ? fs.readdirSync(root, { recursive: true }).map(String).sort() : [];

// ------------------------------------------------------------------ fixtures

/** One identity smoke, read from a fake response: `reported` is what the provider said answered. */
function smoke(requested: string, reported: string, attemptedAt = '2026-10-24T09:00:00Z') {
  return readSmoke(buildSmokeBinding({ provider: 'claudeCLI', modelID: requested, effort: 'none', pricing: null }), {
    answerText: 'ok', reportedModelID: reported, usage: {}, usageProvenance: 'unavailable',
    totalElapsedMilliseconds: 800, retryCount: 0, wastedTokens: 0,
  }, attemptedAt);
}

/** An outcome line in the cro1 shape. */
const line = (over: Record<string, unknown> = {}): string => JSON.stringify({
  pass: 'P-7001', attempt: 1, provider: 'claudeCLI', requestedModel: 'claude-haiku-4-5', actualModel: 'claude-sonnet-5',
  verification: 'passed', tokens: 10, durationMilliseconds: 1000, recordedAt: '2026-10-25T10:00:00Z', ...over,
});

const qualified = (capability: string): CapabilityQualification => ({
  capability, source: 'workspace', verdict: 'qualified', scoredRunCount: 3, successCount: 3,
  successRateMilli: measuredQuantity(1000), evidenceRefs: ['case-a'], reason: '3/3 scored runs passed (≥ 90%)',
});

/** A qualified, identity-proven, unexpired route record. */
function record(routeKey: string): RouteQualificationRecord {
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
  };
}

const available = (): RouteAvailabilitySource => ({
  state: 'available', observedOnMachine: HERE, machineLabel: LABEL, origin: 'observedHere',
  observedAt: hoursAgo(1), reason: 'installed and signed in',
});
const WIDE = ({ contextWindowTokens: known(200_000, 'fixture catalogue'), locality: 'remote' }) as unknown as ModelDescription;

/** HAIKU and GEMMA, both qualified; quarantine resolved from the store as the CLI resolves it. */
function fleet(contents: ObservationStoreContents): RouteForQuery[] {
  return [GEMMA, HAIKU].map((routeKey) => ({ record: record(routeKey), description: WIDE, availability: available(),
    quarantine: routeQuarantineStatus(contents, routeKey) }));
}

const QUERY = { machineKey: HERE, capability: CAPABILITY, costPolicy: 'zeroMarginalCostOnly' as const };
const REQUEST = { machineKey: HERE, taskType: 'implement', tier: 2, contextTokens: 32_000 };

/** A root whose store holds one substituted HAIKU outcome (requested haiku, reported sonnet), quarantined. */
function quarantinedRoot(): string {
  const root = temporary();
  ingestRouteOutcomes(root, Buffer.from(`${line()}\n`), { machineKey: HERE, machineLabel: LABEL, now: NOW });
  recordOutcomeSubstitutionQuarantines(root, readObservationStore(root), { receivedAt: NOW.toISOString() });
  return root;
}

// ------------------------------------------------------------------ entering quarantine

describe('csq1 · a recorded substitution enters a sealed quarantine with its evidence', () => {
  it('declares two new observation kinds and its own rule, distinct from the qualification schema', () => {
    expect(ROUTE_QUARANTINE_RULE).toBe('csq1');
    expect(OBSERVATION_KINDS).toEqual(expect.arrayContaining(['routeQuarantine', 'routeQuarantineRelease']));
  });

  it('quarantines the requested route of a substituted smoke, and nothing for any other verdict', () => {
    expect(smokeSubstitutionQuarantine(smoke('claude-haiku-4-5', 'claude-haiku-4-5'))).toBeUndefined();
    expect(smokeSubstitutionQuarantine(smoke('claude-haiku-4-5', ''))).toBeUndefined();
    const entry = smokeSubstitutionQuarantine(smoke('claude-haiku-4-5', 'claude-sonnet-5'))!;
    expect(entry).toMatchObject({ rule: 'csq1', routeKey: HAIKU, provider: 'claudeCLI', cause: 'smokeSubstituted',
      quarantinedAt: '2026-10-24T09:00:00Z' });
    expect(entry.evidence).toEqual([expect.objectContaining({ kind: 'identitySmoke', requestedModel: 'claude-haiku-4-5',
      actualModel: 'claude-sonnet-5', observedAt: '2026-10-24T09:00:00Z', reference: expect.stringMatching(/^identitySmoke:[0-9a-f]{64}$/) })]);

    const root = temporary();
    const written = recordSmokeSubstitutionQuarantines(root, [smoke('claude-haiku-4-5', 'claude-haiku-4-5'),
      smoke('claude-haiku-4-5', 'claude-sonnet-5')], { machineKey: HERE, machineLabel: LABEL, receivedAt: NOW.toISOString() });
    expect(written).toEqual([expect.objectContaining({ routeKey: HAIKU, cause: 'smokeSubstituted', written: true })]);
    const contents = readObservationStore(root);
    const stored = routeQuarantineEntriesFrom(contents);
    expect(stored).toHaveLength(1);
    expect(verifyObservationRecord(stored[0]!.stored.record).intact).toBe(true);
    expect(stored[0]!.stored.record).toMatchObject({ kind: 'routeQuarantine', machineKey: HERE, observedAt: '2026-10-24T09:00:00Z' });
    // No record-level route: the qualification timeline and the availability views select on it.
    expect(stored[0]!.stored.record.routeKey).toBeUndefined();
    expect(routeQuarantineStatus(contents, HAIKU)).toMatchObject({ state: 'quarantined', routeKey: HAIKU });
  });

  it('quarantines the requested route of an ingested outcome whose actual model differs, referencing that outcome', () => {
    const root = temporary();
    const ingest = ingestRouteOutcomeFile(root, OUTCOMES, { machineKey: HERE, machineLabel: LABEL, now: NOW });
    expect(ingest.substitutions.map((entry) => entry.routeKey)).toEqual([SONNET]);
    const written = recordOutcomeSubstitutionQuarantines(root, readObservationStore(root), { receivedAt: NOW.toISOString() });
    const outcome = routeOutcomesFrom(readObservationStore(root)).find(({ outcome: held }) => held.identity === 'substituted')!;
    expect(written).toEqual([{ recordID: expect.any(String), routeKey: SONNET, cause: 'outcomeSubstituted',
      evidence: [`routeOutcome:${outcome.stored.record.recordID}`], written: true }]);
    const status = routeQuarantineStatus(readObservationStore(root), SONNET);
    expect(status.state).toBe('quarantined');
    expect(status.active[0]!.evidence[0]).toMatchObject({ kind: 'routeOutcome', pass: 'P-9001', attempt: 2,
      requestedModel: 'claude-sonnet-5', actualModel: 'claude-haiku-4-5', observedAt: '2026-10-20T11:00:00Z' });
    // Matched and unreported outcomes quarantine nothing.
    expect(routeQuarantineStatus(readObservationStore(root), HAIKU).state).toBe('clear');
    expect(routeQuarantineStatus(readObservationStore(root), 'codexCLI:gpt-5-codex').state).toBe('clear');
  });

  it('is idempotent: recording the same findings again writes nothing', () => {
    const root = quarantinedRoot();
    const before = files(root);
    const again = recordOutcomeSubstitutionQuarantines(root, readObservationStore(root), { receivedAt: LATER.toISOString() });
    expect(again.map((entry) => entry.written)).toEqual([false]);
    const smokeAgain = () => recordSmokeSubstitutionQuarantines(root, [smoke('claude-haiku-4-5', 'claude-sonnet-5')],
      { machineKey: HERE, machineLabel: LABEL, receivedAt: LATER.toISOString() });
    expect(smokeAgain()[0]!.written).toBe(true);
    const withSmoke = files(root);
    expect(withSmoke.length).toBe(before.length + 1);
    expect(smokeAgain()[0]!.written).toBe(false);
    expect(files(root)).toEqual(withSmoke);
  });

  it('derives an outcome entry under the outcome\'s own observer, so any machine derives the same record', () => {
    const root = quarantinedRoot();
    const derived = outcomeSubstitutionQuarantines(readObservationStore(root));
    expect(derived).toHaveLength(1);
    expect(derived[0]).toMatchObject({ machineKey: HERE, machineLabel: LABEL, entry: { routeKey: HAIKU, cause: 'outcomeSubstituted' } });
  });
});

// ------------------------------------------------------------------ excluded everywhere routing is answered

describe('csq1 · a quarantined route is excluded from candidates, recommend and fallback with reason quarantined', () => {
  it('candidates (crc2): excluded with a `quarantined:` reason naming its evidence; the shape is unchanged', () => {
    const clear = qualifiedRouteCandidates(QUERY, fleet(readObservationStore(temporary())));
    expect(clear.candidates.map((candidate) => candidate.routeKey)).toEqual([HAIKU, GEMMA]);
    expect(clear.excluded).toEqual([]);

    const contents = readObservationStore(quarantinedRoot());
    const set = qualifiedRouteCandidates(QUERY, fleet(contents));
    expect(set.contract).toBe('crc2');
    expect(Object.keys(set).sort()).toEqual(Object.keys(clear).sort());
    expect(set.candidates.map((candidate) => candidate.routeKey)).toEqual([GEMMA]);
    expect(set.excluded).toHaveLength(1);
    expect(set.excluded[0]!.routeKey).toBe(HAIKU);
    const reason = set.excluded[0]!.reasons.find((text) => text.startsWith('quarantined:'))!;
    expect(reason).toContain('substitution quarantine');
    expect(reason).toContain('requested claude-haiku-4-5, answered claude-sonnet-5');
    expect(reason).toContain('cernum quarantine release claudeCLI:claude-haiku-4-5 --reason');
    // An exclusion, never a verdict: the record still says qualified.
    expect(set.excluded[0]!.reasons).toHaveLength(1);
    expect(record(HAIKU).capabilities[0]!.verdict).toBe('qualified');
  });

  it('candidates from a store resolve quarantine on their own', () => {
    const root = quarantinedRoot();
    appendObservations(root, [GEMMA, HAIKU].map((routeKey) => routeAvailabilityObservation({ routeKey, machineKey: HERE,
      machineLabel: LABEL, observedAt: hoursAgo(1), available: true, reason: 'signed in (fixture)' },
    routeKey.split(':')[0] as ProviderID, 'a fixture availability reading')), { origin: 'observedHere', receivedAt: hoursAgo(1) });
    const set = qualifiedRouteCandidatesFromStore(QUERY, readObservationStore(root),
      [GEMMA, HAIKU].map((routeKey) => ({ record: record(routeKey), description: WIDE })), NOW);
    expect(set.candidates.map((candidate) => candidate.routeKey)).toEqual([GEMMA]);
    expect(set.excluded.find((entry) => entry.routeKey === HAIKU)!.reasons.some((text) => text.startsWith('quarantined:'))).toBe(true);
  });

  it('recommend crr1 and crr2: never ranked, listed as excluded with the reason', () => {
    const contents = readObservationStore(quarantinedRoot());
    const crr1 = recommendRoutes(REQUEST, { now: NOW, routes: fleet(contents) });
    if (!crr1.ok) throw new Error(crr1.refusals.join('; '));
    expect(crr1.ranking.map((entry) => entry.routeKey)).toEqual([GEMMA]);
    expect(crr1.excluded.find((entry) => entry.routeKey === HAIKU)!.reasons.some((text) => text.startsWith('quarantined:'))).toBe(true);
    expect(crr1.fallback.chain).toEqual([GEMMA]);

    const crr2 = recommendRoutesCrr2(REQUEST, { now: NOW, routes: fleet(contents) }) as Crr2Recommendation;
    expect(crr2.ok).toBe(true);
    expect(crr2.ranking.map((entry) => entry.routeKey)).toEqual([GEMMA]);
    expect(crr2.selected?.routeKey).toBe(GEMMA);
    expect(crr2.exclusions.find((entry) => entry.routeKey === HAIKU)!.reasons.some((text) => text.startsWith('quarantined:'))).toBe(true);
    expect(crr2.fallback.chain.some((key) => key.startsWith(HAIKU))).toBe(false);
  });

  it('fallback (cfc1): the quarantined route is in neither the chain nor its entries, and its exclusion keeps the reason', () => {
    const contents = readObservationStore(quarantinedRoot());
    const chain = deriveFallbackChain(qualifiedRouteCandidates(QUERY, fleet(contents)), { now: NOW });
    expect(chain.chain).toEqual([GEMMA]);
    expect(chain.entries.map((entry) => entry.routeKey)).toEqual([GEMMA]);
    expect(chain.excluded.find((entry) => entry.routeKey === HAIKU)!.reasons.some((text) => text.startsWith('quarantined:'))).toBe(true);
  });
});

// ------------------------------------------------------------------ leaving quarantine, only on the record

describe('csq1 · a route leaves quarantine only through an explicit, recorded release; nothing is dropped', () => {
  it('appends a release naming every entry in force, and the route routes again; the entries stay', () => {
    const root = quarantinedRoot();
    const entriesBefore = routeQuarantineEntriesFrom(readObservationStore(root)).map(({ stored }) => stored.record);
    const released = recordRouteQuarantineRelease(root, readObservationStore(root), HAIKU, 'provider confirmed the alias; re-smoked',
      { machineKey: HERE, machineLabel: LABEL, now: LATER });
    expect(released).toMatchObject({ routeKey: HAIKU, reason: 'provider confirmed the alias; re-smoked', releasedAt: LATER.toISOString(),
      releases: entriesBefore.map((entry) => entry.recordID), state: { state: 'released', active: [] } });

    const contents = readObservationStore(root);
    // Nothing deleted: every entry is still in the store, byte for byte, beside the release.
    expect(routeQuarantineEntriesFrom(contents).map(({ stored }) => stored.record)).toEqual(entriesBefore);
    const releases = routeQuarantineReleasesFrom(contents);
    expect(releases).toHaveLength(1);
    expect(verifyObservationRecord(releases[0]!.stored.record).intact).toBe(true);
    expect(routeQuarantineStatus(contents, HAIKU).entries[0]!.releasedBy).toMatchObject({ recordID: released.recordID });

    const set = qualifiedRouteCandidates(QUERY, fleet(contents));
    expect(set.candidates.map((candidate) => candidate.routeKey)).toEqual([HAIKU, GEMMA]);
  });

  it('is never released by re-recording the same finding, and a new substitution quarantines it again', () => {
    const root = quarantinedRoot();
    recordRouteQuarantineRelease(root, readObservationStore(root), HAIKU, 'checked', { machineKey: HERE, machineLabel: LABEL, now: LATER });
    // The same outcome, recorded again: same record, still released.
    recordOutcomeSubstitutionQuarantines(root, readObservationStore(root), { receivedAt: LATER.toISOString() });
    expect(routeQuarantineStatus(readObservationStore(root), HAIKU).state).toBe('released');
    // A later substitution is new evidence the release did not name.
    ingestRouteOutcomes(root, Buffer.from(`${line({ pass: 'P-7002', recordedAt: '2026-10-28T10:00:00Z' })}\n`),
      { machineKey: HERE, machineLabel: LABEL, now: LATER });
    recordOutcomeSubstitutionQuarantines(root, readObservationStore(root), { receivedAt: LATER.toISOString() });
    const again = routeQuarantineStatus(readObservationStore(root), HAIKU);
    expect(again.state).toBe('quarantined');
    expect(again.active.map((entry) => entry.evidence[0]!.pass)).toEqual(['P-7002']);
    expect(again.entries).toHaveLength(2);
  });

  it('refuses, writing nothing, a release with no reason, of an unreadable route, or of a route with nothing in force', () => {
    const root = quarantinedRoot();
    const before = files(root);
    const release = (routeKey: string, reason: string) => () => recordRouteQuarantineRelease(root, readObservationStore(root), routeKey,
      reason, { machineKey: HERE, machineLabel: LABEL, now: LATER });
    expect(release(HAIKU, '  ')).toThrow(RouteQuarantineError);
    expect(release('haiku', 'why')).toThrow(/not a route key/);
    expect(release(`${HAIKU}@high`, 'why')).toThrow(/not a route key/);
    expect(release(GEMMA, 'why')).toThrow(/nothing to release/);
    expect(files(root)).toEqual(before);
  });

  it('lists every route with any entry, in force or released, with its evidence', () => {
    const root = quarantinedRoot();
    recordSmokeSubstitutionQuarantines(root, [smoke('claude-sonnet-5', 'claude-haiku-4-5')],
      { machineKey: HERE, machineLabel: LABEL, receivedAt: NOW.toISOString() });
    recordRouteQuarantineRelease(root, readObservationStore(root), SONNET, 'released for the test', { machineKey: HERE, machineLabel: LABEL, now: LATER });
    const list = listRouteQuarantine(readObservationStore(root));
    expect(list).toMatchObject({ schema: 'csq1', quarantined: [HAIKU], disclosure: ROUTE_QUARANTINE_DISCLOSURE });
    expect(list.routes.map((route) => [route.routeKey, route.state])).toEqual([[HAIKU, 'quarantined'], [SONNET, 'released']]);
    expect(list.routes[1]!.releases[0]).toMatchObject({ reason: 'released for the test' });
  });
});

// ------------------------------------------------------------------ the commands, in a subprocess

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

describe('cernum quarantine list | release, and ingest-outcomes', () => {
  it('is declared as a local write with --reason, --machine and --json', () => {
    const spec = commandSpec('quarantine')!;
    expect(spec.effect).toBe('writesLocal');
    expect(acceptedOptions(spec).map((option) => option.name)).toEqual(expect.arrayContaining(['reason', 'machine', 'json', 'root']));
  });

  it('ingest-outcomes quarantines the substituted route; list shows it; release records and never deletes', async () => {
    const root = temporary();
    const ingest = await cernum('ingest-outcomes', OUTCOMES, '--json', '--machine', HERE, '--root', root);
    expect(ingest.stderr).toBe('');
    expect(ingest.status).toBe(0);
    const ingested = JSON.parse(ingest.stdout) as { routeQuarantine: { routeKey: string; written: boolean }[] };
    expect(ingested.routeQuarantine).toEqual([expect.objectContaining({ routeKey: SONNET, cause: 'outcomeSubstituted', written: true })]);

    const listed = await cernum('quarantine', 'list', '--json', '--root', root);
    expect(listed.status).toBe(0);
    const list = JSON.parse(listed.stdout) as RouteQuarantineList;
    expect(list.quarantined).toEqual([SONNET]);
    expect(list.routes[0]!.active[0]!.evidence[0]).toMatchObject({ kind: 'routeOutcome', requestedModel: 'claude-sonnet-5' });

    const refused = await cernum('quarantine', 'release', SONNET, '--root', root);
    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain('--reason');
    const before = files(root);

    const released = await cernum('quarantine', 'release', SONNET, '--reason', 'owner checked the alias', '--json', '--machine', HERE, '--root', root);
    expect(released.stderr).toBe('');
    expect(released.status).toBe(0);
    const release = JSON.parse(released.stdout) as RouteQuarantineReleaseResult;
    expect(release).toMatchObject({ routeKey: SONNET, reason: 'owner checked the alias', state: { state: 'released' } });
    const after = files(root);
    for (const file of before) expect(after).toContain(file);
    expect(after.length).toBeGreaterThan(before.length);

    const twice = await cernum('quarantine', 'release', SONNET, '--reason', 'again', '--root', root);
    expect(twice.status).toBe(2);
    expect(twice.stderr).toContain('nothing to release');

    // Ingesting again writes nothing, and does not undo the release.
    const again = await cernum('ingest-outcomes', OUTCOMES, '--json', '--machine', HERE, '--root', root);
    expect(again.status).toBe(0);
    expect((JSON.parse(again.stdout) as { routeQuarantine: { written: boolean }[] }).routeQuarantine.map((entry) => entry.written)).toEqual([false]);
    expect(files(root)).toEqual(after);
    const finally_ = JSON.parse((await cernum('quarantine', 'list', '--json', '--root', root)).stdout) as RouteQuarantineList;
    expect(finally_.quarantined).toEqual([]);
    expect(finally_.routes.map((route) => route.state)).toEqual(['released']);
  }, 120_000);

  it('refuses an unknown action with exit 2', async () => {
    const root = temporary();
    const result = await cernum('quarantine', 'purge', '--root', root);
    expect(result.status).toBe(2);
    expect(files(root)).toEqual([]);
  }, 60_000);
});
