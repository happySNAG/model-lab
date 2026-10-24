// Benchmark engine · AN ADVISORY FALLBACK CHAIN over a candidate set, by one versioned rule, written nowhere.
//
// WHAT IT IS. `qualifiedRouteCandidates` answers "which routes does the evidence qualify for this query",
// as a SET. This module puts that set in the order a consumer would try them if the one before it could
// not take the work — and says, for every qualified route, why it stands where it stands. The order is
// decided by ONE rule, `cfc1`, using recorded evidence only and in this precedence:
//
//   1. zero marginal cost before metered — the candidate set's own groups, unchanged;
//   2. qualification freshness — the newest passing run (`lastSuccessfulQualificationAt`) first, a route
//      that recorded none after every route that did;
//   3. the metrics rollup (cmr1) for the queried capability — the lower failure rate first, then the lower
//      nearest-rank p90 wall clock; a figure that is unknown sorts after every figure that is known;
//   4. route key, so the order is total and the same evidence always gives the same chain.
//
// FALL-THROUGH. A qualified route whose AVAILABILITY on the queried machine is not `available`, or which a
// throttle (a rate-limit or usage-limit decline a sealed run recorded) still reaches at `now`, keeps its
// position and is marked `fallsThrough` with the reason; the chain proper continues with the next route.
// A throttle reaches routes as far as `providerThrottleScopeFor` says the provider's throttles reach, and it
// stops speaking to `now` when any of these is true: the reached route passed a run after it; the provider
// named a retry-after delay and it has elapsed; or it is older than `FALLBACK_THROTTLE_MAX_AGE_MILLISECONDS`.
// A reset CLOCK TIME the provider named is kept verbatim and never parsed — it carries its own zone.
//
// WHAT IT IS NOT, AND EACH OF THESE IS A RULE.
//
//   NOT A SELECTION. Nothing here picks a route, and the output says so on every answer. Whether to try the
//   first route, and what to do when it fails, is Ordra's scheduling decision.
//   NOT A RECOMMENDATION RANKING AND NOT A SCORE. No figure is combined with another; each step only breaks
//   the ties the step before it left. No route that the candidate set excluded is let back in, and none of
//   the ordering evidence can move a route between the zero-marginal-cost and metered groups.
//   NOT A WRITER. It takes values and returns a value.

import { compareCodePoints } from './canonical';
import { Quantity, quantityValue, unavailableQuantity } from './frontier-metrics';
import { AVAILABILITY_OBSERVATION_MAX_AGE_MILLISECONDS } from './machine-availability';
import { METRICS_ROLLUP_SCHEMA, MetricsRollup } from './metrics-rollup';
import { ProviderID } from './provider';
import { RouteQualificationRecord } from './route-qualification';
import { RouteCandidate, RouteCandidateSet } from './routing-contract';
import { RoutingPolicyVersion } from './routing-policy';
import { ThrottleScope, parseThrottleReset, providerThrottleScopeFor, throttleBlocks } from './workspace-throttle';

/** The ordering and fall-through rule. Changing either means a new version. */
export const FALLBACK_CHAIN_RULE_VERSION = 'cfc1';

export const FALLBACK_ORDERING_RULE =
  'cfc1: zero-marginal-cost group before metered; then the newest passing qualification run first (none recorded sorts '
  + 'last); then, from the metrics rollup for the queried capability, the lower failure rate first and then the lower '
  + 'p90 wall clock (an unknown figure sorts after every known one); then route key. A route whose availability here is '
  + 'not available, or which a recorded throttle still reaches, keeps its place and falls through to the next.';

export const FALLBACK_CHAIN_IS_NOT_A_SELECTION =
  'This is an ADVISORY fallback order over the qualified candidate set, not a selection: Cernum has chosen no route, '
  + 'and nothing here says the first route should be used. It orders only routes the evidence already qualified, by '
  + 'the stated rule, from recorded evidence alone; every route the candidate set excluded stays excluded, with its '
  + 'reasons. Whether and when to try each route is the consumer\'s decision.';

/** How long a recorded throttle keeps speaking to `now` when nothing else lifted it: the availability window. */
export const FALLBACK_THROTTLE_MAX_AGE_MILLISECONDS = AVAILABILITY_OBSERVATION_MAX_AGE_MILLISECONDS;

/** One throttle a sealed run recorded, as the route's qualification record carries it. */
export interface FallbackThrottleEvidence {
  routeKey: string;
  provider: ProviderID;
  at: string;
  detail: string;
}

export interface FallbackChainInputs {
  /** The instant the chain is answered for. Throttle windows are measured to it. */
  now: Date;
  /** The rollup the metrics step reads. Absent: every metric is unknown and the step orders nothing. */
  metrics?: MetricsRollup;
  /**
   * Every recorded throttle the caller holds, INCLUDING those on routes the candidate set excluded — a
   * provider-scoped throttle observed on one route reaches its siblings. Absent: read from the candidates' records.
   */
  throttles?: FallbackThrottleEvidence[];
}

