// Benchmark engine · LIMIT EVIDENCE (cle1): a usage limit or a rate limit, written down as availability.
//
// WHY THIS EXISTS. Two parts of this engine already see a limit and both forgot it at exit. The session
// preflight (`provider-session-status.ts`) can report a `SessionThrottleState`; the matrix circuit breaker
// (`workspace-throttle.ts`) builds a `ProviderThrottleSignal` the moment a provider declines. Both lived for
// the length of one command, so `availability` and `candidates` went on answering "available" for a route
// whose provider had just said, in so many words, that it would serve nothing until 1:55 AM. That is the
// 2026-09-21 incident in its routing form: sixty-nine Codex attempts answered "You've hit your usage
// limit … try again at Sep 21st, 2026 1:55 AM", and nothing durable said the route was out until then.
//
// WHAT THIS DOES. It turns each event into sealed observation records in the existing append-only store —
// a `providerAvailability` record for a limit that reaches a whole provider or session, a
// `routeAvailability` record for the route it was observed on — each carrying its SOURCE, its TIME and,
// where the provider named one that can be placed in time, its EXPECTED RETURN as the record's
// `expiresAt`. Where no return can be placed, the limit expires at the end of the ordinary availability
// window, and the record says that is why. `availability` and `candidates` read them back through
// `availabilityLimitsFrom` and `applyAvailabilityLimits`: a limited route is unavailable until its
// evidence expires, and then the ordinary observations decide again.
//
// WHAT IT DOES NOT DO. It sends nothing to any provider and runs nothing: its inputs are a status object and
// a signal somebody else already produced. It never converts a plan name into an allowance, never guesses
// a zone for a clock time the provider printed without one unless the caller names the zone of the machine
// that printed it, and it writes nothing for `notReported` — a tool that reports no throttle state is not
// evidence of one. A `notAuthenticated` decline is not a limit and is not written as one either.

import { CanonicalValue } from './canonical';
import { AVAILABILITY_OBSERVATION_MAX_AGE_MILLISECONDS, AvailabilityLimit } from './machine-availability';
import { ObservationRecord, appendObservations, sealObservation } from './observation-store';
import type { ProviderSessionStatus } from './provider-session-status';
import { isPlanExhausted } from './attempt-disposition';
import { ProviderThrottleSignal, ThrottleScope, parseThrottleReset, providerThrottleScopeFor } from './workspace-throttle';

export const LIMIT_EVIDENCE_SCHEMA = 'cle1';

/** How long a limit with no placeable expected return holds a route unavailable: the availability window. */
export const LIMIT_EVIDENCE_DEFAULT_WINDOW_MILLISECONDS = AVAILABILITY_OBSERVATION_MAX_AGE_MILLISECONDS;

/** Who observed the event, and how to say so. */
export interface LimitEvidenceContext {
  machineKey: string;
  machineLabel: string;
  /** What established it, in words a person can check: the command and the record it came from. */
  provenance: string;
  /** When the event was observed. Overrides the signal's own time when the caller has a truer one. */
  observedAt?: string;
  /**
   * The IANA zone of the machine whose CLI printed the message. Used ONLY to place a clock time the
   * provider printed without a zone (`try again at Sep 21st, 2026 1:55 AM`), because that CLI formats in
   * its own machine's zone. A zone the provider printed itself always wins. Absent: such a time is kept as
   * words and the limit expires by the availability window.
   */
  reportedTimeZone?: string;
}

export interface LimitEvidenceOutcome {
  records: ObservationRecord[];
  /** Why nothing was written, when nothing was. Never silent. */
  notWritten?: string;
}

/** When the provider said it would serve again, as an instant where that is possible. */
export interface ExpectedReturn {
  /** The provider's own words, verbatim and trimmed. */
  reported?: string;
  /** The instant, when the words could be placed in time. */
  instant?: string;
  /** How the instant was placed, or why it could not be. */
  basis: string;
}

// MARK: - Reading a provider's return time

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Minutes the zone is ahead of UTC at this instant, or undefined for a zone this runtime does not know. */
function zoneOffsetMinutes(instant: number, zone: string): number | undefined {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(instant));
    const part = (type: string): number => Number(parts.find((entry) => entry.type === type)?.value);
    const local = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second'));
    return Number.isNaN(local) ? undefined : Math.round((local - Math.floor(instant / 1000) * 1000) / 60_000);
  } catch {
    return undefined;
  }
}

