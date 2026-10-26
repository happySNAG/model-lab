// Benchmark engine · AN ADVISORY PER-TASK RECOMMENDATION, by one versioned rule, written nowhere.
//
// WHAT IT IS. Ordra asks "for this kind of pass, which routes would Cernum's evidence put first?". This
// module answers that, and only that: the task type goes through task taxonomy ctt1 to a crc2 query, the
// query is answered by `qualifiedRouteCandidates`, the candidates are narrowed to those crr1 is willing to
// rank, and those are put in the order the owner decided (D-C6, 2026-10-25):
//
//   1. reliability — the task category's success rate in the metrics rollup (cmr1), passes over scored
//      runs for the queried capability, the higher first. A route whose rate is UNKNOWN ranks after every
//      route whose rate is known, and its entry says so;
//   2. zero marginal cost before metered;
//   3. latency — the rollup's nearest-rank p90 wall clock for the capability, the lower first, unknown last;
//   4. route key, so the order is total and the same evidence always gives the same ranking.
//
// WHAT crr1 RANKS. Only a route that is QUALIFIED for the task's capability (and tier, when one is asked),
// whose qualification is UNEXPIRED, whose served-model identity is PROVEN (verified by the provider, or by
// a local weights digest — never admitted-but-unverifiable), and which is COMPATIBLE with the task: its
// context window holds what the pass needs and its cost fits the taxonomy row's cost policy. Every other
// route is listed under `excluded` with every reason, never dropped silently.
//
// WHAT IT IS NOT, AND EACH OF THESE IS A RULE.
//
//   NOT A SELECTION. Nothing here picks a route, writes routing state or launches anything, and every
//   answer says so. Whether to use the first route is Ordra's decision.
//   NOT A SCORE. No figure is combined with another; each step only breaks the ties the step before left.
//   NOT A DEFAULT. An unknown task type, tier or context requirement is refused by ctt1 with the reason.
//   NOT A WRITER. It takes values and returns a value.

import { compareCodePoints } from './canonical';
import { FALLBACK_CHAIN_RULE_VERSION, FallbackChainEntry, FallbackThrottleEvidence, deriveFallbackChain } from './fallback-chain';
import { Quantity, measuredQuantity, quantityValue, unavailableQuantity } from './frontier-metrics';
import { METRICS_ROLLUP_SCHEMA, MetricsRollup } from './metrics-rollup';
import { IdentityConfidence } from './model-description';
import {
  ROUTING_CONTRACT_VERSION, RouteCandidate, RouteCandidateQuery, RouteCandidateSet, RouteForQuery, qualifiedRouteCandidates,
} from './routing-contract';
import { CURRENT_ROUTING_POLICY_VERSION, RoutingPolicyVersion } from './routing-policy';
import { OrdraTaskType, TASK_TAXONOMY_VERSION, TaskTaxonomyRow, routeQueryForTask } from './task-taxonomy';

/** The ranking rule. Changing the order or what it admits means a new version. */
export const ROUTE_RECOMMENDATION_RULE_VERSION = 'crr1';

export const RECOMMENDATION_ORDERING_RULE =
  'crr1 (owner decision D-C6, 2026-10-25): reliability first — the task category\'s success rate in the metrics rollup, '
  + 'the higher first, an unknown rate after every known one; then zero marginal cost before metered; then the lower '
  + 'p90 wall clock for the task\'s capability, an unknown p90 after every known one; then route key. Only qualified, '
  + 'unexpired, identity-proven and compatible routes are ranked.';

export const RECOMMENDATION_IS_ADVISORY =
  'This is an ADVISORY ranking, not a selection: Cernum has chosen no route, written no routing state and launched '
  + 'nothing, and nothing here says the first route must be used. It ranks only routes the evidence qualifies for the '
  + 'task, by the stated rule, from recorded evidence alone; every other route is listed as excluded with its reasons. '
  + 'Whether and when to use any route is the consumer\'s decision.';

/** The identity confidences crr1 counts as PROVEN. Admitted-but-unverifiable and unknown are not. */
export const PROVEN_IDENTITY_CONFIDENCES: readonly IdentityConfidence[] = ['verifiedByProvider', 'verifiedByLocalDigest'];

