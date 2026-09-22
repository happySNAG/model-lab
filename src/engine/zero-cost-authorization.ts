// Benchmark engine · THE AUTHORIZATION TO BENCHMARK A FREE ROUTE, and the careful distance between
// that authorization and the evidence a route is actually free.
//
// TWO THINGS THAT LOOK LIKE ONE. A person saying "benchmark my free OpenCode routes" is a PERMISSION.
// A route costing this account nothing at the margin is a FACT. Collapsing them is the easiest
// mistake in this whole system to make and the hardest to see afterwards, because the collapsed
// version reads perfectly: the owner authorized free routes, this route is listed at $0, therefore
// Cernum may spend on it automatically. Every step there is wrong in the same way — none of them
// looked at what the provider actually billed this credential.
//
// SO THE AUTHORIZATION IS RECORDED HERE, AND IT PROVES NOTHING. `ZERO_COST_BENCHMARK_AUTHORIZATION`
// is the owner's own words, kept verbatim. `AUTHORIZATION_IS_NOT_EVIDENCE` is the rule that goes with
// it, and `assertConfirmationIsObserved` refuses to let the authorization stand in for the reading.
// A `ZeroMarginalCostConfirmation` still has to name the account, name the billing record that was
// read, carry when it was read and who read it, and bind to the EXACT route — all of which
// `cost-eligibility.ts` already validates and none of which this authorization supplies.
//
// AND IT EXPIRES TWICE OVER. By the calendar, thirty days, because a free tier is a commercial
// decision that changes on no schedule. And by OBSERVATION: a discovery refresh that sees this
// route's published price or free status move stales the confirmation immediately, however young it
// is — see `confirmationStaledByDelta`. The second is the one that matters, because the day a free
// tier starts charging is not the day anybody re-reads a billing page.

import { ZeroMarginalCostConfirmation, zeroMarginalCostConfirmationFreshness } from './cost-eligibility';
import { DiscoveryDelta } from './discovery-refresh';
import { ProviderID } from './provider';

/**
 * The owner's authorization, verbatim.
 *
 * Kept as the words that were actually written rather than a summary of them, because a summary is a
 * second author's reading of a permission, and the whole point of recording a permission is that
 * somebody later can check what was given rather than what somebody thought was given.
 */
export const ZERO_COST_BENCHMARK_AUTHORIZATION = {
  authorizedAt: '2026-09-22',
  authorizedBy: 'the repository owner, in writing, in the Pass 8 governance prompt',
  scope: 'Decision 2 — OpenCode routes established to be available to the configured account at zero marginal cost',
  words:
    'I authorize Cernum to benchmark OpenCode routes that Cernum has directly established are available to my configured '
    + 'account at zero marginal cost. A public price listing alone is not sufficient evidence. Each zero-marginal-cost '
    + 'confirmation must bind to the exact route, the account-access observation, its provenance and timestamp, and must '
    + 'expire or become stale when billing/free-status evidence materially changes.',
} as const;

/**
 * The rule the authorization is READ under. Quoted wherever the authorization is.
 *
 * Stated as its own constant so that a surface printing the permission cannot print it alone: the two
 * are always shown together, and a reader who meets the first has met the second.
 */
export const AUTHORIZATION_IS_NOT_EVIDENCE =
  'This authorization is a PERMISSION, not a finding. It does not establish that any particular route costs anything or '
  + 'nothing. It permits Cernum to benchmark a route it has SEPARATELY established, by reading the account\'s own billing '
  + 'or usage record, to be zero marginal cost for this credential. No route becomes free by being inside the scope of '
  + 'this authorization, and a published $0 catalogue price remains a statement of intent by a provider rather than '
  + 'evidence of what this account was billed.';

/** What a confirmation may NOT be created from, in this pass. Each is refused by a named check. */
export const NOT_SUFFICIENT_EVIDENCE_OF_ZERO_COST: string[] = [
  'the authorization above, on its own',
  'a published catalogue or list price of $0, however current',
  'a free-tier announcement, a documentation page or a pricing file',
  'a model\'s own reply about what it costs',
  'an inference request made to prove the route is free — which spends the thing it is trying to measure',
];

export class ZeroCostAuthorizationError extends Error {
  constructor(readonly code: 'authorizationOfferedAsEvidence' | 'routeOutsideAuthorization' | 'inferenceWouldBeRequired',
              message: string) {
    super(message);
    this.name = 'ZeroCostAuthorizationError';
  }
}

/**
 * Is this exact route inside the scope the owner authorized?
 *
 * SCOPE IS NOT EVIDENCE EITHER, and the return value says so in its own field names. A route inside
 * the scope may be benchmarked ONCE a confirmation exists for it; a route outside the scope may not
 * be benchmarked even if somebody produces one.
 */
export function routeIsInsideAuthorization(provider: ProviderID, modelID: string):
  { insideScope: boolean; stillNeedsObservation: true; reason: string } {
  const inside = provider === 'opencodeCLI';
  return {
    insideScope: inside,
    stillNeedsObservation: true,
    reason: inside
      ? `${modelID} on ${provider} is inside the scope the owner authorized. ${AUTHORIZATION_IS_NOT_EVIDENCE}`
      : `${modelID} on ${provider} is OUTSIDE the scope of ${ZERO_COST_BENCHMARK_AUTHORIZATION.scope}, which names `
        + 'OpenCode routes only. A confirmation for it would need its own written authorization.',
  };
}

/**
 * Refuse a confirmation that offers the authorization, or a price, as the thing it observed.
 *
 * `cost-eligibility.ts` already refuses the obvious published-price spellings. This adds the one
 * this pass creates: somebody pasting the owner's own authorization into `observedBillingRecord`,
 * which reads like consent and contains no observation at all.
 */
