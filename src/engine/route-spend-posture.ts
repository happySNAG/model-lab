// Benchmark engine · FOUR QUESTIONS ABOUT MONEY, kept apart so that answering one never answers another.
//
// THE CONFLICT THIS RECONCILES. The V1 benchmark line added a cost gate (`cost-eligibility.ts`) that, when a
// campaign freezes a cost policy, refuses `metered` and `unknown_cost` candidates at the point a request
// would leave. The workspace qualification line deliberately keeps metered routes — the OpenAI API identity ladder, a
// metered OpenCode request under `--authorize-metered`, and a future OpenAI API workspace path — because a
// metered route is a real route somebody may choose to pay for. Read naively, the two contradict each
// other: one says metered routes must not run, the other depends on them running.
//
// THEY DO NOT CONTRADICT, BECAUSE THEY ANSWER DIFFERENT QUESTIONS, and the fix is to name the questions:
//
//   A  ROUTE EXISTS              Always yes for a route discovery can name. A metered route is never
//                                structurally absent: it is discovered, described, priced and shown.
//   B  ROUTE MAY BE BENCHMARKED  Yes at zero marginal cost. For a metered or unknown-cost route, ONLY
//                                under an explicit, written override of the cost policy for that exact
//                                route (`CostPolicyOverride`) — and, for every metered request, the
//                                spending authorization and hard ceiling `SpendTracker` already enforces.
//                                That is how the metered paths stay usable and the benchmark line's gate
//                                stays shut by default: the override is the explicit act that opens it.
//   C  ROUTE MAY BE AUTO-SPENT   Only at zero marginal cost — `local`, `subscription_included`, and a
//                                CURRENT `free_confirmed`. Nothing that bills per token is ever spent
//                                automatically, overridden or not: an override authorises a benchmark a
//                                person asked for, not a scheduler's future requests.
//   D  ROUTE MAY BE ROUTED       As C, AND qualified for the task. This module answers the money half;
//      BY DEFAULT                `routing-contract.ts` refuses a route whose qualification is missing,
//                                whatever this says. Zero marginal cost never stands in for evidence.
//
// NOTHING HERE READS A SCORE, and nothing in a scoring module reads this — the same separation
// `cost-eligibility.ts` states for its own gate.

import {
  CostEligibility, CostPolicyOverride, ZeroMarginalCostConfirmation, costEligibilityFor,
  zeroMarginalCostConfirmationFreshness,
} from './cost-eligibility';
import { ProviderID } from './provider';

export interface RouteSpendPosture {
  eligibility: CostEligibility;
  /** A. Always true: a route discovery can name exists, whoever pays for it. */
  routeExists: true;
  /** B. May a person-requested benchmark send requests on this route? */
  mayBenchmark: boolean;
  /** C. May an automatic process spend on it without a person approving each run? */
  mayAutoSpend: boolean;
  /** D (money half). May a router pick it by default, subject to qualification? */
  mayRouteByDefault: boolean;
  /** True for every metered request: a recorded spending authorization and a hard ceiling are required. */
  requiresSpendingAuthorization: boolean;
  zeroMarginalCost: boolean;
  /** Every reason, in words, for every answer above. */
  reasons: string[];
}

export const ZERO_MARGINAL_COST_ELIGIBILITIES: CostEligibility[] = ['local', 'subscription_included', 'free_confirmed'];

export function routeSpendPosture(options: {
  provider: ProviderID;
  modelID: string;
  confirmations?: ZeroMarginalCostConfirmation[];
  overrides?: CostPolicyOverride[];
  now: Date;
}): RouteSpendPosture {
  const reasons: string[] = [];
  let verdict;
  try {
    verdict = costEligibilityFor(options);
  } catch (error) {
    // A confirmation that fails validation confirms nothing, and the route falls back to what it is
    // without one. It is reported, never thrown away.
    reasons.push(`a zero-marginal-cost confirmation was supplied and refused: ${error instanceof Error ? error.message : String(error)}`);
    verdict = costEligibilityFor({ ...options, confirmations: [] });
  }
  reasons.push(verdict.reason);
  let eligibility = verdict.eligibility;

  // A free_confirmed route whose observation has aged out is NOT free any more, for the purpose of
  // spending without asking. It is still a metered route that may be benchmarked under an override.
  let freeIsCurrent = true;
  if (eligibility === 'free_confirmed') {
    const confirmation = (options.confirmations ?? []).find((entry) => entry.provider === options.provider && entry.modelID === options.modelID);
    const freshness = confirmation === undefined ? { fresh: false, reason: 'no confirmation found' }
      : zeroMarginalCostConfirmationFreshness(confirmation, options.now);
    if (!freshness.fresh) {
      freeIsCurrent = false;
      reasons.push(`the zero-marginal-cost confirmation is no longer current: ${freshness.reason}`);
      eligibility = 'metered';
    }
  }

  const zeroMarginalCost = ZERO_MARGINAL_COST_ELIGIBILITIES.includes(eligibility) && freeIsCurrent;
  const overridden = verdict.overriddenBy !== undefined
    || (eligibility === 'metered' && (options.overrides ?? []).some((entry) => entry.provider === options.provider
      && entry.modelID === options.modelID && entry.overrides === 'metered' && entry.authorizedBy.trim().length > 0));
  const mayBenchmark = zeroMarginalCost || overridden;
  if (!zeroMarginalCost) {
    reasons.push(overridden
      ? 'benchmarking is permitted by an explicit written override for this exact route; every request still needs the '
        + 'campaign\'s recorded spending authorization and stops at its hard ceiling'
      : 'this route bills per token (or nobody established who pays). It EXISTS and may be discovered, described and priced; '
        + 'it may be benchmarked only under an explicit written override for this exact route, and is never auto-spent or '
        + 'routed by default');
  }
  return {
    eligibility,
    routeExists: true,
    mayBenchmark,
    mayAutoSpend: zeroMarginalCost,
    mayRouteByDefault: zeroMarginalCost,
    requiresSpendingAuthorization: eligibility === 'metered' || eligibility === 'unknown_cost',
    zeroMarginalCost,
    reasons,
  };
}
