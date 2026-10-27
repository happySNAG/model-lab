// Benchmark engine · RECOMMENDATION CONTRACT crr2, beside crr1 and never a change to it. Advisory only.
//
// WHAT IT IS. crr1 answers "which routes would Cernum's evidence put first for this kind of pass". crr2
// answers the same question as a CONTRACT a consumer can read field by field, validated by the JSON schema
// in docs/ordra-lane/recommend-crr2.schema.json: the query it answered, the first-ranked configuration
// (route key, exact model id, effort or effort-unobservable, machine key), the ranking, the fallback chain,
// the expected reliability with its sample size and a Wilson 95% interval, the expected duration (median
// and p90 where observed), the resource posture, the qualification policy and its expiry, a confidence
// with every uncertainty named, and every exclusion with its reasons.
//
// THE ORDER, EVERYWHERE IN crr2 AND cfc2 (owner, 2026-10-26): reliability, then zero marginal cost, then
// latency. Reliability is the lower bound of the Wilson 95% interval on passes over scored runs for the
// task's capability, so that three passes out of three does not outrank twenty-nine out of thirty; the
// point rate breaks a tie in the bound; an unknown reliability ranks after every known one. Then zero
// marginal cost before metered. Then the lower p90 wall clock, then the lower median, an unknown after a
// known. Then the key, so the order is total.
//
// cfc2 IS cfc1's CHAIN RE-ORDERED. The same entries, the same fall-through standing and reasons as cfc1
// gives them, put in the crr2 order. cfc1 itself is carried beside it, unchanged, so a reader can see both.
//
// EFFORT. A record derived under an effort key (cek1) is ranked as `provider:model@effort`, and its
// reliability and duration are read ONLY from the rollup of the runs under that key: evidence of another
// effort is never pooled in. A record derived without a key pools every effort, and its effort is stated
// as unobservable. Nothing here reads an effort from a model name.
//
// SUBSCRIPTION-ONLY BY DEFAULT. Unless `allowMetered` is given explicitly, the query admits only routes of
// zero marginal cost, and every metered route is excluded with that reason.
//
// WHAT IT IS NOT, AND EACH OF THESE IS A RULE.
//
//   NOT A SELECTION. `selected` names the first-ranked configuration so no consumer has to re-derive it;
//   nothing here picks a route, writes routing state or launches anything, and every answer says so.
//   NOT A QUALIFICATION. It reads verdicts cqp1 (or the record's own policy) reached; it sets no threshold.
//   The confidence levels below describe the evidence behind an answer and route nothing.
//   NOT A WRITER. It takes values and returns a value.

import { compareCodePoints } from './canonical';
import { QUALIFICATION_MAX_AGE_MILLISECONDS } from './discovery-refresh';
import { EvidenceEffort, RequestedEffort, isEffortKeyedRecord } from './effort-keyed-routes';
import {
  FALLBACK_CHAIN_RULE_VERSION, FALLBACK_ORDERING_RULE, FallbackChainEntry, FallbackThrottleEvidence, deriveFallbackChain,
  throttleEvidenceFromRecords,
} from './fallback-chain';
import { Quantity, measuredQuantity, quantityValue, unavailableQuantity } from './frontier-metrics';
import { METRICS_ROLLUP_SCHEMA, MetricsRollup, MetricsRollupEntry } from './metrics-rollup';
import { EffortLevel, ProviderID } from './provider';
import { V1_QUALIFICATION_POLICY } from './route-qualification';
import { PROVEN_IDENTITY_CONFIDENCES } from './route-recommendation';
import {
  ROUTING_CONTRACT_VERSION, RouteAvailabilitySource, RouteCandidate, RouteCandidateQuery, RouteCandidateSet, RouteForQuery,
  qualifiedRouteCandidates,
} from './routing-contract';
import { CURRENT_ROUTING_POLICY_VERSION, RoutingPolicyVersion } from './routing-policy';
import { OrdraTaskType, TASK_TAXONOMY_VERSION, routeQueryForTask } from './task-taxonomy';

/** The contract. Changing a field, the order or what it admits means a new version. */
export const ROUTE_RECOMMENDATION_CRR2_VERSION = 'crr2';
export const ROUTE_RECOMMENDATION_CRR2_SCHEMA_VERSION = 1;
export const ROUTE_RECOMMENDATION_CRR2_JSON_SCHEMA = 'docs/ordra-lane/recommend-crr2.schema.json';

/** cfc1's chain re-ordered by the crr2 rule. */
export const FALLBACK_CHAIN_CFC2_VERSION = 'cfc2';

/** The z of a two-sided 95% interval. */
export const WILSON_95_Z = 1.96;

/** Fewer scored runs than this is named as a small-sample uncertainty. Describes evidence; routes nothing. */
export const CRR2_SMALL_SAMPLE_RUNS = 10;
/** A Wilson interval wider than this, in thousandths, is named as a wide-interval uncertainty. Routes nothing. */
export const CRR2_WIDE_INTERVAL_MILLI = 200;

