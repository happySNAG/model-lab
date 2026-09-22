// Benchmark engine · THE CERNUM SIDE OF THE CONTRACT ORDRA WILL CONSUME. A query in, an evidence-backed
// CANDIDATE SET out — and no winner.
//
// WHAT ORDRA ASKS. "On this machine, for this capability at this structural tier, needing this much
// context, under this cost policy, local-only or not: which routes are QUALIFIED, and on what evidence?"
// This module answers exactly that, from `RouteQualificationRecord`s and `ModelDescription`s the caller
// has already derived, and it answers with every route it EXCLUDED and why beside the ones it kept.
//
// NO WINNER, AND NO SCORE TO PICK ONE WITH. The candidates are returned in two GROUPS — zero marginal
// cost first, metered second — and alphabetically by route inside each. The grouping is the whole of
// the zero-marginal-cost preference this pass implements; there is no ranking inside a group, because
// choosing between two qualified routes is a scheduling decision Ordra has not made yet, and a Cernum
// that ordered them would be making it for Ordra under the name of evidence. `latencyPreference` is
// carried to the candidate as its measured efficiency figures, for the consumer to read, not applied.
//
// ZERO MARGINAL COST NEVER OVERRIDES MISSING QUALIFICATION. A free route that failed — or never ran — the
// capability asked about is EXCLUDED, with the reason, however free it is. The preference only ever
// orders routes that each passed every evidence rule on their own.

import { compareCodePoints } from './canonical';
import { CapabilityQualification, RouteQualificationRecord } from './route-qualification';
import { IdentityConfidence, ModelDescription } from './model-description';
import {
  LOCAL_QUALIFICATION_DOES_NOT_TRANSFER, MachineAvailability, MachineAvailabilityState,
  RouteAvailabilityObservation, availabilityOnMachine,
} from './machine-availability';
import { ObservationStoreContents, StoredObservation, availabilityObservationsFrom } from './observation-store';
import { RouteSpendPosture } from './route-spend-posture';
import {
  CURRENT_ROUTING_POLICY_VERSION, ROUTABLE_CONDITION_DESCRIPTIONS, RoutingPolicyVersion, identityPermitsRouting,
  routingPolicy,
} from './routing-policy';
import { WorkspaceDifficultyTier } from './workspace-difficulty';

/**
 * crc2 — the contract with fleet observations and `requireVerifiedIdentity` in it.
 *
 * crc1 answered "which routes are qualified here", from records the caller had already assembled, and
 * could say nothing about a machine it was not running on. crc2 adds three things and removes none:
 * a query may name FRESHNESS limits, may demand VERIFIED IDENTITY, and may be answered against
 * PERSISTED observations from any machine in the fleet — including one that is not this one.
 */
export const ROUTING_CONTRACT_VERSION = 'crc2';

export type RoutingCostPolicy =
  /** Only local, subscription-included and current free_confirmed routes. The V1 default. */
  | 'zeroMarginalCostOnly'
  /** Metered routes may appear, in their own group, flagged as needing a spending authorization. */
  | 'allowMeteredWithAuthorization';

export interface RouteCandidateQuery {
  /** The `cmk1:` key of the machine that will run the work. */
  machineKey: string;
  /** A capability as the qualification view names it, e.g. `workspace:multiFileEditing`. */
  capability: string;
  /** When given, the route must ALSO be qualified at `workspace-tier:<tier>`. */
  structuralTier?: WorkspaceDifficultyTier;
  minimumContextTokens?: number;
  costPolicy: RoutingCostPolicy;
  latencyPreference?: 'none' | 'preferLowLatency';
  localOnly?: boolean;
  /** Carried for Ordra; in V1 zero-marginal-cost routes are always grouped first regardless. */
  preferSubscriptionOrFree?: boolean;
  /**
   * Demand that the served-model identity be INDEPENDENTLY ESTABLISHED. Default false.
   *
   * WHAT IT IS FOR. Most coding work needs a route that has been measured doing the work; it does not
   * need to name the model, because nothing downstream will cite one. Some work does — anything whose
   * output is attributed to a model, anything under a provenance requirement, anything that will be
   * published as "model X can do this". Those queries set this, and every Codex and OpenCode route
   * whose tool refuses to name what answered is excluded WITH ITS REASON rather than silently absent.
   *
   * IT IS A PROPERTY OF THE TASK, NOT OF THE FLEET. The same route is a candidate for one query and
   * excluded from the next, and neither answer changes what is known about it.
   */
  requireVerifiedIdentity?: boolean;
  /** Which routing policy decides identity-admitted routes. Defaults to the current version. */
  routingPolicyVersion?: RoutingPolicyVersion;
  /** An availability observation older than this does not satisfy the query. */
  maximumAvailabilityAgeMilliseconds?: number;
  /** A route whose qualification evidence is stale is excluded; this narrows the record's own window. */
  requireFreshQualification?: boolean;
  requireFreshDiscovery?: boolean;
}