/** The evidence each ordering step read for one route, exactly as it was compared. */
export interface FallbackOrderingEvidence {
  group: RouteCandidate['group'];
  lastSuccessfulQualificationAt?: string;
  failureRateMilli: Quantity;
  p90WallClockMilliseconds: Quantity;
  metricsScoredRunCount?: number;
}

export interface FallbackThrottleInEffect {
  observedOnRoute: string;
  at: string;
  detail: string;
  scope: ThrottleScope;
  scopeDeclared: boolean;
  /** The provider's own reset words, verbatim, when it gave any. */
  reset?: string;
}

export interface FallbackChainEntry {
  /** 1-based, over every qualified route — including those that fall through. */
  position: number;
  routeKey: string;
  standing: 'inChain' | 'fallsThrough';
  /** Empty when `inChain`; otherwise every reason, availability first. */
  fallsThroughBecause: string[];
  throttles: FallbackThrottleInEffect[];
  orderedBy: FallbackOrderingEvidence;
  /** The candidate as the set returned it, so a consumer never has to trust this summary alone. */
  candidate: RouteCandidate;
}

export interface FallbackChain {
  schema: typeof FALLBACK_CHAIN_RULE_VERSION;
  contract: RouteCandidateSet['contract'];
  query: RouteCandidateSet['query'];
  routingPolicyVersion: RoutingPolicyVersion;
  answeredAt: string;
  orderingRule: string;
  /** The rollup schema the metrics step read, or absent when no rollup was given. */
  metricsSchema?: typeof METRICS_ROLLUP_SCHEMA;
  /** Every qualified candidate, in rule order. */
  entries: FallbackChainEntry[];
  /** The route keys that stand, in order: the fallback list itself. */
  chain: string[];
  /** Exactly the candidate set's exclusions, every reason kept. */
  excluded: RouteCandidateSet['excluded'];
  /** Always false. Stated so no consumer reads the first entry as a choice. */
  isSelection: false;
  disclosure: string;
  candidateSetDisclosure: string;
}

const instant = (value: string | undefined): number | undefined => {
  if (value === undefined || value.length === 0) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
};


/** Lower first; unknown after every known value. */
function ascendingKnownFirst(a: number | undefined, b: number | undefined): number {
  if (a === undefined && b === undefined) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  return a - b;
}

/** Every throttle a set of records carries, for `FallbackChainInputs.throttles`. */
export function throttleEvidenceFromRecords(records: RouteQualificationRecord[]): FallbackThrottleEvidence[] {
  return records.filter((record) => record.lastThrottle !== undefined).map((record) => ({
    routeKey: record.routeKey, provider: record.provider,
    at: record.lastThrottle!.at, detail: record.lastThrottle!.detail,
  }));
}

function orderingEvidence(candidate: RouteCandidate, capability: string, metrics: MetricsRollup | undefined): FallbackOrderingEvidence {
  const evidence = { group: candidate.group,
    ...(candidate.record.lastSuccessfulQualificationAt === undefined || candidate.record.lastSuccessfulQualificationAt === ''
      ? {} : { lastSuccessfulQualificationAt: candidate.record.lastSuccessfulQualificationAt }) };
  if (metrics === undefined) {
    const none = unavailableQuantity('no metrics rollup was given, so this step ordered nothing');
    return { ...evidence, failureRateMilli: none, p90WallClockMilliseconds: none };
  }
  const entry = metrics.routes.find((route) => route.routeKey === candidate.routeKey)?.capabilities
    .find((row) => row.capability === capability);
  if (entry === undefined) {
    const none = unavailableQuantity(`the metrics rollup holds no run of ${candidate.routeKey} for ${capability}`);
    return { ...evidence, failureRateMilli: none, p90WallClockMilliseconds: none };
  }
  return { ...evidence, failureRateMilli: entry.failureRateMilli, p90WallClockMilliseconds: entry.wallClockMilliseconds.p90,
    metricsScoredRunCount: entry.scoredRunCount };
}

function compareEntries(a: { routeKey: string; orderedBy: FallbackOrderingEvidence },
                        b: { routeKey: string; orderedBy: FallbackOrderingEvidence }): number {
  const groupRank = (group: RouteCandidate['group']): number => (group === 'zeroMarginalCost' ? 0 : 1);
  const freshness = (at: string | undefined): number | undefined => {
    const parsed = instant(at);
    return parsed === undefined ? undefined : -parsed;
  };
  return groupRank(a.orderedBy.group) - groupRank(b.orderedBy.group)
    || ascendingKnownFirst(freshness(a.orderedBy.lastSuccessfulQualificationAt), freshness(b.orderedBy.lastSuccessfulQualificationAt))
    || ascendingKnownFirst(quantityValue(a.orderedBy.failureRateMilli), quantityValue(b.orderedBy.failureRateMilli))
    || ascendingKnownFirst(quantityValue(a.orderedBy.p90WallClockMilliseconds), quantityValue(b.orderedBy.p90WallClockMilliseconds))
    || compareCodePoints(a.routeKey, b.routeKey);
}