export const CRR2_ORDERING_RULE =
  'crr2 (owner, 2026-10-26): reliability first — the lower bound of the Wilson 95% interval on passes over scored runs '
  + 'for the task\'s capability, the higher first, the point rate breaking a tie, an unknown reliability after every known '
  + 'one; then zero marginal cost before metered; then latency — the lower p90 wall clock, then the lower median, an '
  + 'unknown after every known one; then the key. Only qualified, unexpired, identity-proven and compatible routes are '
  + 'ranked. The same order is cfc2.';

export const CFC2_ORDERING_RULE =
  'cfc2: the cfc1 entries over the ranked routes, each with the standing and fall-through reasons cfc1 gives it, '
  + 're-ordered by the crr2 rule — reliability, then zero marginal cost, then latency, then the key. A route that falls '
  + 'through keeps its position and the chain continues with the next. cfc1 is carried beside it unchanged.';

export const CRR2_IS_ADVISORY =
  'This is an ADVISORY recommendation, not a selection: Cernum has chosen no route, written no routing state and launched '
  + 'nothing. `selected` names the first-ranked configuration only so a consumer need not re-derive it; whether and when to '
  + 'use any route is the consumer\'s decision. Only routes the evidence qualifies for the task are ranked, by the stated '
  + 'rule, from recorded evidence alone; every other route is listed under exclusions with its reasons.';

export const CRR2_SUBSCRIPTION_ONLY_REASON =
  'cost: crr2 is subscription-only by default — only routes of zero marginal cost (local, subscription-included or '
  + 'confirmed free) are admitted, and a metered route is admitted only when --allow-metered is given explicitly';

export interface Crr2Request {
  /** The `cmk1:` key of the machine that would run the work. */
  machineKey: string;
  taskType: string;
  tier?: number | string;
  contextTokens?: number | string;
  /** Admit metered routes, in their own group and flagged as needing a spending authorization. Default false. */
  allowMetered?: boolean;
}

export interface Crr2Inputs {
  now: Date;
  /** Every route the caller derived — pooled records, effort-keyed records (cek1) or both. Read, never changed. */
  routes: RouteForQuery[];
  /** The rollup a POOLED record's reliability and duration are read from. */
  metrics?: MetricsRollup;
  /** One rollup per effort-keyed route key, of the runs under that key alone. A keyed record reads only its own. */
  keyedMetrics?: Record<string, MetricsRollup>;
  throttles?: FallbackThrottleEvidence[];
  routingPolicyVersion?: RoutingPolicyVersion;
}

export interface Crr2Effort {
  state: 'observed' | 'unobservable';
  /** The applied effort the tool's telemetry measured. Absent when unobservable. */
  effort?: EffortLevel;
  /** `provider:model@effort` or `provider:model@unobservable:<requested>`. Absent when the evidence pools every effort. */
  effortRouteKey?: string;
  /** True when the record's evidence was not keyed by effort: every effort's runs are pooled. */
  pooled: boolean;
  requestedEfforts: RequestedEffort[];
  /** How the effort is known, or why it is not. */
  basis: string[];
}

export interface Crr2Reliability {
  capability: string;
  /** Scored runs for the capability: the sample size. */
  sampleSize: number;
  passCount: number;
  successRateMilli: Quantity;
  interval95: { method: 'wilson'; z: typeof WILSON_95_Z; lowerMilli: Quantity; upperMilli: Quantity };
  /** The rollup this was read from, or why none was. */
  source: string;
}

export interface Crr2Duration {
  capability: string;
  /** Runs that recorded a wall clock. */
  sampleSize: number;
  medianMilliseconds: Quantity;
  p90Milliseconds: Quantity;
}

export interface Crr2ResourcePosture {
  posture: 'zeroMarginalCost' | 'metered';
  group: RouteCandidate['group'];
  requiresSpendingAuthorization: boolean;
  eligibility: string;
  reasons: string[];
}

export interface Crr2Qualification {
  /** The policy that decided this route's verdicts. */
  policyID: string;
  /** cqp1, the default qualification policy; stated so a reader sees whether this record used it. */
  defaultPolicyID: string;
  capabilityVerdict: string;
  tierVerdict?: string;
  qualifiedAt?: string;
  /** `qualifiedAt` plus the qualification maximum age. Absent when no qualification instant was recorded. */
  expiresAt?: string;
  maxAgeMilliseconds: number;
  /** Until `expiresAt` from the answer's instant. Absent with `expiresAt`. */
  remainingMilliseconds?: number;
  current: boolean;
  detail: string[];
}

export interface Crr2Uncertainty {
  code: 'nothingRanked' | 'noMetrics' | 'reliabilityUnknown' | 'smallSample' | 'wideInterval' | 'effortUnobservable'
    | 'durationUnknown' | 'fallsThroughNow' | 'noFallback';
  /** The ranked key it concerns; absent when it concerns the whole answer. */
  key?: string;
  detail: string;
}