export interface RouteCandidate {
  routeKey: string;
  group: 'zeroMarginalCost' | 'meteredRequiresAuthorization';
  locality: 'local' | 'remote';
  capabilityEvidence: CapabilityQualification;
  tierEvidence?: CapabilityQualification;
  contextWindowTokens?: number;
  requiresSpendingAuthorization: boolean;
  efficiency: RouteQualificationRecord['efficiency'];
  /**
   * How strongly this route can say WHICH model answered — carried on every candidate, always.
   *
   * A candidate that is routable under crp2 and whose identity is unverifiable says BOTH here. There
   * is no shape of this type that lets a consumer read a permission without reading the limit.
   */
  identityConfidence: IdentityConfidence;
  identityAdmitted: boolean;
  /** Present whenever `identityAdmitted`: the sentence that must travel with the permission. */
  identityDisclosure?: string;
  /** WHERE the knowledge that this route is available on the queried machine came from. */
  availability: RouteAvailabilitySource;
  spendPosture?: RouteSpendPosture;
  /** The routing policy version that admitted this candidate. */
  routingPolicyVersion: RoutingPolicyVersion;
  /** The full record, so a consumer never has to trust this summary alone. */
  record: RouteQualificationRecord;
}

/**
 * Which observation established availability, and who made it.
 *
 * `observedOnMachine` is the machine the observation was TAKEN on, and for a candidate it is always
 * the machine the query asked about — an observation from elsewhere cannot satisfy a query about
 * here. `origin` says whether this store made that observation itself or received it in a bundle,
 * which matters for a fleet view: one machine's own observation of its own routes, read on a second
 * machine, is `imported` there and is still an observation about the first.
 */
export interface RouteAvailabilitySource {
  state: MachineAvailabilityState;
  observedOnMachine: string;
  machineLabel: string;
  origin: StoredObservation['origin'];
  observedAt?: string;
  importedFromMachine?: string;
  reason: string;
}

export interface RouteCandidateSet {
  contract: typeof ROUTING_CONTRACT_VERSION;
  query: RouteCandidateQuery;
  /** The policy that decided identity-admitted routes in this answer, named so it can be checked. */
  routingPolicyVersion: RoutingPolicyVersion;
  candidates: RouteCandidate[];
  excluded: { routeKey: string; reasons: string[] }[];
  /** Always stated, so no consumer mistakes the list order for a preference Cernum did not express. */
  ordering: string;
  disclosure: string;
}

export const ROUTE_CANDIDATES_ARE_NOT_A_CHOICE =
  'This is the set of routes the evidence QUALIFIES for the query, not a choice among them. Candidates are grouped '
  + 'zero-marginal-cost first and are otherwise in route-key order; no route is preferred over another inside a group. '
  + 'A route absent from the set is listed under `excluded` with every reason, including routes that are free but not '
  + 'qualified — zero marginal cost never substitutes for evidence.';

function capabilityOf(record: RouteQualificationRecord, capability: string): CapabilityQualification | undefined {
  return record.capabilities.find((entry) => entry.capability === capability);
}

/**
 * One route as the query sees it: its derived record, optionally its description, and optionally the
 * availability the caller resolved for it from persisted observations.
 */