export interface RecommendationRequest {
  /** The `cmk1:` key of the machine that would run the work. */
  machineKey: string;
  taskType: string;
  /** 1, 2 or 3 (or `tier<n>`). Absent: no structural tier is required, and the answer says so. */
  tier?: number | string;
  /** The context the pass needs, in tokens. Absent: no context requirement, and the answer says so. */
  contextTokens?: number | string;
}

export interface RecommendationInputs {
  /** The instant the answer is given for. */
  now: Date;
  /** Every route the caller derived, with any availability it resolved. Read, never changed. */
  routes: RouteForQuery[];
  /** The rollup reliability and latency are read from. Absent: both are unknown for every route. */
  metrics?: MetricsRollup;
  /** Every recorded throttle, excluded routes included, for the cfc1 fallback order. */
  throttles?: FallbackThrottleEvidence[];
  routingPolicyVersion?: RoutingPolicyVersion;
}

/** What each ranking step read for one route, exactly as it was compared. */
export interface RecommendationEvidence {
  /** Passes over scored runs for the queried capability, in thousandths. Unavailable, with the reason, when unknown. */
  successRateMilli: Quantity;
  scoredRunCount?: number;
  passCount?: number;
  group: RouteCandidate['group'];
  p90WallClockMilliseconds: Quantity;
}

export interface RankedRoute {
  /** 1-based. */
  rank: number;
  routeKey: string;
  rankedBy: RecommendationEvidence;
  /** True when the rollup holds no success rate for this route: it ranks after every route that has one. */
  reliabilityUnknown: boolean;
  /** Why this route stands where it stands, step by step. */
  reasons: string[];
  /** Where cfc1 puts the same route, and whether it would fall through right now. */
  fallback: { position: number; standing: FallbackChainEntry['standing']; fallsThroughBecause: string[] };
  /** The candidate as the set returned it, so a consumer never has to trust this summary alone. */
  candidate: RouteCandidate;
}

export interface RouteRecommendation {
  schema: typeof ROUTE_RECOMMENDATION_RULE_VERSION;
  ok: true;
  taxonomyVersion: typeof TASK_TAXONOMY_VERSION;
  contract: typeof ROUTING_CONTRACT_VERSION;
  routingPolicyVersion: RoutingPolicyVersion;
  answeredAt: string;
  task: { taskType: OrdraTaskType; row: TaskTaxonomyRow; tier?: RouteCandidateQuery['structuralTier']; contextTokens?: number };
  query: RouteCandidateQuery;
  orderingRule: string;
  metricsSchema?: typeof METRICS_ROLLUP_SCHEMA;
  /** Every route crr1 ranks, best evidence first. */
  ranking: RankedRoute[];
  /** The route keys of `ranking`, in order. */
  order: string[];
  /** Every route that is not ranked, with every reason. */
  excluded: RouteCandidateSet['excluded'];
  /** The cfc1 fallback order over exactly the ranked routes. */
  fallback: {
    schema: typeof FALLBACK_CHAIN_RULE_VERSION;
    orderingRule: string;
    chain: string[];
    entries: { position: number; routeKey: string; standing: FallbackChainEntry['standing']; fallsThroughBecause: string[] }[];
  };
  /** The explanation of the whole answer, in order. */
  reasons: string[];
  /** Always false. Stated so no consumer reads the first entry as a choice. */
  isSelection: false;
  /** Always false: nothing here writes routing state or starts a process. */
  launches: false;
  disclosure: string;
}

export interface RouteRecommendationRefusal {
  schema: typeof ROUTE_RECOMMENDATION_RULE_VERSION;
  ok: false;
  taxonomyVersion: typeof TASK_TAXONOMY_VERSION;
  refusals: string[];
  isSelection: false;
  launches: false;
}

const per = (value: Quantity): string => (quantityValue(value) === undefined ? 'unknown' : `${quantityValue(value)}`);

