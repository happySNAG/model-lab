// Limit evidence (cle1): usage-limit and rate-limit events — the matrix circuit breaker's throttle signals
// and the session preflight's throttle state — written as providerAvailability and routeAvailability
// observations with their source, their time and their expected return where known, and read back by
// `availability` and `candidates` so a limited route is unavailable until its evidence expires.
//
// RECORDED FIXTURES ONLY, modelled on the 2026-09-21 usage-limit incident
// (fixtures/limit-evidence/usage-limit-2026-09-21.json). No driver runs, no probe runs and no provider is
// contacted: the signals are built by `detectProviderThrottle` from the recorded observations, and the
// command runs in a subprocess against a temporary root.

import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  LIMIT_EVIDENCE_DEFAULT_WINDOW_MILLISECONDS, LIMIT_EVIDENCE_SCHEMA, LimitEvidenceContext, expectedReturnFrom,
  limitKindOf, limitObservationsFromSessionStatus, limitObservationsFromThrottleSignal, recordLimitEvidence,
  routeKeyOfCandidate,
} from '../../src/engine/limit-evidence';
import {
  ObservationRecord, appendObservations, availabilityLimitsFrom, availabilityObservationsFrom, fleetAvailability,
  readObservationStore, routeAvailabilityObservation, verifyObservationRecord,
} from '../../src/engine/observation-store';
import { RouteAvailabilitySource, availabilityFromStore, qualifiedRouteCandidatesFromStore } from '../../src/engine/routing-contract';
import { RouteQualificationRecord, V1_QUALIFICATION_POLICY } from '../../src/engine/route-qualification';
import { routeSpendPosture } from '../../src/engine/route-spend-posture';
import { measuredQuantity } from '../../src/engine/frontier-metrics';
import { ProviderSessionStatus } from '../../src/engine/provider-session-status';
import { ProviderThrottleSignal, ThrottleObservation, detectProviderThrottle } from '../../src/engine/workspace-throttle';
import { ProviderID } from '../../src/engine/provider';

const REPOSITORY = path.resolve(__dirname, '../..');
const FIXTURE = path.join(REPOSITORY, 'fixtures/limit-evidence/usage-limit-2026-09-21.json');

interface IncidentFixture {
  machine: { machineKey: string; machineLabel: string; timeZone: string };
  otherMachine: { machineKey: string; machineLabel: string };
  ordinaryAvailability: { routeKey: string; provider: ProviderID; observedAt: string; available: boolean; reason: string }[];
  throttleObservations: (ThrottleObservation & { event: string; observedAt: string })[];
  sessionStatuses: (ProviderSessionStatus & { event: string; observedAt: string })[];
}
const INCIDENT = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as IncidentFixture;
const HERE = INCIDENT.machine.machineKey;
const ELSEWHERE = INCIDENT.otherMachine.machineKey;
const ZONE = INCIDENT.machine.timeZone;

const CODEX = 'codexCLI:gpt-6-astra';
const CODEX_MINI = 'codexCLI:gpt-6-astra-mini';
const HAIKU = 'claudeCLI:claude-haiku-4-5';
const SONNET = 'claudeCLI:claude-sonnet-4-5';
const PICKLE = 'opencodeCLI:opencode/big-pickle';
const CAPABILITY = 'workspace:multiFileEditing';