export interface RouteForQuery {
  record: RouteQualificationRecord;
  description?: ModelDescription;
  /** Resolved availability for the QUERIED machine. Absent falls back to the record's own. */
  availability?: RouteAvailabilitySource;
  spendPosture?: RouteSpendPosture;
}

/** Answer one query. PURE over the records given; reads nothing, writes nothing, picks nothing. */
export function qualifiedRouteCandidates(query: RouteCandidateQuery, routes: RouteForQuery[]): RouteCandidateSet {
  const candidates: RouteCandidate[] = [];
  const excluded: RouteCandidateSet['excluded'] = [];
  const policyVersion = query.routingPolicyVersion ?? CURRENT_ROUTING_POLICY_VERSION;
  const policy = routingPolicy(policyVersion);

  for (const { record, description, availability: resolved, spendPosture } of routes) {
    const reasons: string[] = [];

    // ---- identity, decided by the POLICY and by the QUERY, separately ---------------------------
    //
    // The two refusals are kept apart because they mean different things to whoever reads them. A
    // crp1 refusal says the fleet's policy does not route this class of route at all. A
    // requireVerifiedIdentity refusal says THIS TASK needs the model named and this route cannot name
    // it — the same route is a candidate for the next query.
    const identity = identityPermitsRouting({
      policy,
      routeKey: record.routeKey,
      admitted: record.identityAdmitted,
      identityConfidence: record.identityConfidence,
      requireVerifiedIdentity: query.requireVerifiedIdentity === true,
    });
    if (!identity.permitted) reasons.push(identity.reason);
    // EVERY BLOCKER BUT COST IS ABSOLUTE. Cost is relaxed only when the query explicitly allows metered
    // routes, and then only for a route whose spend posture permits a person-approved benchmark.
    const meteredAllowed = query.costPolicy === 'allowMeteredWithAuthorization' && record.billing?.mayBenchmark === true;
    for (const blocker of record.blockers) {
      if (blocker.kind === 'cost' && meteredAllowed) continue;
      // The admitted-identity blocker is decided above, against the query's OWN policy version, so
      // that a record derived under crp1 and queried under crp2 is answered by the query's policy
      // rather than by whichever version happened to derive it. The other identity blocker — a route
      // no run of which had any established identity — is not an admission question and still stands.
      if (blocker.kind === 'identity' && record.identityAdmitted) continue;
      // Availability is re-decided below, against the observations the QUERY was given, because a
      // record derived on one machine carries that machine's availability and this query may be
      // asking about another one.
      if (blocker.kind === 'availability' && resolved !== undefined) continue;
      reasons.push(`${blocker.kind}: ${blocker.reason}`);
    }

    // ---- a LOCAL qualification does not travel, and availability is not the thing that carries it --
    //
    // AVAILABILITY IS RE-DECIDED PER MACHINE; QUALIFICATION IS NOT. A machine-scoped record was
    // derived against one machine's weights digest on one machine's hardware, and its `locality`
    // blocker was decided there. Answering a query about ANOTHER machine — which crc2 exists to
    // allow — must not let a fresh availability observation on that machine stand in for evidence
    // that the local model was ever measured there. The same tag on another machine may be different
    // weights on hardware that cannot hold them, which is precisely what
    // `LOCAL_QUALIFICATION_DOES_NOT_TRANSFER` forbids. So a machine-scoped record is refused outright
    // for any machine but the one it was derived for, and the reason says to re-qualify there.
    if (record.qualificationScope === 'machine' && record.locus?.machineKey !== undefined
        && record.locus.machineKey !== query.machineKey) {
      reasons.push(`locality: ${record.routeKey} is a LOCAL route whose qualification was measured on `
        + `${record.locus.machineKey}, and this query asks about ${query.machineKey}. ${LOCAL_QUALIFICATION_DOES_NOT_TRANSFER}`);
    }

    // ---- availability ON THE MACHINE THE QUERY NAMED --------------------------------------------
    const availability: RouteAvailabilitySource = resolved ?? {
      state: record.availableOnThisMachine.state,
      observedOnMachine: query.machineKey,
      machineLabel: record.availableOnThisMachine.latest?.machineLabel ?? query.machineKey,
      origin: 'observedHere',
      ...(record.availableOnThisMachine.latest === undefined ? {}
        : { observedAt: record.availableOnThisMachine.latest.observedAt }),
      reason: record.availableOnThisMachine.reason,
    };
    if (resolved !== undefined && availability.state !== 'available') {
      reasons.push(`availability: ${availability.reason}`);
    }
    // AN OBSERVATION FROM ANOTHER MACHINE NEVER SATISFIES THIS QUERY. `availabilityOnMachine` already
    // filters on the observer, so this cannot normally happen; it is asserted anyway, because the one
    // bug this whole persistence layer exists to prevent is a fleet view answering "available here"
    // out of somebody else's observation.
    if (availability.observedOnMachine !== query.machineKey) {
      reasons.push(`availability: the only observation offered for ${record.routeKey} was taken on `
        + `${availability.observedOnMachine}, not ${query.machineKey}. An observation made elsewhere is not evidence `
        + 'about this machine, whatever it says.');
    }

    // ---- freshness, where the query asked for it ------------------------------------------------
    if (query.requireFreshDiscovery === true
        && !['currentlyDiscovered', 'provenInStore'].includes(record.discovered.state)) {
      reasons.push(`discovery: the query requires fresh discovery and this route is ${record.discovered.state} — `
        + `${record.discovered.reason} (${ROUTABLE_CONDITION_DESCRIPTIONS.discoveryFresh})`);
    }
    if (query.requireFreshQualification === true && record.staleness !== undefined && !record.staleness.valid) {
      reasons.push(`staleness: the query requires fresh qualification evidence and this route's is stale — `
        + `${record.staleness.detail.join('; ')}`);
    }

    const capability = capabilityOf(record, query.capability);
    if (capability === undefined) reasons.push(`capability: no evidence at all for ${query.capability}`);
    else if (capability.verdict !== 'qualified') reasons.push(`capability: ${query.capability} is ${capability.verdict} — ${capability.reason}`);

    let tier: CapabilityQualification | undefined;
    if (query.structuralTier !== undefined) {
      tier = capabilityOf(record, `workspace-tier:${query.structuralTier}`);
      if (tier === undefined) reasons.push(`tier: no evidence at ${query.structuralTier}`);
      else if (tier.verdict !== 'qualified') reasons.push(`tier: ${query.structuralTier} is ${tier.verdict} — ${tier.reason}`);
    }

    const locality = description?.locality ?? (record.qualificationScope === 'machine' ? 'local' : 'remote');
    if (query.localOnly === true && locality !== 'local') reasons.push('locality: the query is local-only and this route is hosted');

    let contextWindowTokens: number | undefined;
    if (query.minimumContextTokens !== undefined) {
      const context = description?.contextWindowTokens;
      if (context === undefined || context.state === 'unknown') {
        reasons.push(`context: the query needs ${query.minimumContextTokens} tokens and this route's context window is UNKNOWN`
          + `${context?.state === 'unknown' ? ` (${context.reason})` : ''}; an unknown cannot satisfy a requirement`);
      } else {
        contextWindowTokens = context.value;
        if (context.value < query.minimumContextTokens) {
          reasons.push(`context: ${context.value} tokens (${context.source}) is below the ${query.minimumContextTokens} required`);
        }
      }
    } else if (description?.contextWindowTokens.state === 'known') {
      contextWindowTokens = description.contextWindowTokens.value;
    }

    const zeroMarginal = record.billing?.zeroMarginalCost === true;
    if (query.costPolicy === 'zeroMarginalCostOnly' && !zeroMarginal && !reasons.some((reason) => reason.startsWith('cost:'))) {
      reasons.push('cost: the query admits only zero-marginal-cost routes');
    }

    if (reasons.length > 0 || capability === undefined) {
      excluded.push({ routeKey: record.routeKey, reasons });
      continue;
    }
    candidates.push({
      routeKey: record.routeKey,
      group: zeroMarginal ? 'zeroMarginalCost' : 'meteredRequiresAuthorization',
      locality,
      capabilityEvidence: capability,
      tierEvidence: tier,
      contextWindowTokens,
      requiresSpendingAuthorization: record.billing?.requiresSpendingAuthorization ?? !zeroMarginal,
      efficiency: record.efficiency,
      identityConfidence: record.identityConfidence,
      identityAdmitted: record.identityAdmitted,
      ...(record.identityAdmitted ? { identityDisclosure: identity.reason } : {}),
      availability,
      ...(spendPosture ?? record.billing ? { spendPosture: spendPosture ?? record.billing } : {}),
      routingPolicyVersion: policyVersion,
      record,
    });
  }

  const groupRank = (candidate: RouteCandidate): number => (candidate.group === 'zeroMarginalCost' ? 0 : 1);
  candidates.sort((a, b) => groupRank(a) - groupRank(b) || (a.routeKey < b.routeKey ? -1 : a.routeKey > b.routeKey ? 1 : 0));
  excluded.sort((a, b) => (a.routeKey < b.routeKey ? -1 : a.routeKey > b.routeKey ? 1 : 0));
  return {
    contract: ROUTING_CONTRACT_VERSION,
    query,
    routingPolicyVersion: policyVersion,
    candidates,
    excluded,
    ordering: 'zero-marginal-cost group first, then route key; NO preference within a group',
    disclosure: ROUTE_CANDIDATES_ARE_NOT_A_CHOICE,
  };
}