/** The instant a wall-clock time names in a zone. Twice through the offset, so a DST edge lands right. */
function wallClockInZone(year: number, month: number, day: number, hour: number, minute: number, zone: string): number | undefined {
  const naive = Date.UTC(year, month, day, hour, minute);
  const first = zoneOffsetMinutes(naive, zone);
  if (first === undefined) return undefined;
  const second = zoneOffsetMinutes(naive - first * 60_000, zone);
  return second === undefined ? undefined : naive - second * 60_000;
}

/** The calendar day an instant falls on in a zone. */
function dayInZone(instant: number, zone: string): { year: number; month: number; day: number } | undefined {
  const offset = zoneOffsetMinutes(instant, zone);
  if (offset === undefined) return undefined;
  const local = new Date(instant + offset * 60_000);
  return { year: local.getUTCFullYear(), month: local.getUTCMonth(), day: local.getUTCDate() };
}

function hour24(hour: number, meridiem: string | undefined): number | undefined {
  if (meridiem === undefined) return hour <= 23 ? hour : undefined;
  if (hour < 1 || hour > 12) return undefined;
  const pm = meridiem.toLowerCase() === 'pm';
  return hour === 12 ? (pm ? 12 : 0) : pm ? hour + 12 : hour;
}

/**
 * When a provider's decline says it will serve again — read from its own words, never invented.
 *
 * Three shapes are placed in time: a delay (`retry after 30 seconds`), a clock time with a zone the
 * provider printed (`resets 8:10pm (America/Chicago)`, the next such time after the observation), and a
 * full date (`try again at Sep 21st, 2026 1:55 AM`) in the zone the provider printed or, failing that, the
 * reporting machine's zone the caller named. Anything else is kept as words with no instant. An instant
 * that is not after the observation cannot bound it, and is reported but not used.
 */