function rankingEvidence(candidate: RouteCandidate, capability: string, metrics: MetricsRollup | undefined): RecommendationEvidence {
  const group = candidate.group;
  if (metrics === undefined) {
    const none = unavailableQuantity('no metrics rollup was given');
    return { successRateMilli: none, group, p90WallClockMilliseconds: none };
  }
  const entry = metrics.routes.find((route) => route.routeKey === candidate.routeKey)?.capabilities
    .find((row) => row.capability === capability);
  if (entry === undefined) {
    const none = unavailableQuantity(`the metrics rollup holds no run of ${candidate.routeKey} for ${capability}`);
    return { successRateMilli: none, group, p90WallClockMilliseconds: none };
  }
  return {
    successRateMilli: entry.scoredRunCount === 0
      ? unavailableQuantity(`no run of ${candidate.routeKey} for ${capability} measured the model's work`)
      : measuredQuantity(Math.round((entry.passCount * 1000) / entry.scoredRunCount)),
    scoredRunCount: entry.scoredRunCount, passCount: entry.passCount, group,
    p90WallClockMilliseconds: entry.wallClockMilliseconds.p90,
  };
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

type Ranked = Pick<RankedRoute, 'routeKey' | 'rankedBy'>;

/** The step that decides `a` before `b`, or 'routeKey' when every evidence step tied. */
function decidingStep(a: Ranked, b: Ranked): 'reliability' | 'cost' | 'latency' | 'routeKey' {
  if (ascendingKnownFirst(negated(quantityValue(a.rankedBy.successRateMilli)), negated(quantityValue(b.rankedBy.successRateMilli))) !== 0) {
    return 'reliability';
  }
  if (groupRank(a.rankedBy.group) !== groupRank(b.rankedBy.group)) return 'cost';
  if (ascendingKnownFirst(quantityValue(a.rankedBy.p90WallClockMilliseconds), quantityValue(b.rankedBy.p90WallClockMilliseconds)) !== 0) {
    return 'latency';
  }
  return 'routeKey';
}

/** The crr1 order over two routes' evidence: negative when `a` ranks first. Exported so each step can be pinned. */
export function compareRecommendationEvidence(a: Ranked, b: Ranked): number {
  return ascendingKnownFirst(negated(quantityValue(a.rankedBy.successRateMilli)), negated(quantityValue(b.rankedBy.successRateMilli)))
    || groupRank(a.rankedBy.group) - groupRank(b.rankedBy.group)
    || ascendingKnownFirst(quantityValue(a.rankedBy.p90WallClockMilliseconds), quantityValue(b.rankedBy.p90WallClockMilliseconds))
    || compareCodePoints(a.routeKey, b.routeKey);
}

function describeReliability(evidence: RecommendationEvidence, capability: string): string {
  return quantityValue(evidence.successRateMilli) === undefined
    ? `reliability: UNKNOWN for ${capability} — ${evidence.successRateMilli.note ?? 'no rate recorded'}; an unknown rate ranks `
      + 'after every known one'
    : `reliability: ${evidence.passCount}/${evidence.scoredRunCount} scored runs passed for ${capability} `
      + `(${per(evidence.successRateMilli)}‰, metrics rollup ${METRICS_ROLLUP_SCHEMA})`;
}

function describeStep(step: ReturnType<typeof decidingStep>, before: Ranked, after: Ranked): string {
  switch (step) {
    case 'reliability':
      return `ranked above ${after.routeKey} on reliability: ${per(before.rankedBy.successRateMilli)}‰ against `
        + `${per(after.rankedBy.successRateMilli)}‰`;
    case 'cost':
      return `ranked above ${after.routeKey} on cost: equal reliability, and this route has zero marginal cost while it is metered`;
    case 'latency':
      return `ranked above ${after.routeKey} on latency: equal reliability and cost, p90 wall clock `
        + `${per(before.rankedBy.p90WallClockMilliseconds)} ms against ${per(after.rankedBy.p90WallClockMilliseconds)} ms`;
    default:
      return `ranked above ${after.routeKey} by route key only: reliability, cost and latency were all equal or unknown`;
  }
}

/**
 * The crr1 gate over a candidate the crc2 set already admitted: identity proven, qualification unexpired.
 * Returns every reason the route is not ranked; empty when it is.
 */
function crr1Refusals(candidate: RouteCandidate): string[] {
  const reasons: string[] = [];
  if (candidate.identityAdmitted || !PROVEN_IDENTITY_CONFIDENCES.includes(candidate.identityConfidence)) {
    reasons.push(`identity: ${ROUTE_RECOMMENDATION_RULE_VERSION} ranks only identity-proven routes (${PROVEN_IDENTITY_CONFIDENCES.join(' or ')}), `
      + `and this route's identity is ${candidate.identityConfidence}${candidate.identityAdmitted ? ', admitted but not verified' : ''}`);
  }
  const staleness = candidate.record.staleness;
  if (staleness === undefined) {
    reasons.push(`expiry: no qualification freshness was ever established for this route, so ${ROUTE_RECOMMENDATION_RULE_VERSION} `
      + 'cannot say it is unexpired');
  } else if (!staleness.valid) {
    reasons.push(`expiry: the qualification is no longer current — ${staleness.detail.join('; ')}`);
  }
  return reasons;
}

/**
 * The recommendation. PURE: every input is a value, nothing is read from or written to disk here, nothing is
 * selected or launched, and no route the crc2 set excluded can be ranked.
 */
export function recommendRoutes(request: RecommendationRequest, inputs: RecommendationInputs): RouteRecommendation | RouteRecommendationRefusal {
  // ctt1 refuses rather than defaults. A tier or context the caller did not give is not defaulted either: it
  // is simply not a requirement, and the reasons say so. Placeholders only let ctt1 check what WAS given.
  const answer = routeQueryForTask({ machineKey: request.machineKey, taskType: request.taskType,
    tier: request.tier ?? 1, contextTokens: request.contextTokens ?? 1 });
  if (!answer.ok) {
    return { schema: ROUTE_RECOMMENDATION_RULE_VERSION, ok: false, taxonomyVersion: answer.taxonomyVersion,
      refusals: answer.refusals, isSelection: false, launches: false };
  }
  const { structuralTier, minimumContextTokens, ...unconditional } = answer.query;
  const routingPolicyVersion = inputs.routingPolicyVersion ?? CURRENT_ROUTING_POLICY_VERSION;
  const query: RouteCandidateQuery = {
    ...unconditional,
    ...(request.tier === undefined ? {} : { structuralTier }),
    ...(request.contextTokens === undefined ? {} : { minimumContextTokens }),
    // crr1 ranks only identity-proven, unexpired routes; the query asks crc2 for both, so its own reasons apply.
    requireVerifiedIdentity: true,
    requireFreshQualification: true,
    routingPolicyVersion,
  };

  const answered = qualifiedRouteCandidates(query, inputs.routes);
  const kept: RouteCandidate[] = [];
  const excluded = [...answered.excluded];
  for (const candidate of answered.candidates) {
    const refusals = crr1Refusals(candidate);
    if (refusals.length === 0) kept.push(candidate);
    else excluded.push({ routeKey: candidate.routeKey, reasons: refusals });
  }
  excluded.sort((a, b) => compareCodePoints(a.routeKey, b.routeKey));
  const set: RouteCandidateSet = { ...answered, candidates: kept, excluded };

  const fallbackChain = deriveFallbackChain(set, { now: inputs.now, ...(inputs.metrics === undefined ? {} : { metrics: inputs.metrics }),
    ...(inputs.throttles === undefined ? {} : { throttles: inputs.throttles }) });
  const fallbackFor = new Map(fallbackChain.entries.map((entry) => [entry.routeKey, entry]));

  const ordered = kept
    .map((candidate) => ({ routeKey: candidate.routeKey, candidate, rankedBy: rankingEvidence(candidate, query.capability, inputs.metrics) }))
    .sort(compareRecommendationEvidence);

  const ranking: RankedRoute[] = ordered.map((entry, index) => {
    const reliabilityUnknown = quantityValue(entry.rankedBy.successRateMilli) === undefined;
    const fallback = fallbackFor.get(entry.routeKey)!;
    const reasons = [
      describeReliability(entry.rankedBy, query.capability),
      entry.rankedBy.group === 'zeroMarginalCost' ? 'cost: zero marginal cost'
        : 'cost: metered — requires a spending authorization before any use',
      quantityValue(entry.rankedBy.p90WallClockMilliseconds) === undefined
        ? `latency: p90 wall clock UNKNOWN — ${entry.rankedBy.p90WallClockMilliseconds.note ?? 'none recorded'}`
        : `latency: p90 wall clock ${per(entry.rankedBy.p90WallClockMilliseconds)} ms`,
    ];
    const next = ordered[index + 1];
    if (next !== undefined) reasons.push(describeStep(decidingStep(entry, next), entry, next));
    if (fallback.standing === 'fallsThrough') {
      reasons.push(`fallback: ${FALLBACK_CHAIN_RULE_VERSION} would fall through past this route right now — `
        + fallback.fallsThroughBecause.join('; '));
    }
    return {
      rank: index + 1, routeKey: entry.routeKey, rankedBy: entry.rankedBy, reliabilityUnknown, reasons,
      fallback: { position: fallback.position, standing: fallback.standing, fallsThroughBecause: fallback.fallsThroughBecause },
      candidate: entry.candidate,
    };
  });

  const reasons: string[] = [
    `task '${answer.taskType}' maps by task taxonomy ${TASK_TAXONOMY_VERSION} to ${query.capability}`
      + `${query.structuralTier === undefined ? ', with no structural tier required (none was asked)' : ` at ${query.structuralTier}`}`
      + `${query.minimumContextTokens === undefined ? ', with no context requirement (none was asked)'
        : `, needing at least ${query.minimumContextTokens} context tokens`}, under cost policy ${query.costPolicy}`,
    `${ROUTE_RECOMMENDATION_RULE_VERSION} ranks only qualified, unexpired, identity-proven and compatible routes: `
      + `${ranking.length} ranked, ${excluded.length} excluded, each exclusion with its reasons`,
  ];
  if (inputs.metrics === undefined) reasons.push('no metrics rollup was given, so reliability and latency are unknown for every route');
  if (ranking.length === 0) {
    reasons.push('no route qualifies for this task, so there is nothing to rank; nothing is defaulted in its place');
  } else {
    const first = ranking[0]!;
    reasons.push(`${first.routeKey} ranks first: ${first.reasons[0]}`);
    if (ranking.length > 1) reasons.push(`${first.routeKey} is ${first.reasons[3]!}`);
    const unknown = ranking.filter((entry) => entry.reliabilityUnknown).map((entry) => entry.routeKey);
    if (unknown.length > 0) {
      reasons.push(`reliability is unknown for ${unknown.join(', ')}, so ${unknown.length === 1 ? 'it ranks' : 'they rank'} after every `
        + 'route whose success rate is known');
    }
  }
  reasons.push(`the ${FALLBACK_CHAIN_RULE_VERSION} fallback order over the same routes is `
    + `${fallbackChain.chain.length === 0 ? 'empty' : fallbackChain.chain.join(' → ')}`);
  reasons.push('advisory only: no route was selected, no routing state was written and nothing was launched');

  return {
    schema: ROUTE_RECOMMENDATION_RULE_VERSION,
    ok: true,
    taxonomyVersion: TASK_TAXONOMY_VERSION,
    contract: answered.contract,
    routingPolicyVersion,
    answeredAt: inputs.now.toISOString(),
    task: { taskType: answer.taskType, row: answer.row,
      ...(query.structuralTier === undefined ? {} : { tier: query.structuralTier }),
      ...(query.minimumContextTokens === undefined ? {} : { contextTokens: query.minimumContextTokens }) },
    query,
    orderingRule: RECOMMENDATION_ORDERING_RULE,
    ...(inputs.metrics === undefined ? {} : { metricsSchema: inputs.metrics.schema }),
    ranking,
    order: ranking.map((entry) => entry.routeKey),
    excluded,
    fallback: {
      schema: fallbackChain.schema,
      orderingRule: fallbackChain.orderingRule,
      chain: fallbackChain.chain,
      entries: fallbackChain.entries.map((entry) => ({ position: entry.position, routeKey: entry.routeKey, standing: entry.standing,
        fallsThroughBecause: entry.fallsThroughBecause })),
    },
    reasons,
    isSelection: false,
    launches: false,
    disclosure: RECOMMENDATION_IS_ADVISORY,
  };
}