export interface Crr2Configuration {
  /** `effortRouteKey` when keyed, the route key otherwise. Unique within one answer. */
  key: string;
  routeKey: string;
  provider: ProviderID;
  /** The exact model id the route requests. */
  modelID: string;
  effort: Crr2Effort;
  machineKey: string;
}

export interface Crr2RankedRoute extends Crr2Configuration {
  rank: number;
  reliability: Crr2Reliability;
  duration: Crr2Duration;
  resourcePosture: Crr2ResourcePosture;
  qualification: Crr2Qualification;
  availability: { state: RouteAvailabilitySource['state']; observedOnMachine: string; observedAt?: string; reason: string };
  fallback: { position: number; cfc1Position: number; standing: FallbackChainEntry['standing']; fallsThroughBecause: string[] };
  reasons: string[];
  uncertainties: Crr2Uncertainty[];
  candidate: RouteCandidate;
}

export interface Crr2FallbackEntry {
  position: number;
  cfc1Position: number;
  key: string;
  routeKey: string;
  standing: FallbackChainEntry['standing'];
  fallsThroughBecause: string[];
}

export interface Crr2Recommendation {
  contract: typeof ROUTE_RECOMMENDATION_CRR2_VERSION;
  contractVersion: typeof ROUTE_RECOMMENDATION_CRR2_SCHEMA_VERSION;
  jsonSchema: typeof ROUTE_RECOMMENDATION_CRR2_JSON_SCHEMA;
  ok: true;
  taxonomyVersion: typeof TASK_TAXONOMY_VERSION;
  routingContract: typeof ROUTING_CONTRACT_VERSION;
  routingPolicyVersion: RoutingPolicyVersion;
  answeredAt: string;
  query: {
    taskType: OrdraTaskType;
    tier?: RouteCandidateQuery['structuralTier'];
    contextTokens?: number;
    machineKey: string;
    capability: string;
    allowMetered: boolean;
    costPolicy: RouteCandidateQuery['costPolicy'];
    routeQuery: RouteCandidateQuery;
  };
  orderingRule: string;
  metricsSchema?: typeof METRICS_ROLLUP_SCHEMA;
  /** The first-ranked configuration, or absent when nothing is ranked. ADVISORY: not a selection. */
  selected?: Crr2Configuration;
  ranking: Crr2RankedRoute[];
  order: string[];
  fallback: {
    schema: typeof FALLBACK_CHAIN_CFC2_VERSION;
    basedOn: typeof FALLBACK_CHAIN_RULE_VERSION;
    orderingRule: string;
    chain: string[];
    entries: Crr2FallbackEntry[];
    cfc1: { schema: typeof FALLBACK_CHAIN_RULE_VERSION; orderingRule: string; chain: string[] };
  };
  /** The selected configuration's figures, absent when nothing is ranked. */
  expectedReliability?: Crr2Reliability;
  expectedDuration?: Crr2Duration;
  resourcePosture?: Crr2ResourcePosture;
  qualification: { defaultPolicyID: string; selected?: Crr2Qualification };
  confidence: { level: 'high' | 'medium' | 'low' | 'none'; basis: string[] };
  uncertainties: Crr2Uncertainty[];
  exclusions: { key: string; routeKey: string; effort: Crr2Effort; reasons: string[] }[];
  reasons: string[];
  advisory: true;
  isSelection: false;
  launches: false;
  disclosure: string;
}

export interface Crr2Refusal {
  contract: typeof ROUTE_RECOMMENDATION_CRR2_VERSION;
  ok: false;
  taxonomyVersion: typeof TASK_TAXONOMY_VERSION;
  refusals: string[];
  isSelection: false;
  launches: false;
}

// ---- figures -----------------------------------------------------------------------------------------

/** Thousandths, without floating-point dust deciding a floor or a ceiling. */
const milli = (fraction: number, round: (value: number) => number): number =>
  round(Math.round(fraction * 1e9) / 1e6);

/**
 * The Wilson score interval at 95% on `passes` of `runs`, in thousandths, the lower bound floored and the upper
 * ceilinged so the interval never claims more than the arithmetic does. Undefined for no runs.
 */
export function wilsonInterval95Milli(passes: number, runs: number): { lowerMilli: number; upperMilli: number } | undefined {
  if (!Number.isInteger(runs) || runs <= 0 || !Number.isInteger(passes) || passes < 0 || passes > runs) return undefined;
  const z2 = WILSON_95_Z * WILSON_95_Z;
  const rate = passes / runs;
  const denominator = 1 + z2 / runs;
  const centre = (rate + z2 / (2 * runs)) / denominator;
  const half = (WILSON_95_Z * Math.sqrt((rate * (1 - rate)) / runs + z2 / (4 * runs * runs))) / denominator;
  return { lowerMilli: Math.max(0, milli(centre - half, Math.floor)), upperMilli: Math.min(1000, milli(centre + half, Math.ceil)) };
}