const temporaries: string[] = [];
afterEach(() => { for (const directory of temporaries.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
function temporary(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cernum-limit-evidence-'));
  temporaries.push(directory);
  return directory;
}

const context = (over: Partial<LimitEvidenceContext> = {}): LimitEvidenceContext => ({
  machineKey: HERE, machineLabel: INCIDENT.machine.machineLabel, reportedTimeZone: ZONE,
  provenance: 'cernum workspace-benchmark circuit breaker (fixture usage-limit-2026-09-21)', ...over,
});

function signal(event: string): ProviderThrottleSignal {
  const observation = INCIDENT.throttleObservations.find((entry) => entry.event === event);
  if (observation === undefined) throw new Error(`no fixture event ${event}`);
  const detected = detectProviderThrottle(observation);
  if (detected === undefined) throw new Error(`fixture event ${event} produced no signal`);
  return detected;
}

function sessionStatus(event: string): ProviderSessionStatus & { observedAt: string } {
  const status = INCIDENT.sessionStatuses.find((entry) => entry.event === event);
  if (status === undefined) throw new Error(`no fixture session status ${event}`);
  return status;
}

function ordinaryRecords(machineKey = HERE, machineLabel = INCIDENT.machine.machineLabel): ObservationRecord[] {
  return INCIDENT.ordinaryAvailability.map((entry) => routeAvailabilityObservation({
    routeKey: entry.routeKey, machineKey, machineLabel, observedAt: entry.observedAt, available: entry.available, reason: entry.reason,
  }, entry.provider, 'cernum discovery-refresh (fixture)'));
}

/** A store holding the incident: ordinary availability here and elsewhere, and every limit the incident produced. */
function incidentStore(): string {
  const root = temporary();
  appendObservations(root, [...ordinaryRecords(), ...ordinaryRecords(ELSEWHERE, INCIDENT.otherMachine.machineLabel)],
    { origin: 'observedHere', receivedAt: '2026-09-21T05:00:00Z' });
  for (const event of ['codexUsageLimit', 'openCodeRateLimit', 'claudeSessionLimit', 'codexNotAuthenticated']) {
    recordLimitEvidence(root, limitObservationsFromThrottleSignal(signal(event), context()), '2026-09-22T02:00:00Z');
  }
  return root;
}

const limitBody = (record: ObservationRecord): Record<string, unknown> =>
  (record.body as { limit: Record<string, unknown> }).limit;

// ------------------------------------------------------------------ writing: the circuit breaker's signals

describe('a usage-limit or rate-limit decline is written as provider and route availability observations', () => {
  it('writes the 2026-09-21 Codex usage limit with its source, its time and the provider\'s expected return', () => {
    const outcome = limitObservationsFromThrottleSignal(signal('codexUsageLimit'), context());
    expect(outcome.notWritten).toBeUndefined();
    expect(outcome.records.map((record) => record.kind)).toEqual(['providerAvailability', 'routeAvailability']);
    for (const record of outcome.records) {
      expect(verifyObservationRecord(record).intact).toBe(true);
      expect(record).toMatchObject({ provider: 'codexCLI', machineKey: HERE, observedAt: '2026-09-21T05:40:00Z',
        // 1:55 AM in the reporting machine's zone (CDT, UTC-5) on 2026-09-21.
        expiresAt: '2026-09-21T06:55:00.000Z' });
      expect(record.provenance).toContain('circuit breaker');
      expect(limitBody(record)).toMatchObject({
        schema: LIMIT_EVIDENCE_SCHEMA, kind: 'usageLimit', scope: 'provider', scopeDeclared: false,
        expiresBy: 'expectedReturn', expectedReturn: '2026-09-21T06:55:00.000Z', reported: 'Sep 21st, 2026 1:55 AM',
        failureKind: 'rateLimited', evidenceRecordRoot: 'fixture://usage-limit-2026-09-21/codex/refuse-harm/1',
      });
      expect(String(limitBody(record).source)).toContain('codexCLI:gpt-6-astra@max on refuse-harm repeat 1');
    }
    const route = outcome.records[1]!;
    expect(route.routeKey).toBe(CODEX);
    expect(route.body).toMatchObject({ available: false });
    expect(String((route.body as { reason: string }).reason)).toContain('usage limit');
  });

  it('keeps an unzoned return time as words and expires by the availability window when no zone is named', () => {
    const outcome = limitObservationsFromThrottleSignal(signal('codexUsageLimit'), context({ reportedTimeZone: undefined }));
    const limit = limitBody(outcome.records[0]!);
    expect(limit).toMatchObject({ expiresBy: 'availabilityWindow', reported: 'Sep 21st, 2026 1:55 AM' });
    expect(limit.expectedReturn).toBeUndefined();
    expect(String(limit.expectedReturnBasis)).toContain('printed no zone');
    expect(outcome.records[0]!.expiresAt)
      .toBe(new Date(Date.parse('2026-09-21T05:40:00Z') + LIMIT_EVIDENCE_DEFAULT_WINDOW_MILLISECONDS).toISOString());
  });

  it('writes a rate limit with a retry delay, and a Claude session limit as session-scoped with its printed zone', () => {
    const rate = limitObservationsFromThrottleSignal(signal('openCodeRateLimit'), context());
    expect(rate.records.map((record) => [record.kind, record.routeKey])).toEqual([['providerAvailability', undefined], ['routeAvailability', PICKLE]]);
    expect(limitBody(rate.records[0]!)).toMatchObject({ kind: 'rateLimit', scope: 'provider', expiresBy: 'expectedReturn' });
    expect(rate.records[0]!.expiresAt).toBe('2026-09-21T12:02:00.000Z');

    // Claude printed its own zone, so the caller's zone is not needed — and is not used.
    const session = limitObservationsFromThrottleSignal(signal('claudeSessionLimit'), context({ reportedTimeZone: undefined }));
    expect(session.records.map((record) => record.routeKey)).toEqual([undefined, HAIKU]);
    expect(limitBody(session.records[0]!)).toMatchObject({ kind: 'usageLimit', scope: 'subscriptionSession', scopeDeclared: true,
      expiresBy: 'expectedReturn', reported: 'resets 8:10pm (America/Chicago)' });
    // Observed at 18:52 CDT; the next 8:10pm CDT is 01:10Z on the 22nd.
    expect(session.records[0]!.expiresAt).toBe('2026-09-22T01:10:00.000Z');
  });

  it('writes a route-scoped limit as one routeAvailability record for that route alone', () => {
    const routeScoped: ProviderThrottleSignal = { ...signal('openCodeRateLimit'), scope: 'route', scopeDeclared: true };
    const outcome = limitObservationsFromThrottleSignal(routeScoped, context());
    expect(outcome.records.map((record) => [record.kind, record.routeKey])).toEqual([['routeAvailability', PICKLE]]);
  });

  it('writes nothing for a notAuthenticated decline, and says why', () => {
    const outcome = limitObservationsFromThrottleSignal(signal('codexNotAuthenticated'), context());
    expect(outcome.records).toEqual([]);
    expect(outcome.notWritten).toContain('not a usage or rate limit');
  });

  it('is content-addressed: recording the same event twice writes one set of files', () => {
    const root = temporary();
    const outcome = limitObservationsFromThrottleSignal(signal('codexUsageLimit'), context());
    expect(recordLimitEvidence(root, outcome, '2026-09-21T05:41:00Z').written).toHaveLength(2);
    const again = recordLimitEvidence(root, outcome, '2026-09-21T05:42:00Z');
    expect(again.written).toHaveLength(0);
    expect(again.alreadyPresent).toHaveLength(2);
    expect(readObservationStore(root).corrupt).toEqual([]);
  });
});

// ------------------------------------------------------------------ writing: the session preflight

describe('the session preflight\'s throttle state is written as provider availability', () => {
  const throttled = (over: Partial<ProviderSessionStatus> = {}): ProviderSessionStatus => ({
    ...sessionStatus('claudePreflightNotReported'), throttleState: 'throttled', resetReported: '8:10pm (America/Chicago)', ...over,
  });

  it('writes nothing for notReported — the recorded Claude preflight — and says the absence is not evidence', () => {
    const status = sessionStatus('claudePreflightNotReported');
    const outcome = limitObservationsFromSessionStatus(status, { ...context(), observedAt: status.observedAt });
    expect(outcome.records).toEqual([]);
    expect(outcome.notWritten).toContain('not evidence');
  });

  it('writes throttled as a provider-wide limit with its source, time and reported reset', () => {
    const outcome = limitObservationsFromSessionStatus(throttled(), { ...context(), observedAt: '2026-09-21T23:52:00Z' });
    expect(outcome.records).toHaveLength(1);
    const record = outcome.records[0]!;
    expect(record).toMatchObject({ kind: 'providerAvailability', provider: 'claudeCLI', observedAt: '2026-09-21T23:52:00Z',
      expiresAt: '2026-09-22T01:10:00.000Z' });
    expect(limitBody(record)).toMatchObject({ kind: 'throttleReported', scope: 'subscriptionSession', expiresBy: 'expectedReturn' });
    expect(String(limitBody(record).source)).toContain('claude auth status --json');
  });

  it('writes notThrottled as a lift, and a deferred probe as nothing', () => {
    const lift = limitObservationsFromSessionStatus(throttled({ throttleState: 'notThrottled' }),
      { ...context(), observedAt: '2026-09-22T00:30:00Z' });
    expect(lift.records).toHaveLength(1);
    expect(lift.records[0]!.body).toMatchObject({ limitLifted: { schema: LIMIT_EVIDENCE_SCHEMA } });
    const deferred = limitObservationsFromSessionStatus(throttled({ deferredToLiveRun: true }), { ...context(), observedAt: '2026-09-22T00:30:00Z' });
    expect(deferred.records).toEqual([]);
  });
});

// ------------------------------------------------------------------ reading back: availability

describe('availability reads limit evidence back until it expires', () => {
  const at = (iso: string): Date => new Date(iso);
  const stateOf = (root: string, routeKey: string, machineKey: string, now: string) => fleetAvailability(readObservationStore(root), at(now))
    .find((route) => route.routeKey === routeKey)?.machines.find((machine) => machine.machineKey === machineKey)?.availability;

  it('keeps limit records out of the ordinary observations and reads them back as limits', () => {
    const contents = readObservationStore(incidentStore());
    expect(contents.corrupt).toEqual([]);
    expect(availabilityObservationsFrom(contents).every((entry) => entry.available)).toBe(true);
    const { limits } = availabilityLimitsFrom(contents);
    expect(limits.map((limit) => [limit.provider, limit.routeKey ?? '*', limit.kind]).sort()).toEqual([
      ['claudeCLI', '*', 'usageLimit'], ['claudeCLI', HAIKU, 'usageLimit'],
      ['codexCLI', '*', 'usageLimit'], ['codexCLI', CODEX, 'usageLimit'],
      ['opencodeCLI', '*', 'rateLimit'], ['opencodeCLI', PICKLE, 'rateLimit'],
    ].sort());
    for (const limit of limits) expect(limit.source.length).toBeGreaterThan(0);
  });

  it('shows the Codex routes unavailable until the provider\'s 1:55 AM return, then available again', () => {
    const root = incidentStore();
    const during = stateOf(root, CODEX, HERE, '2026-09-21T06:00:00Z')!;
    expect(during.state).toBe('unavailable');
    expect(during.limit).toMatchObject({ kind: 'usageLimit', expiresAt: '2026-09-21T06:55:00.000Z', expiresBy: 'expectedReturn' });
    expect(during.reason).toContain('usage limit');
    expect(during.reason).toContain('2026-09-21T05:40:00Z');
    expect(during.reason).toContain('2026-09-21T06:55:00.000Z');
    // A provider-scoped limit reaches the sibling route it was not observed on.
    expect(stateOf(root, CODEX_MINI, HERE, '2026-09-21T06:00:00Z')!.state).toBe('unavailable');
    // Other providers, and a limit not yet observed, are untouched.
    expect(stateOf(root, HAIKU, HERE, '2026-09-21T06:00:00Z')!.state).toBe('available');
    expect(stateOf(root, PICKLE, HERE, '2026-09-21T06:00:00Z')!.state).toBe('available');
    // Expired: the ordinary observation decides again.
    const after = stateOf(root, CODEX, HERE, '2026-09-21T06:55:00Z')!;
    expect(after.state).toBe('available');
    expect(after.limit).toBeUndefined();
  });

  it('never carries a limit to another machine', () => {
    const root = incidentStore();
    expect(stateOf(root, CODEX, ELSEWHERE, '2026-09-21T06:00:00Z')!.state).toBe('available');
  });

  it('holds a rate limit for its retry delay and a session limit until its reset', () => {
    const root = incidentStore();
    expect(stateOf(root, PICKLE, HERE, '2026-09-21T12:01:00Z')!.state).toBe('unavailable');
    expect(stateOf(root, PICKLE, HERE, '2026-09-21T12:02:00Z')!.state).toBe('available');
    expect(stateOf(root, SONNET, HERE, '2026-09-22T00:00:00Z')!).toMatchObject({ state: 'unavailable',
      limit: { scope: 'subscriptionSession', routeKey: HAIKU } });
    expect(stateOf(root, SONNET, HERE, '2026-09-22T01:10:00Z')!.state).toBe('available');
  });

  it('lets the provider\'s own notThrottled statement lift a provider-wide limit observed before it', () => {
    const root = incidentStore();
    const status: ProviderSessionStatus = { ...sessionStatus('claudePreflightNotReported'), throttleState: 'notThrottled' };
    recordLimitEvidence(root, limitObservationsFromSessionStatus(status, { ...context(), observedAt: '2026-09-22T00:30:00Z' }),
      '2026-09-22T00:30:00Z');
    expect(stateOf(root, HAIKU, HERE, '2026-09-22T00:15:00Z')!.state).toBe('unavailable');
    expect(stateOf(root, HAIKU, HERE, '2026-09-22T00:45:00Z')!.state).toBe('available');
  });

  it('expires a limit with no placeable return at the end of the availability window', () => {
    const root = temporary();
    appendObservations(root, ordinaryRecords(), { origin: 'observedHere', receivedAt: '2026-09-21T05:00:00Z' });
    recordLimitEvidence(root, limitObservationsFromThrottleSignal(signal('codexUsageLimit'), context({ reportedTimeZone: undefined })),
      '2026-09-21T05:40:00Z');
    expect(stateOf(root, CODEX, HERE, '2026-09-21T07:00:00Z')).toMatchObject({ state: 'unavailable',
      limit: { expiresBy: 'availabilityWindow' } });
    expect(stateOf(root, CODEX, HERE, '2026-09-21T07:00:00Z')!.reason).toContain('could not be placed in time');
  });
});

// ------------------------------------------------------------------ reading back: candidates

function record(routeKey: string): RouteQualificationRecord {
  const at = routeKey.indexOf(':');
  const provider = routeKey.slice(0, at) as ProviderID;
  const modelID = routeKey.slice(at + 1);
  const now = new Date('2026-09-21T23:00:00Z');
  return {
    schema: 'crq1', routeKey, provider, modelID, effort: 'any', policy: V1_QUALIFICATION_POLICY, qualificationScope: 'route',
    discovered: { state: 'currentlyDiscovered', reason: 'observed (fixture)' },
    availableOnThisMachine: { state: 'available', reason: 'installed and signed in (fixture)' },
    identityConfidence: 'verifiedByProvider', bindingIdentityStates: ['verified'], identityAdmitted: false, routingPolicyVersion: 'crp2',
    billing: routeSpendPosture({ provider, modelID, now }),
    evidence: {
      prose: { present: false, candidates: [] }, development: { present: false, candidates: [] },
      workspace: { present: true, runCount: 3, scoredRunCount: 3, packs: ['p'], recordRoots: [] },
    },
    capabilities: [{
      capability: CAPABILITY, source: 'workspace', verdict: 'qualified', scoredRunCount: 3, successCount: 3,
      successRateMilli: measuredQuantity(1000), evidenceRefs: ['case-a'], reason: '3/3 scored runs passed (≥ 90%)',
    }],
    discriminator: [], lastSuccessfulQualificationAt: '2026-09-20T00:00:00Z',
    efficiency: { medianWallClockMilliseconds: measuredQuantity(1000), medianTotalTokens: measuredQuantity(100), basis: 'medians' },
    staleness: { valid: true, reasons: ['qualificationStillValid'], detail: ['nothing moved'] },
    safeToRoute: true, routableCapabilities: [CAPABILITY], notRoutableBecause: [], blockers: [], disclosure: 'no universal score',
  };
}

describe('candidates read limit evidence back', () => {
  it('excludes a session-limited route with the limit as its availability reason, and admits it once the limit expires', () => {
    const contents = readObservationStore(incidentStore());
    const query = { machineKey: HERE, capability: CAPABILITY, costPolicy: 'allowMeteredWithAuthorization' as const };

    const during = qualifiedRouteCandidatesFromStore(query, contents, [{ record: record(HAIKU) }], new Date('2026-09-22T00:00:00Z'));
    expect(during.candidates).toEqual([]);
    const reasons = during.excluded.find((entry) => entry.routeKey === HAIKU)!.reasons;
    const availability = reasons.find((reason) => reason.startsWith('availability:'))!;
    expect(availability).toContain('limit: a usage limit');
    expect(availability).toContain('2026-09-22T01:10:00.000Z');

    const source: RouteAvailabilitySource = availabilityFromStore(contents, HAIKU, HERE, new Date('2026-09-22T00:00:00Z'));
    expect(source).toMatchObject({ state: 'unavailable', limit: { provider: 'claudeCLI', scope: 'subscriptionSession' } });

    const after = qualifiedRouteCandidatesFromStore(query, contents, [{ record: record(HAIKU) }], new Date('2026-09-22T01:10:00Z'));
    expect(after.excluded.flatMap((entry) => entry.reasons).filter((reason) => reason.startsWith('availability:'))).toEqual([]);
    expect(after.candidates.map((candidate) => candidate.routeKey)).toEqual([HAIKU]);
    expect(after.candidates[0]!.availability.limit).toBeUndefined();
  });
});

// ------------------------------------------------------------------ boundaries

describe('reading a provider\'s return time, and the module\'s boundaries', () => {
  it('places only what the provider said, and refuses a return that is not after the observation', () => {
    expect(expectedReturnFrom('try again at Sep 21st, 2026 1:55 AM.', '2026-09-21T05:40:00Z', 'America/Chicago').instant)
      .toBe('2026-09-21T06:55:00.000Z');
    const past = expectedReturnFrom('try again at Sep 21st, 2026 1:55 AM.', '2026-09-21T21:46:39Z', 'America/Chicago');
    expect(past.instant).toBeUndefined();
    expect(past.basis).toContain('not after');
    expect(expectedReturnFrom('resets 8:10pm (Not/AZone)', '2026-09-21T05:40:00Z').instant).toBeUndefined();
    expect(expectedReturnFrom('the request failed', '2026-09-21T05:40:00Z')).toEqual({ basis: 'the provider named no reset or retry time' });
    expect(limitKindOf('You\'ve hit your usage limit')).toBe('usageLimit');
    expect(limitKindOf('429 Too Many Requests')).toBe('rateLimit');
    expect(routeKeyOfCandidate('codexCLI:gpt-6-astra@max')).toBe(CODEX);
    expect(routeKeyOfCandidate('ollama:gemma3:4b')).toBe('ollama:gemma3:4b');
  });

  it('imports nothing that can send a request', () => {
    const source = fs.readFileSync(path.join(REPOSITORY, 'src/engine/limit-evidence.ts'), 'utf8');
    expect(source).not.toMatch(/from '(node:)?(child_process|http|https|net)'|fetch\(|spawn\(|-adapter'|-driver'|runCLI\(/);
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

describe('cernum availability and cernum candidates read limit evidence back', () => {
  it('shows a limited route as unavailable with its limit, and excludes it from candidates with that reason', async () => {
    const root = temporary();
    const observedAt = new Date(Date.now() - 60_000).toISOString();
    appendObservations(root, [routeAvailabilityObservation({ routeKey: HAIKU, machineKey: HERE, machineLabel: 'fixture-host',
      observedAt, available: true, reason: 'signed in (fixture)' }, 'claudeCLI', 'a fixture availability reading')],
    { origin: 'observedHere', receivedAt: observedAt });
    const limited: ProviderThrottleSignal = { ...signal('claudeSessionLimit'),
      detail: 'the CLI reported a failed turn (HTTP 429): You\'ve hit your session limit — retry after 3600 seconds' };
    recordLimitEvidence(root, limitObservationsFromThrottleSignal(limited, context({ observedAt })), observedAt);

    const json = await cernum('availability', '--json', '--machine', HERE, '--root', root);
    expect(json.stderr).toBe('');
    expect(json.status).toBe(0);
    const view = JSON.parse(json.stdout) as { routeKey: string; machines: { availability: { state: string; limit?: { kind: string } } }[] }[];
    expect(view.map((route) => route.routeKey)).toEqual([HAIKU]);
    expect(view[0]!.machines[0]!.availability).toMatchObject({ state: 'unavailable', limit: { kind: 'usageLimit' } });

    const text = await cernum('availability', '--machine', HERE, '--root', root);
    expect(text.status).toBe(0);
    expect(text.stdout).toContain('usage or rate limit(s) in force here');

    const candidates = await cernum('candidates', CAPABILITY, '--json', '--machine', HERE, '--root', root);
    expect(candidates.stderr).toBe('');
    expect(candidates.status).toBe(0);
    const set = JSON.parse(candidates.stdout) as { candidates: unknown[]; excluded: { routeKey: string; reasons: string[] }[] };
    expect(set.candidates).toEqual([]);
    const reasons = set.excluded.find((entry) => entry.routeKey === HAIKU)!.reasons;
    expect(reasons.some((reason) => reason.startsWith('availability:') && reason.includes('limit: a usage limit'))).toBe(true);
  });
});