/**
 * Resolve availability for one route on one machine from a persisted store.
 *
 * THE MACHINE ASKED ABOUT IS THE MACHINE ANSWERED ABOUT. Observations are filtered to `machineKey`
 * by `availabilityOnMachine` before anything else happens, so a store holding a hundred observations
 * from a second machine contributes nothing to this answer except, when the route has never been
 * observed here, the `neverObserved` state that says so.
 */
export function availabilityFromStore(contents: ObservationStoreContents, routeKey: string, machineKey: string,
                                      now: Date, maxAge?: number): RouteAvailabilitySource {
  const observations = availabilityObservationsFrom(contents);
  const availability: MachineAvailability = availabilityOnMachine(observations, routeKey, machineKey, now, maxAge);
  const stored = contents.observations
    .filter((entry) => entry.record.routeKey === routeKey && entry.record.machineKey === machineKey
      && (entry.record.kind === 'routeAvailability' || entry.record.kind === 'localModelAvailability'))
    .sort((a, b) => compareCodePoints(a.record.observedAt, b.record.observedAt));
  const latest = stored[stored.length - 1];
  return {
    state: availability.state,
    observedOnMachine: machineKey,
    machineLabel: availability.latest?.machineLabel ?? latest?.record.machineLabel ?? machineKey,
    origin: latest?.origin ?? 'observedHere',
    ...(availability.latest === undefined ? {} : { observedAt: availability.latest.observedAt }),
    ...(latest?.importedFromMachine === undefined ? {} : { importedFromMachine: latest.importedFromMachine }),
    reason: availability.reason,
  };
}

/**
 * Answer a query against a persisted observation store.
 *
 * The convenience over `qualifiedRouteCandidates` is only that availability is resolved from the
 * store rather than by the caller; every rule above is the same one, applied to the same values. A
 * caller with observations in hand and no store on disk uses the pure function directly.
 */
export function qualifiedRouteCandidatesFromStore(query: RouteCandidateQuery, contents: ObservationStoreContents,
                                                  routes: { record: RouteQualificationRecord; description?: ModelDescription;
                                                    spendPosture?: RouteSpendPosture }[],
                                                  now: Date): RouteCandidateSet {
  return qualifiedRouteCandidates(query, routes.map((route) => ({
    ...route,
    availability: availabilityFromStore(contents, route.record.routeKey, query.machineKey, now,
      query.maximumAvailabilityAgeMilliseconds),
  })));
}

/** The availability observations a store holds, re-exported so a caller needs one import, not two. */
export function observationsForRouting(contents: ObservationStoreContents): RouteAvailabilityObservation[] {
  return availabilityObservationsFrom(contents);
}