function effortOf(record: RouteForQuery['record']): Crr2Effort {
  if (!isEffortKeyedRecord(record)) {
    return { state: 'unobservable', pooled: true, requestedEfforts: [],
      basis: ['this record was derived without an effort key, so its evidence pools every effort the runs were made at; '
        + 'no single effort was observed for it'] };
  }
  const keyed: EvidenceEffort = record.evidenceEffort;
  return { state: keyed.state, ...(keyed.effort === undefined ? {} : { effort: keyed.effort }), effortRouteKey: keyed.effortRouteKey,
    pooled: false, requestedEfforts: keyed.requestedEfforts, basis: keyed.basis };
}

function metricsEntry(candidate: RouteCandidate, key: string, keyed: boolean, capability: string, inputs: Crr2Inputs):
  { entry?: MetricsRollupEntry; source: string } {
  const rollup = keyed ? inputs.keyedMetrics?.[key] : inputs.metrics;
  if (rollup === undefined) {
    return { source: keyed
      ? `no rollup of the runs under ${key} was given; evidence of another effort is never pooled in`
      : 'no metrics rollup was given' };
  }
  const entry = rollup.routes.find((route) => route.routeKey === candidate.routeKey)?.capabilities
    .find((row) => row.capability === capability);
  return entry === undefined
    ? { source: `the metrics rollup holds no run of ${key} for ${capability}` }
    : { entry, source: `metrics rollup ${rollup.schema}${keyed ? ` of the runs under ${key} alone` : ''}` };
}

function reliabilityOf(capability: string, found: { entry?: MetricsRollupEntry; source: string }): Crr2Reliability {
  const scored = found.entry?.scoredRunCount ?? 0;
  const passes = found.entry?.passCount ?? 0;
  const interval = wilsonInterval95Milli(passes, scored);
  const why = found.entry === undefined ? found.source : `no run of this route for ${capability} measured the model's work`;
  return {
    capability, sampleSize: scored, passCount: passes,
    successRateMilli: scored === 0 ? unavailableQuantity(why) : measuredQuantity(Math.round((passes * 1000) / scored)),
    interval95: { method: 'wilson', z: WILSON_95_Z,
      lowerMilli: interval === undefined ? unavailableQuantity(why) : measuredQuantity(interval.lowerMilli),
      upperMilli: interval === undefined ? unavailableQuantity(why) : measuredQuantity(interval.upperMilli) },
    source: found.source,
  };
}

function durationOf(capability: string, found: { entry?: MetricsRollupEntry; source: string }): Crr2Duration {
  if (found.entry === undefined) {
    const none = unavailableQuantity(found.source);
    return { capability, sampleSize: 0, medianMilliseconds: none, p90Milliseconds: none };
  }
  const wall = found.entry.wallClockMilliseconds;
  return { capability, sampleSize: wall.count - wall.missing, medianMilliseconds: wall.median, p90Milliseconds: wall.p90 };
}

function postureOf(candidate: RouteCandidate): Crr2ResourcePosture {
  const billing = candidate.record.billing;
  return {
    posture: candidate.group === 'zeroMarginalCost' ? 'zeroMarginalCost' : 'metered',
    group: candidate.group,
    requiresSpendingAuthorization: candidate.requiresSpendingAuthorization,
    eligibility: billing === undefined ? 'unknown' : String(billing.eligibility),
    reasons: billing?.reasons ?? ['no spend posture was recorded for this route'],
  };
}

function qualificationOf(candidate: RouteCandidate, now: Date): Crr2Qualification {
  const record = candidate.record;
  const qualifiedAt = record.lastSuccessfulQualificationAt === undefined || record.lastSuccessfulQualificationAt === ''
    ? undefined : record.lastSuccessfulQualificationAt;
  const parsed = qualifiedAt === undefined ? Number.NaN : Date.parse(qualifiedAt);
  const expires = Number.isNaN(parsed) ? undefined : parsed + QUALIFICATION_MAX_AGE_MILLISECONDS;
  return {
    policyID: record.policy.policyID,
    defaultPolicyID: V1_QUALIFICATION_POLICY.policyID,
    capabilityVerdict: candidate.capabilityEvidence.verdict,
    ...(candidate.tierEvidence === undefined ? {} : { tierVerdict: candidate.tierEvidence.verdict }),
    ...(qualifiedAt === undefined ? {} : { qualifiedAt }),
    ...(expires === undefined ? {} : { expiresAt: new Date(expires).toISOString(), remainingMilliseconds: expires - now.getTime() }),
    maxAgeMilliseconds: QUALIFICATION_MAX_AGE_MILLISECONDS,
    current: record.staleness?.valid === true,
    detail: record.staleness?.detail ?? [],
  };
}