export function assertConfirmationIsObserved(confirmation: ZeroMarginalCostConfirmation): void {
  const haystack = confirmation.observedBillingRecord.toLowerCase();
  // NARROW ON PURPOSE. This catches somebody pasting the owner's CONSENT where an observation
  // belongs. It deliberately does not match the bare words 'authorization' or 'permission', because a
  // real billing record says them for real reasons — a card authorization hold, a pre-authorization
  // line item, an `Authorization` column in a usage export — and refusing a genuine reading teaches
  // the person to reword it rather than to read the account.
  const tells = ['i authorize cernum', 'i authorize', 'the owner authorized', 'the repository owner authorized',
    'authorized by the owner', 'this authorization'];
  const tell = tells.find((phrase) => haystack.includes(phrase));
  if (tell !== undefined) {
    throw new ZeroCostAuthorizationError('authorizationOfferedAsEvidence',
      `${confirmation.modelID}: the confirmation cites '${tell}', which is the AUTHORIZATION and not an observation. `
      + `${AUTHORIZATION_IS_NOT_EVIDENCE} Name the billing or usage record you read — the statement period, the invoice, `
      + 'the usage export, the dashboard page and the day you read it.');
  }
}

/**
 * Would proving this route free require sending an inference request?
 *
 * THE ANSWER DECIDES WHETHER THIS PASS MAY PROCEED. A non-inference command — an account, billing or
 * status subcommand that reports what the credential is entitled to — may be inspected read-only and
 * can establish the fact. Anything that requires a completion cannot be done here: it would spend the
 * allowance the confirmation is meant to characterise, and the answer would describe a request that
 * was made to produce it rather than the account's ordinary billing.
 */
export function zeroCostEvidencePath(provider: ProviderID): {
  availableWithoutInference: boolean; reason: string;
} {
  if (provider !== 'opencodeCLI') {
    return { availableWithoutInference: false,
      reason: `${provider} is outside this authorization; no evidence path is defined for it here.` };
  }
  return {
    availableWithoutInference: false,
    reason:
      'As of this pass, no OpenCode subcommand reports what the configured credential is BILLED. `opencode models` '
      + 'prints the cached catalogue — a published price list, explicitly not sufficient — and `opencode auth list` '
      + 'reports which providers have a credential stored, not what any of them charges. Establishing zero marginal '
      + 'cost for a route therefore still requires either a reading of the account\'s billing page by a person, or an '
      + 'inference request. An inference request is REFUSED in a development pass: it spends the allowance it is '
      + 'meant to characterise. Creation of a confirmation is left to the live qualification pass, where a person '
      + 'reads the account and signs for what they read.',
  };
}

/** Refuse, in words, to manufacture a confirmation from an inference request during development. */
export function refuseInferenceToProveCost(provider: ProviderID, modelID: string): ZeroCostAuthorizationError {
  return new ZeroCostAuthorizationError('inferenceWouldBeRequired',
    `${modelID} on ${provider}: proving zero marginal cost here would require sending a real request, which this pass `
    + 'does not do. No confirmation was created, and none was fabricated. Re-run this in the live qualification pass '
    + 'with a reading of the account\'s own billing record.');
}

export type ZeroCostStalenessReason =
  | 'confirmationCurrent'
  | 'confirmationExpiredByAge'
  | 'publishedPriceChanged'
  | 'publishedFreeStatusChanged'
  | 'routeNoLongerListed';

/**
 * Is this confirmation still current, given both the calendar AND what discovery has since seen?
 *
 * THE DELTA IS THE STRONGER SIGNAL AND IS CHECKED FIRST. A confirmation read yesterday is worthless
 * if this morning's refresh saw the route's published price move off zero: the reading describes a
 * commercial arrangement that has since changed, and its youth is no argument. Every applicable
 * reason is returned, not the first, so a confirmation that is both aged out and contradicted says so
 * twice rather than sending somebody to re-read a page that will not help.
 */
export function confirmationStaledByDelta(confirmation: ZeroMarginalCostConfirmation, delta: DiscoveryDelta | undefined,
                                          now: Date): { current: boolean; reasons: ZeroCostStalenessReason[]; detail: string[] } {
  const reasons: ZeroCostStalenessReason[] = [];
  const detail: string[] = [];

  if (delta !== undefined && delta.routeKey === `${confirmation.provider}:${confirmation.modelID}`) {
    if (delta.kinds.includes('priceChanged')) {
      reasons.push('publishedPriceChanged');
      detail.push(`the published price of ${delta.routeKey} moved since this was confirmed (${delta.detail.join('; ')}). `
        + 'A price change is a change to the commercial arrangement the confirmation described; re-read the account.');
    }
    if (delta.kinds.includes('freeStatusChanged')) {
      reasons.push('publishedFreeStatusChanged');
      detail.push(`the published free status of ${delta.routeKey} changed (${delta.detail.join('; ')}). Whether or not `
        + 'the published figure was ever the basis of this confirmation, it is now evidence that the arrangement moved.');
    }
    if (delta.kinds.includes('disappeared')) {
      reasons.push('routeNoLongerListed');
      detail.push(`${delta.routeKey} is no longer listed, so there is no route for the confirmation to be about.`);
    }
  }

  const freshness = zeroMarginalCostConfirmationFreshness(confirmation, now);
  if (!freshness.fresh) {
    reasons.push('confirmationExpiredByAge');
    detail.push(freshness.reason);
  }
  if (reasons.length === 0) {
    return { current: true, reasons: ['confirmationCurrent'], detail: [freshness.reason] };
  }
  return { current: false, reasons, detail };
}