/** The throttles that still reach this candidate at `now`, each with what it reaches and what the provider said. */
function throttlesInEffect(candidate: RouteCandidate, throttles: FallbackThrottleEvidence[], now: Date): FallbackThrottleInEffect[] {
  const passedAt = instant(candidate.record.lastSuccessfulQualificationAt);
  const reached: FallbackThrottleInEffect[] = [];
  for (const throttle of throttles) {
    const at = instant(throttle.at);
    // AN UNDATED THROTTLE CANNOT BE PLACED BEFORE OR AFTER ANYTHING, so it cannot say the route is throttled NOW.
    if (at === undefined) continue;
    const decision = providerThrottleScopeFor(throttle.provider);
    const reaches = throttleBlocks({
      provider: throttle.provider, observedOnCandidate: throttle.routeKey, observedOnCaseID: '', observedOnRepeatIndex: 0,
      observedInRecordRoot: '', failureKind: 'rateLimited', detail: throttle.detail, scope: decision.scope,
      scopeDeclared: decision.declared, sessionKey: decision.sessionKey, scopeNote: decision.note, observedAt: throttle.at,
    }, { provider: candidate.record.provider, candidate: candidate.routeKey });
    if (!reaches) continue;
    if (passedAt !== undefined && passedAt > at) continue;
    if (now.getTime() - at > FALLBACK_THROTTLE_MAX_AGE_MILLISECONDS) continue;
    const reset = parseThrottleReset(throttle.detail);
    if (reset?.retryAfterSeconds !== undefined && at + reset.retryAfterSeconds * 1_000 <= now.getTime()) continue;
    reached.push({ observedOnRoute: throttle.routeKey, at: throttle.at, detail: throttle.detail, scope: decision.scope,
      scopeDeclared: decision.declared, ...(reset === undefined ? {} : { reset: reset.reported }) });
  }
  return reached.sort((a, b) => compareCodePoints(a.at, b.at) || compareCodePoints(a.observedOnRoute, b.observedOnRoute));
}

function describeThrottle(routeKey: string, throttle: FallbackThrottleInEffect): string {
  return `throttle: ${throttle.observedOnRoute === routeKey ? 'this route' : throttle.observedOnRoute} was declined by its provider `
    + `at ${throttle.at} (${throttle.scope}-scoped${throttle.scopeDeclared ? '' : ', undeclared by the provider'}) and no later `
    + `passing run, elapsed retry-after or ${FALLBACK_THROTTLE_MAX_AGE_MILLISECONDS / 3_600_000}-hour window has lifted it. `
    + `${throttle.reset === undefined ? 'The provider named no reset time.' : `The provider said: ${throttle.reset}.`}`;
}

/**
 * The chain. PURE: every input is a value, nothing is read from or written to disk here, and no route
 * outside `set.candidates` can appear in `chain`.
 */
export function deriveFallbackChain(set: RouteCandidateSet, inputs: FallbackChainInputs): FallbackChain {
  const throttles = inputs.throttles ?? throttleEvidenceFromRecords(set.candidates.map((candidate) => candidate.record));
  const ordered = set.candidates
    .map((candidate) => ({ routeKey: candidate.routeKey, candidate,
      orderedBy: orderingEvidence(candidate, set.query.capability, inputs.metrics) }))
    .sort(compareEntries);

  const entries: FallbackChainEntry[] = ordered.map(({ routeKey, candidate, orderedBy }, index) => {
    const fallsThroughBecause: string[] = [];
    if (candidate.availability.state !== 'available') {
      fallsThroughBecause.push(`availability: ${candidate.availability.state} on ${candidate.availability.observedOnMachine} — `
        + `${candidate.availability.reason}`);
    }
    const reached = throttlesInEffect(candidate, throttles, inputs.now);
    for (const throttle of reached) fallsThroughBecause.push(describeThrottle(routeKey, throttle));
    return {
      position: index + 1, routeKey,
      standing: fallsThroughBecause.length === 0 ? 'inChain' : 'fallsThrough',
      fallsThroughBecause, throttles: reached, orderedBy, candidate,
    };
  });

  return {
    schema: FALLBACK_CHAIN_RULE_VERSION,
    contract: set.contract,
    query: set.query,
    routingPolicyVersion: set.routingPolicyVersion,
    answeredAt: inputs.now.toISOString(),
    orderingRule: FALLBACK_ORDERING_RULE,
    ...(inputs.metrics === undefined ? {} : { metricsSchema: inputs.metrics.schema }),
    entries,
    chain: entries.filter((entry) => entry.standing === 'inChain').map((entry) => entry.routeKey),
    excluded: set.excluded,
    isSelection: false,
    disclosure: FALLBACK_CHAIN_IS_NOT_A_SELECTION,
    candidateSetDisclosure: set.disclosure,
  };
}