/** The crr1 gate, by the same rule: identity proven, qualification freshness established and current. */
function gateRefusals(candidate: RouteCandidate): string[] {
  const reasons: string[] = [];
  if (candidate.identityAdmitted || !PROVEN_IDENTITY_CONFIDENCES.includes(candidate.identityConfidence)) {
    reasons.push(`identity: ${ROUTE_RECOMMENDATION_CRR2_VERSION} ranks only identity-proven routes (${PROVEN_IDENTITY_CONFIDENCES.join(' or ')}), `
      + `and this route's identity is ${candidate.identityConfidence}${candidate.identityAdmitted ? ', admitted but not verified' : ''}`);
  }
  const staleness = candidate.record.staleness;
  if (staleness === undefined) {
    reasons.push(`expiry: no qualification freshness was ever established for this route, so ${ROUTE_RECOMMENDATION_CRR2_VERSION} `
      + 'cannot say it is unexpired');
  } else if (!staleness.valid) {
    reasons.push(`expiry: the qualification is no longer current — ${staleness.detail.join('; ')}`);
  }
  return reasons;
}

// ---- the order -----------------------------------------------------------------------------------------

/** What the crr2 order compares for one entry, exactly as compared. */
export interface Crr2OrderingEvidence {
  key: string;
  reliability: Pick<Crr2Reliability, 'successRateMilli' | 'interval95'>;
  group: RouteCandidate['group'];
  duration: Pick<Crr2Duration, 'medianMilliseconds' | 'p90Milliseconds'>;
}

/** Lower first; unknown after every known value. */
function ascendingKnownFirst(a: number | undefined, b: number | undefined): number {
  if (a === undefined && b === undefined) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  return a - b;
}
const negated = (value: number | undefined): number | undefined => (value === undefined ? undefined : -value);
const groupRank = (group: RouteCandidate['group']): number => (group === 'zeroMarginalCost' ? 0 : 1);

type Step = 'reliability' | 'cost' | 'latency' | 'key';

function steps(a: Crr2OrderingEvidence, b: Crr2OrderingEvidence): [Step, number][] {
  return [
    ['reliability', ascendingKnownFirst(negated(quantityValue(a.reliability.interval95.lowerMilli)), negated(quantityValue(b.reliability.interval95.lowerMilli)))
      || ascendingKnownFirst(negated(quantityValue(a.reliability.successRateMilli)), negated(quantityValue(b.reliability.successRateMilli)))],
    ['cost', groupRank(a.group) - groupRank(b.group)],
    ['latency', ascendingKnownFirst(quantityValue(a.duration.p90Milliseconds), quantityValue(b.duration.p90Milliseconds))
      || ascendingKnownFirst(quantityValue(a.duration.medianMilliseconds), quantityValue(b.duration.medianMilliseconds))],
    ['key', compareCodePoints(a.key, b.key)],
  ];
}

/** The crr2 (and cfc2) order: negative when `a` comes first. Exported so each step can be pinned. */
export function compareCrr2Evidence(a: Crr2OrderingEvidence, b: Crr2OrderingEvidence): number {
  for (const [, result] of steps(a, b)) if (result !== 0) return result;
  return 0;
}

function decidingStep(a: Crr2OrderingEvidence, b: Crr2OrderingEvidence): Step {
  return steps(a, b).find(([, result]) => result !== 0)?.[0] ?? 'key';
}

const shown = (value: Quantity): string => (quantityValue(value) === undefined ? 'unknown' : `${quantityValue(value)}`);

function describeReliability(reliability: Crr2Reliability): string {
  return quantityValue(reliability.successRateMilli) === undefined
    ? `reliability: UNKNOWN for ${reliability.capability} — ${reliability.successRateMilli.note ?? 'no rate recorded'}; an unknown `
      + 'reliability ranks after every known one'
    : `reliability: ${reliability.passCount}/${reliability.sampleSize} scored runs passed for ${reliability.capability} `
      + `(${shown(reliability.successRateMilli)}‰, Wilson 95% ${shown(reliability.interval95.lowerMilli)}–`
      + `${shown(reliability.interval95.upperMilli)}‰, ${reliability.source})`;
}

function describeStep(step: Step, before: Crr2OrderingEvidence, after: Crr2OrderingEvidence): string {
  switch (step) {
    case 'reliability':
      return `ranked above ${after.key} on reliability: Wilson 95% lower bound ${shown(before.reliability.interval95.lowerMilli)}‰ `
        + `against ${shown(after.reliability.interval95.lowerMilli)}‰ (point rate ${shown(before.reliability.successRateMilli)}‰ `
        + `against ${shown(after.reliability.successRateMilli)}‰)`;
    case 'cost':
      return `ranked above ${after.key} on cost: equal reliability, and this route has zero marginal cost while it is metered`;
    case 'latency':
      return `ranked above ${after.key} on latency: equal reliability and cost, p90 wall clock ${shown(before.duration.p90Milliseconds)} ms `
        + `against ${shown(after.duration.p90Milliseconds)} ms (median ${shown(before.duration.medianMilliseconds)} ms against `
        + `${shown(after.duration.medianMilliseconds)} ms)`;
    default:
      return `ranked above ${after.key} by key only: reliability, cost and latency were all equal or unknown`;
  }
}