export function expectedReturnFrom(detail: string, observedAt: string, reportedTimeZone?: string): ExpectedReturn {
  const observed = Date.parse(observedAt);
  if (Number.isNaN(observed)) return { basis: 'the observation has no readable time, so no return can be placed after it' };
  const withInstant = (reported: string, instant: number | undefined, how: string): ExpectedReturn => {
    if (instant === undefined) return { reported, basis: `the provider said "${reported}", which could not be placed in time: ${how}` };
    if (instant <= observed) {
      return { reported, basis: `the provider said "${reported}", which places at ${new Date(instant).toISOString()} — not after `
        + `the observation at ${observedAt}, so it cannot bound it` };
    }
    return { reported, instant: new Date(instant).toISOString(), basis: how };
  };

  // 1. A FULL DATE: "try again at Sep 21st, 2026 1:55 AM", optionally with "(Zone/Name)".
  const dated = /try again (?:at|after)\s+([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\s+(\d{1,2}):(\d{2})\s*([AaPp][Mm])?(?:\s*\(([A-Za-z_]+(?:\/[A-Za-z_+-]+)+|UTC)\))?/
    .exec(detail);
  if (dated !== null) {
    const reported = dated[0].replace(/^try again (?:at|after)\s+/i, '').trim();
    const month = MONTHS.indexOf(dated[1].toLowerCase());
    const hour = hour24(Number(dated[4]), dated[6]);
    const zone = dated[7] ?? reportedTimeZone;
    if (month < 0 || hour === undefined) return withInstant(reported, undefined, 'the date is not one this reader understands');
    if (zone === undefined) {
      return withInstant(reported, undefined, 'the provider printed no zone and no zone was named for the machine that printed it');
    }
    const instant = wallClockInZone(Number(dated[3]), month, Number(dated[2]), hour, Number(dated[5]), zone);
    return withInstant(reported, instant, instant === undefined ? `the zone ${zone} is not one this runtime knows`
      : `the provider's date, read in ${zone}${dated[7] === undefined ? ' (the reporting machine\'s zone, named by the caller)' : ' (as printed)'}`);
  }

  const reset = parseThrottleReset(detail);
  if (reset === undefined) return { basis: 'the provider named no reset or retry time' };

  // 2. A DELAY: "retry after 30 seconds".
  if (reset.retryAfterSeconds !== undefined) {
    return withInstant(reset.reported, observed + reset.retryAfterSeconds * 1000,
      `the observation time plus the ${reset.retryAfterSeconds} s the provider named`);
  }

  // 3. A CLOCK TIME: "resets 8:10pm (America/Chicago)" — the next such time after the observation.
  const clock = /^(\d{1,2})(?::(\d{2}))?\s*([AaPp][Mm])?\s*(?:\(([A-Za-z_]+(?:\/[A-Za-z_+-]+)+|UTC)\))?/.exec(reset.resetsAt ?? '');
  if (clock === null) return withInstant(reset.reported, undefined, 'the reset time is not a clock time this reader understands');
  const hour = hour24(Number(clock[1]), clock[3]);
  const zone = clock[4] ?? reportedTimeZone;
  if (hour === undefined) return withInstant(reset.reported, undefined, 'the reset hour is not a valid clock hour');
  if (zone === undefined) {
    return withInstant(reset.reported, undefined, 'the provider printed no zone and no zone was named for the machine that printed it');
  }
  const today = dayInZone(observed, zone);
  if (today === undefined) return withInstant(reset.reported, undefined, `the zone ${zone} is not one this runtime knows`);
  let instant = wallClockInZone(today.year, today.month, today.day, hour, Number(clock[2] ?? 0), zone);
  if (instant !== undefined && instant <= observed) {
    instant = wallClockInZone(today.year, today.month, today.day + 1, hour, Number(clock[2] ?? 0), zone);
  }
  return withInstant(reset.reported, instant, `the next ${clock[0].trim()} after the observation, read in ${zone}`
    + `${clock[4] === undefined ? ' (the reporting machine\'s zone, named by the caller)' : ' (as printed)'}`);
}

// MARK: - Writing

/** A usage limit says the allowance is spent; anything else that throttled is a rate limit. */
export function limitKindOf(detail: string): 'usageLimit' | 'rateLimit' {
  // `isPlanExhausted` is the engine's one list of allowance-spent markers. A subscription SESSION limit is
  // the same fact for a Claude session — spent until a named reset — and is named here beside it.
  return isPlanExhausted(detail) || /\bsession limit\b/i.test(detail) ? 'usageLimit' : 'rateLimit';
}

/** The route a matrix candidate ran on: `provider:model@effort` without the effort, as routes are keyed. */
export function routeKeyOfCandidate(candidate: string): string {
  return candidate.replace(/@[^:@]*$/, '');
}

function expiryOf(observedAt: string, expected: ExpectedReturn): { expiresAt: string; expiresBy: AvailabilityLimit['expiresBy'] } {
  if (expected.instant !== undefined) return { expiresAt: expected.instant, expiresBy: 'expectedReturn' };
  return {
    expiresAt: new Date(Date.parse(observedAt) + LIMIT_EVIDENCE_DEFAULT_WINDOW_MILLISECONDS).toISOString(),
    expiresBy: 'availabilityWindow',
  };
}

function limitBody(fields: {
  kind: AvailabilityLimit['kind']; scope: ThrottleScope; scopeDeclared: boolean; source: string;
  expected: ExpectedReturn; expiresBy: AvailabilityLimit['expiresBy']; failureKind?: string; evidenceRecordRoot?: string;
}): CanonicalValue {
  return {
    schema: LIMIT_EVIDENCE_SCHEMA, kind: fields.kind, scope: fields.scope, scopeDeclared: fields.scopeDeclared,
    source: fields.source, expiresBy: fields.expiresBy, expectedReturnBasis: fields.expected.basis,
    ...(fields.expected.instant === undefined ? {} : { expectedReturn: fields.expected.instant }),
    ...(fields.expected.reported === undefined ? {} : { reported: fields.expected.reported }),
    ...(fields.failureKind === undefined ? {} : { failureKind: fields.failureKind }),
    ...(fields.evidenceRecordRoot === undefined ? {} : { evidenceRecordRoot: fields.evidenceRecordRoot }),
  };
}

/**
 * A decline the matrix circuit breaker recorded, as availability evidence.
 *
 * A `route`-scoped signal becomes one `routeAvailability` record for that route. A `provider` or
 * `subscriptionSession` signal becomes a `providerAvailability` record for the provider AND a
 * `routeAvailability` record for the route it was observed on, both carrying the same limit. Only a
 * `rateLimited` decline is a limit; a `notAuthenticated` one is about the login, has no return time,
 * and is refused with that reason.
 */
export function limitObservationsFromThrottleSignal(signal: ProviderThrottleSignal, context: LimitEvidenceContext): LimitEvidenceOutcome {
  if (signal.failureKind !== 'rateLimited') {
    return { records: [], notWritten: `${signal.failureKind} is not a usage or rate limit: it says nothing about when the `
      + 'provider will serve again, so it is not written as limit evidence' };
  }
  const observedAt = context.observedAt ?? signal.observedAt;
  const expected = expectedReturnFrom(signal.detail, observedAt, context.reportedTimeZone);
  const { expiresAt, expiresBy } = expiryOf(observedAt, expected);
  const kind = limitKindOf(signal.detail);
  const routeKey = routeKeyOfCandidate(signal.observedOnCandidate);
  const source = `the ${signal.provider} decline returned to ${signal.observedOnCandidate} on ${signal.observedOnCaseID} `
    + `repeat ${signal.observedOnRepeatIndex}, sealed in ${signal.observedInRecordRoot}`;
  const body = limitBody({ kind, scope: signal.scope, scopeDeclared: signal.scopeDeclared, source, expected, expiresBy,
    failureKind: signal.failureKind, evidenceRecordRoot: signal.observedInRecordRoot });
  const common = { machineKey: context.machineKey, machineLabel: context.machineLabel, observedAt,
    provenance: context.provenance, provider: signal.provider, expiresAt };
  const route = sealObservation({ ...common, kind: 'routeAvailability', routeKey,
    body: { available: false, reason: signal.detail, limit: body } as CanonicalValue });
  if (signal.scope === 'route') return { records: [route] };
  const provider = sealObservation({ ...common, kind: 'providerAvailability',
    body: { answered: true, detail: signal.detail, limit: body } as CanonicalValue });
  return { records: [provider, route] };
}

/**
 * What a provider's own session probe said about throttling, as availability evidence.
 *
 * `throttled` is a limit reaching every route of the provider, as far as its declared throttle scope
 * reaches. `notThrottled` is a LIFT: it clears provider-wide limits observed before it. `notReported` —
 * the honest answer for every CLI this build probes — is not evidence of anything and writes nothing.
 * A probe that did not succeed writes nothing either: an unanswered question is not an answer.
 */
export function limitObservationsFromSessionStatus(status: ProviderSessionStatus,
                                                   context: LimitEvidenceContext & { observedAt: string }): LimitEvidenceOutcome {
  if (status.deferredToLiveRun === true) {
    return { records: [], notWritten: 'the session probe was deferred to the live run, so it said nothing yet' };
  }
  if (status.throttleState === 'notReported') {
    return { records: [], notWritten: `${status.provider} reports no throttle state to a non-model command (${status.probe}), `
      + 'and the absence of a report is not evidence of a limit or of its absence' };
  }
  const source = `${status.provider}'s own session probe, ${status.probe}`;
  const common = { machineKey: context.machineKey, machineLabel: context.machineLabel, observedAt: context.observedAt,
    provenance: context.provenance, provider: status.provider };
  if (status.throttleState === 'notThrottled') {
    return { records: [sealObservation({ ...common, kind: 'providerAvailability',
      body: { answered: true, detail: `${status.provider} reports that it is not throttled`,
        limitLifted: { schema: LIMIT_EVIDENCE_SCHEMA, source } } as CanonicalValue })] };
  }
  const reportedReset = status.resetReported;
  const expected = reportedReset === undefined ? { basis: 'the provider named no reset time' }
    : expectedReturnFrom(/reset|retry|try again/i.test(reportedReset) ? reportedReset : `resets ${reportedReset}`,
      context.observedAt, context.reportedTimeZone);
  const { expiresAt, expiresBy } = expiryOf(context.observedAt, expected);
  const decision = providerThrottleScopeFor(status.provider);
  return { records: [sealObservation({ ...common, kind: 'providerAvailability', expiresAt,
    body: { answered: true, detail: `${status.provider} reports that it is currently throttled`
      + `${reportedReset === undefined ? '' : ` (${reportedReset})`}`,
    limit: limitBody({ kind: 'throttleReported', scope: decision.scope, scopeDeclared: decision.declared, source,
      expected, expiresBy }) } as CanonicalValue })] };
}

/**
 * Append limit evidence to the store, as this machine's own observations.
 *
 * The same append every other observation goes through: content-addressed, so recording the same event
 * twice writes one file, and a record that does not verify is refused rather than written.
 */
export function recordLimitEvidence(root: string, outcome: LimitEvidenceOutcome, receivedAt: string):
  ReturnType<typeof appendObservations> {
  return appendObservations(root, outcome.records, { origin: 'observedHere', receivedAt });
}

/** The lines a person reads about limit evidence that was just recorded, or why none was. */
export function describeLimitEvidence(outcome: LimitEvidenceOutcome): string[] {
  if (outcome.records.length === 0) return [`limit evidence  none written — ${outcome.notWritten ?? 'nothing to record'}`];
  return outcome.records.map((record) => {
    const limit = (record.body as { limit?: { kind?: string; scope?: string; expiresBy?: string } }).limit;
    if (limit === undefined) return `limit evidence  ${record.kind} for ${record.provider ?? '?'}: the limit is LIFTED`;
    return `limit evidence  ${record.kind} ${record.routeKey ?? record.provider ?? ''} · ${limit.kind} · ${limit.scope}-scoped `
      + `· unavailable until ${record.expiresAt ?? '?'} (${limit.expiresBy === 'expectedReturn' ? 'the provider\'s expected return'
        : 'the availability window; no placeable return time'})`;
  });
}
