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

import { CapabilityQualification, RouteQualificationRecord } from './route-qualification';
import { ModelDescription } from './model-description';
import { WorkspaceDifficultyTier } from './workspace-difficulty';

export const ROUTING_CONTRACT_VERSION = 'crc1';

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
  /** The full record, so a consumer never has to trust this summary alone. */
  record: RouteQualificationRecord;
}

export interface RouteCandidateSet {
  contract: typeof ROUTING_CONTRACT_VERSION;
  query: RouteCandidateQuery;
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

/** Answer one query. PURE over the records given; reads nothing, writes nothing, picks nothing. */
export function qualifiedRouteCandidates(query: RouteCandidateQuery,
                                         routes: { record: RouteQualificationRecord; description?: ModelDescription }[]): RouteCandidateSet {
  const candidates: RouteCandidate[] = [];
  const excluded: RouteCandidateSet['excluded'] = [];

  for (const { record, description } of routes) {
    const reasons: string[] = [];
    // EVERY BLOCKER BUT COST IS ABSOLUTE. Cost is relaxed only when the query explicitly allows metered
    // routes, and then only for a route whose spend posture permits a person-approved benchmark.
    const meteredAllowed = query.costPolicy === 'allowMeteredWithAuthorization' && record.billing?.mayBenchmark === true;
    for (const blocker of record.blockers) {
      if (blocker.kind === 'cost' && meteredAllowed) continue;
      reasons.push(`${blocker.kind}: ${blocker.reason}`);
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
      record,
    });
  }

  const groupRank = (candidate: RouteCandidate): number => (candidate.group === 'zeroMarginalCost' ? 0 : 1);
  candidates.sort((a, b) => groupRank(a) - groupRank(b) || (a.routeKey < b.routeKey ? -1 : a.routeKey > b.routeKey ? 1 : 0));
  excluded.sort((a, b) => (a.routeKey < b.routeKey ? -1 : a.routeKey > b.routeKey ? 1 : 0));
  return {
    contract: ROUTING_CONTRACT_VERSION,
    query,
    candidates,
    excluded,
    ordering: 'zero-marginal-cost group first, then route key; NO preference within a group',
    disclosure: ROUTE_CANDIDATES_ARE_NOT_A_CHOICE,
  };
}