function uncertaintiesOf(key: string, reliability: Crr2Reliability, duration: Crr2Duration, effort: Crr2Effort,
                         standing: FallbackChainEntry['standing'], fallsThroughBecause: string[]): Crr2Uncertainty[] {
  const found: Crr2Uncertainty[] = [];
  const lower = quantityValue(reliability.interval95.lowerMilli);
  const upper = quantityValue(reliability.interval95.upperMilli);
  if (quantityValue(reliability.successRateMilli) === undefined) {
    found.push({ code: 'reliabilityUnknown', key, detail: reliability.successRateMilli.note ?? 'no success rate recorded' });
  } else {
    if (reliability.sampleSize < CRR2_SMALL_SAMPLE_RUNS) {
      found.push({ code: 'smallSample', key, detail: `${reliability.sampleSize} scored run(s), fewer than ${CRR2_SMALL_SAMPLE_RUNS}` });
    }
    if (lower !== undefined && upper !== undefined && upper - lower > CRR2_WIDE_INTERVAL_MILLI) {
      found.push({ code: 'wideInterval', key, detail: `the Wilson 95% interval ${lower}–${upper}‰ is wider than ${CRR2_WIDE_INTERVAL_MILLI}‰` });
    }
  }
  if (effort.state === 'unobservable') {
    found.push({ code: 'effortUnobservable', key, detail: effort.pooled
      ? 'the evidence pools every effort; no single effort was observed'
      : `no telemetry observed the applied effort (${effort.effortRouteKey})` });
  }
  if (quantityValue(duration.p90Milliseconds) === undefined || quantityValue(duration.medianMilliseconds) === undefined) {
    found.push({ code: 'durationUnknown', key, detail: duration.p90Milliseconds.note ?? duration.medianMilliseconds.note ?? 'no wall clock recorded' });
  }
  if (standing === 'fallsThrough') found.push({ code: 'fallsThroughNow', key, detail: fallsThroughBecause.join('; ') });
  return found;
}

// ---- the answer ----------------------------------------------------------------------------------------

/**
 * The crr2 recommendation. PURE: every input is a value, nothing is read from or written to disk, nothing
 * is selected or launched, and no route the crc2 rules excluded can be ranked.
 */
export function recommendRoutesCrr2(request: Crr2Request, inputs: Crr2Inputs): Crr2Recommendation | Crr2Refusal {
  const answer = routeQueryForTask({ machineKey: request.machineKey, taskType: request.taskType,
    tier: request.tier ?? 1, contextTokens: request.contextTokens ?? 1 });
  if (!answer.ok) {
    return { contract: ROUTE_RECOMMENDATION_CRR2_VERSION, ok: false, taxonomyVersion: answer.taxonomyVersion,
      refusals: answer.refusals, isSelection: false, launches: false };
  }
  const allowMetered = request.allowMetered === true;
  const { structuralTier, minimumContextTokens, ...unconditional } = answer.query;
  const routingPolicyVersion = inputs.routingPolicyVersion ?? CURRENT_ROUTING_POLICY_VERSION;
  const query: RouteCandidateQuery = {
    ...unconditional,
    // SUBSCRIPTION-ONLY UNLESS EXPLICITLY ALLOWED, whatever the taxonomy row would have said.
    costPolicy: allowMetered ? 'allowMeteredWithAuthorization' : 'zeroMarginalCostOnly',
    ...(request.tier === undefined ? {} : { structuralTier }),
    ...(request.contextTokens === undefined ? {} : { minimumContextTokens }),
    requireVerifiedIdentity: true,
    requireFreshQualification: true,
    routingPolicyVersion,
  };

  // ONE crc2 ANSWER PER RECORD, so two efforts of one route never share an exclusion.
  type Kept = { key: string; keyed: boolean; effort: Crr2Effort; candidate: RouteCandidate };
  const kept: Kept[] = [];
  const exclusions: Crr2Recommendation['exclusions'] = [];
  const allCandidates: RouteCandidate[] = [];
  const excludedRoutes: RouteCandidateSet['excluded'] = [];
  for (const route of inputs.routes) {
    const effort = effortOf(route.record);
    const key = effort.effortRouteKey ?? route.record.routeKey;
    const answered = qualifiedRouteCandidates(query, [route]);
    const exclude = (routeKey: string, reasons: string[]): void => {
      const stated = !allowMetered && reasons.some((reason) => reason.startsWith('cost:')) ? [...reasons, CRR2_SUBSCRIPTION_ONLY_REASON] : reasons;
      exclusions.push({ key, routeKey, effort, reasons: stated });
      excludedRoutes.push({ routeKey, reasons: stated });
    };
    for (const entry of answered.excluded) exclude(entry.routeKey, entry.reasons);
    for (const candidate of answered.candidates) {
      const refusals = gateRefusals(candidate);
      if (refusals.length > 0) { exclude(candidate.routeKey, refusals); continue; }
      kept.push({ key, keyed: !effort.pooled, effort, candidate });
      allCandidates.push(candidate);
    }
  }
  exclusions.sort((a, b) => compareCodePoints(a.key, b.key));

  // cfc1, UNCHANGED, over exactly the ranked candidates. Its entries carry the candidate objects, so each
  // ranked entry finds its own cfc1 entry even when two efforts share a route key.
  const set: RouteCandidateSet = { ...qualifiedRouteCandidates(query, []), candidates: allCandidates, excluded: excludedRoutes };
  const cfc1 = deriveFallbackChain(set, { now: inputs.now, ...(inputs.metrics === undefined ? {} : { metrics: inputs.metrics }),
    throttles: inputs.throttles ?? throttleEvidenceFromRecords(allCandidates.map((candidate) => candidate.record)) });
  const cfc1For = new Map(cfc1.entries.map((entry) => [entry.candidate, entry]));
  const keyFor = new Map(kept.map((entry) => [entry.candidate, entry.key]));

  const ordered = kept.map((entry) => {
    const found = metricsEntry(entry.candidate, entry.key, entry.keyed, query.capability, inputs);
    return { ...entry, reliability: reliabilityOf(query.capability, found), duration: durationOf(query.capability, found),
      group: entry.candidate.group };
  }).sort(compareCrr2Evidence);

  const ranking: Crr2RankedRoute[] = ordered.map((entry, index) => {
    const fallback = cfc1For.get(entry.candidate)!;
    const reasons = [
      describeReliability(entry.reliability),
      entry.group === 'zeroMarginalCost' ? 'cost: zero marginal cost' : 'cost: metered — requires a spending authorization before any use',
      quantityValue(entry.duration.p90Milliseconds) === undefined
        ? `latency: p90 wall clock UNKNOWN — ${entry.duration.p90Milliseconds.note ?? 'none recorded'}`
        : `latency: p90 wall clock ${shown(entry.duration.p90Milliseconds)} ms, median ${shown(entry.duration.medianMilliseconds)} ms`,
    ];
    const next = ordered[index + 1];
    if (next !== undefined) reasons.push(describeStep(decidingStep(entry, next), entry, next));
    if (fallback.standing === 'fallsThrough') {
      reasons.push(`fallback: ${FALLBACK_CHAIN_CFC2_VERSION} would fall through past this route right now — ${fallback.fallsThroughBecause.join('; ')}`);
    }
    const record = entry.candidate.record;
    return {
      rank: index + 1, key: entry.key, routeKey: record.routeKey, provider: record.provider, modelID: record.modelID,
      effort: entry.effort, machineKey: query.machineKey,
      reliability: entry.reliability, duration: entry.duration,
      resourcePosture: postureOf(entry.candidate), qualification: qualificationOf(entry.candidate, inputs.now),
      availability: { state: entry.candidate.availability.state, observedOnMachine: entry.candidate.availability.observedOnMachine,
        ...(entry.candidate.availability.observedAt === undefined ? {} : { observedAt: entry.candidate.availability.observedAt }),
        reason: entry.candidate.availability.reason },
      fallback: { position: index + 1, cfc1Position: fallback.position, standing: fallback.standing,
        fallsThroughBecause: fallback.fallsThroughBecause },
      reasons,
      uncertainties: uncertaintiesOf(entry.key, entry.reliability, entry.duration, entry.effort, fallback.standing, fallback.fallsThroughBecause),
      candidate: entry.candidate,
    };
  });

  const fallbackEntries: Crr2FallbackEntry[] = ranking.map((entry) => ({ position: entry.fallback.position,
    cfc1Position: entry.fallback.cfc1Position, key: entry.key, routeKey: entry.routeKey, standing: entry.fallback.standing,
    fallsThroughBecause: entry.fallback.fallsThroughBecause }));
  const chain = fallbackEntries.filter((entry) => entry.standing === 'inChain').map((entry) => entry.key);
  const cfc1Chain = cfc1.entries.filter((entry) => entry.standing === 'inChain').map((entry) => keyFor.get(entry.candidate)!);

  const first = ranking[0];
  const uncertainties: Crr2Uncertainty[] = [];
  if (inputs.metrics === undefined && inputs.keyedMetrics === undefined) {
    uncertainties.push({ code: 'noMetrics', detail: 'no metrics rollup was given, so reliability and duration are unknown for every route' });
  }
  if (first === undefined) {
    uncertainties.push({ code: 'nothingRanked', detail: 'no route qualifies for this task, so nothing is ranked and nothing is defaulted' });
  } else {
    uncertainties.push(...first.uncertainties);
    if (chain.filter((key) => key !== first.key).length === 0) {
      uncertainties.push({ code: 'noFallback', detail: 'no other ranked route stands in the fallback chain behind the first' });
    }
  }
  const codes = new Set(uncertainties.map((entry) => entry.code));
  const level: Crr2Recommendation['confidence']['level'] = first === undefined ? 'none'
    : codes.has('reliabilityUnknown') || codes.has('smallSample') ? 'low'
      : uncertainties.length > 0 ? 'medium' : 'high';
  const confidenceBasis = level === 'none' ? ['nothing is ranked']
    : level === 'high' ? ['the first-ranked route has a known reliability on a sample of at least '
      + `${CRR2_SMALL_SAMPLE_RUNS} scored runs, an observed effort, an observed duration, and a fallback behind it`]
      : uncertainties.map((entry) => `${entry.code}${entry.key === undefined ? '' : ` (${entry.key})`}: ${entry.detail}`);

  const reasons: string[] = [
    `task '${answer.taskType}' maps by task taxonomy ${TASK_TAXONOMY_VERSION} to ${query.capability}`
      + `${query.structuralTier === undefined ? ', with no structural tier required (none was asked)' : ` at ${query.structuralTier}`}`
      + `${query.minimumContextTokens === undefined ? ', with no context requirement (none was asked)'
        : `, needing at least ${query.minimumContextTokens} context tokens`}`,
    allowMetered
      ? 'metered routes were explicitly allowed (--allow-metered): they may be ranked, in their own group, each needing a spending authorization'
      : 'subscription-only (the default): only routes of zero marginal cost are admitted; metered routes are excluded with that reason',
    `${ROUTE_RECOMMENDATION_CRR2_VERSION} ranks only qualified, unexpired, identity-proven and compatible routes: `
      + `${ranking.length} ranked, ${exclusions.length} excluded, each exclusion with its reasons`,
  ];
  if (first === undefined) {
    reasons.push('no route qualifies for this task, so there is nothing to rank; nothing is defaulted in its place');
  } else {
    reasons.push(`${first.key} ranks first: ${first.reasons[0]}`);
    if (ranking.length > 1) reasons.push(`${first.key} is ${first.reasons[3]!}`);
  }
  reasons.push(`the ${FALLBACK_CHAIN_CFC2_VERSION} fallback order (cfc1 re-ordered reliability first) is `
    + `${chain.length === 0 ? 'empty' : chain.join(' → ')}; cfc1 itself is ${cfc1Chain.length === 0 ? 'empty' : cfc1Chain.join(' → ')}`);
  reasons.push('advisory only: no route was selected, no routing state was written and nothing was launched');

  return {
    contract: ROUTE_RECOMMENDATION_CRR2_VERSION,
    contractVersion: ROUTE_RECOMMENDATION_CRR2_SCHEMA_VERSION,
    jsonSchema: ROUTE_RECOMMENDATION_CRR2_JSON_SCHEMA,
    ok: true,
    taxonomyVersion: TASK_TAXONOMY_VERSION,
    routingContract: ROUTING_CONTRACT_VERSION,
    routingPolicyVersion,
    answeredAt: inputs.now.toISOString(),
    query: {
      taskType: answer.taskType,
      ...(query.structuralTier === undefined ? {} : { tier: query.structuralTier }),
      ...(query.minimumContextTokens === undefined ? {} : { contextTokens: query.minimumContextTokens }),
      machineKey: query.machineKey, capability: query.capability, allowMetered, costPolicy: query.costPolicy, routeQuery: query,
    },
    orderingRule: CRR2_ORDERING_RULE,
    ...(inputs.metrics === undefined ? {} : { metricsSchema: inputs.metrics.schema }),
    ...(first === undefined ? {} : { selected: { key: first.key, routeKey: first.routeKey, provider: first.provider, modelID: first.modelID,
      effort: first.effort, machineKey: first.machineKey } }),
    ranking,
    order: ranking.map((entry) => entry.key),
    fallback: {
      schema: FALLBACK_CHAIN_CFC2_VERSION, basedOn: FALLBACK_CHAIN_RULE_VERSION, orderingRule: CFC2_ORDERING_RULE,
      chain, entries: fallbackEntries,
      cfc1: { schema: FALLBACK_CHAIN_RULE_VERSION, orderingRule: FALLBACK_ORDERING_RULE, chain: cfc1Chain },
    },
    ...(first === undefined ? {} : { expectedReliability: first.reliability, expectedDuration: first.duration,
      resourcePosture: first.resourcePosture }),
    qualification: { defaultPolicyID: V1_QUALIFICATION_POLICY.policyID, ...(first === undefined ? {} : { selected: first.qualification }) },
    confidence: { level, basis: confidenceBasis },
    uncertainties,
    exclusions,
    reasons,
    advisory: true,
    isSelection: false,
    launches: false,
    disclosure: CRR2_IS_ADVISORY,
  };
}
