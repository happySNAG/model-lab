// Cernum · COST ELIGIBILITY — may this candidate be EXECUTED, given who pays for it?
//
// This is an EXECUTION GATE, not a measurement. Nothing here reads, weights, adjusts or filters a
// score, and nothing here is allowed to: a model's quality is what it is regardless of who paid for
// the request that measured it, and a cost rule that quietly changed a ranking would be the worst
// kind of bias — invisible, well-intentioned, and baked into the numbers. `qualifies()` answers one
// question, "may this be run", and every scoring module is forbidden to import it.
//
// -- WHY `billingBasis` WAS NOT ENOUGH -----------------------------------------------------------
//
// `BillingBasis` already distinguishes local, subscription-included and metered, and it is derived
// STRUCTURALLY from the provider: `executionClassOf('opencodeCLI')` is `meteredAPI` and always will
// be. That is the right answer to "how is this provider billed" and the wrong answer to "will THIS
// ACCOUNT be charged for THIS request", which is the question a spending policy actually turns on.
// Two states are missing from it, and both of them are the ones that matter here:
//
//   free_confirmed  a metered provider that has been CONFIRMED to cost this account nothing at the
//                   margin. Not derivable from the provider, because it is a fact about a credential
//                   and an account, not about an interface.
//   unknown_cost    nothing established who pays. The honest default, and the one `BillingBasis` has
//                   no room for — it must return one of three values, so an unclassifiable candidate
//                   would have to be called metered (a claim) or subscription (a worse claim).
//
// So this module sits BESIDE `BillingBasis` and does not replace it. The manifest keeps recording
// the structural fact; this decides whether the run may happen at all.
//
// -- FAIL-CLOSED, AND WHERE THE DEFAULT POINTS ---------------------------------------------------
//
// The default is `unknown_cost` and `unknown_cost` is BLOCKED. A candidate reaches an authorized
// state by being classified into one, never by failing to be classified out of one. This is the same
// shape as `admissionFor`: refusal is what happens when the answer is unclear for any reason.

import { BillingBasis, ExecutionClass, ProviderID, executionClassOf } from './provider';

/**
 * The five states a candidate's cost eligibility can be in.
 *
 * Snake case, deliberately, and the only snake-case identifiers in the engine. These five names were
 * given by the person who set the policy, and a policy is easier to audit when the value in the code
 * is the same string the person wrote down than when it has been translated into house style on the
 * way in.
 */
export type CostEligibility =
  /** A hosted model CONFIRMED to cost this account nothing at the margin. See `ZeroMarginalCostConfirmation`. */
  | 'free_confirmed'
  /** Covered by a subscription the user already pays for. Marginal API charge $0; a finite allowance is consumed. */
  | 'subscription_included'
  /** Runs on this machine. No monetary cost at all; wall-clock time and hardware are still spent. */
  | 'local'
  /** Billed per token against a credential. Blocked unless explicitly overridden. */
  | 'metered'
  /** Nothing established who pays. The default, and blocked. */
  | 'unknown_cost';

export const COST_ELIGIBILITIES: CostEligibility[] = [
  'free_confirmed', 'subscription_included', 'local', 'metered', 'unknown_cost',
];

/**
 * The three states authorized for this project, as set on 2026-09-20.
 *
 * `metered` and `unknown_cost` are blocked from EXECUTION and are not blocked from being planned,
 * priced, discovered, listed or reasoned about — a cohort you may not run is still a cohort you must
 * be able to see and cost, and a policy that hid them would make the excluded set invisible.
 */
export const AUTHORIZED_COST_ELIGIBILITIES: CostEligibility[] = [
  'free_confirmed', 'subscription_included', 'local',
];

export const BLOCKED_COST_ELIGIBILITIES: CostEligibility[] = ['metered', 'unknown_cost'];

export function isAuthorizedCostEligibility(eligibility: CostEligibility): boolean {
  return AUTHORIZED_COST_ELIGIBILITIES.includes(eligibility);
}

export const COST_ELIGIBILITY_LABELS: Record<CostEligibility, string> = {
  free_confirmed: 'free (confirmed) · no marginal charge to this account, and something checked',
  subscription_included: 'subscription-included · marginal API charge $0, consumes a finite allowance',
  local: 'local · no monetary cost, wall-clock time and hardware still spent',
  metered: 'metered · billed per token against a credential',
  unknown_cost: 'UNKNOWN COST · nothing established who pays, so this is treated as chargeable',
};

/**
 * WHAT IT TAKES TO EARN `free_confirmed`, AND WHY A PUBLISHED $0 IS NOT ENOUGH.
 *
 * A published catalogue price is a statement by the provider about what it INTENDS to charge. It is
 * not a fact about this credential, it may be stale the moment after it is read, a free tier can
 * meter into a paid overflow, and a zero in a price list has never been an observation that zero was
 * billed. Cernum already says this in three separate constants — `PUBLISHED_PRICE_IS_NOT_A_MEASURED_
 * CHARGE`, `ZERO_LIST_PRICE_DOES_NOT_MEAN_ZERO_BILL`, `POST_RUN_RECONCILIATION_REQUIRED` — and this
 * gate is where those sentences finally stop something.
 *
 * So `free_confirmed` requires an OBSERVATION of the account's own billing, not a reading of a price
 * list, and it names who looked and when. The fields are all required and all refused when empty,
 * for the same reason an admission record refuses missing provenance: a weaker claim needs MORE
 * evidence than a stronger one, because the evidence is the only thing a reader can judge it by.
 */
export interface ZeroMarginalCostConfirmation {
  provider: ProviderID;
  /** The exact identifier confirmed. Per configuration, never per provider — as with identity admission. */
  modelID: string;
  /**
   * The account or credential this was confirmed for, in words a person can check.
   *
   * A confirmation is about a credential. The same model on a different key is a different question,
   * and this field is what stops one account's free tier being read as another's.
   */
  accountBasis: string;
  /**
   * WHAT WAS READ. The provider's own usage or billing record, named exactly — a statement period, an
   * invoice, a usage export, a dashboard page and the day it was read.
   *
   * NOT a price list, NOT a catalogue entry, NOT documentation, and NOT a figure the model's own
   * reply reported about itself. `assertObservedNotPublished` refuses the obvious spellings of those.
   */
  observedBillingRecord: string;
  observedAt: string;
  /** The person who read it and is staking the claim. A confirmation nobody signed is nobody's claim. */
  confirmedBy: string;
}

export class CostPolicyError extends Error {
  constructor(readonly code:
    | 'notAuthorized' | 'missingConfirmationField' | 'publishedPriceOfferedAsObservation'
    | 'confirmationForAnotherCandidate' | 'confirmationOnUnmeteredProvider' | 'overrideNotAuthorized',
  message: string) {
    super(message);
    this.name = 'CostPolicyError';
  }
}

/**
 * Wordings that mean a price list was read, offered where an observed charge is required.
 *
 * Matched case-insensitively against `observedBillingRecord`. This cannot catch a determined author
 * and is not trying to: it catches the HONEST MISTAKE, which is somebody pasting the pricing
 * provenance string Cernum already prints — the one that says PUBLISHED LIST PRICE in capitals —
 * into the field that is supposed to hold the opposite kind of evidence.
 */
const PUBLISHED_PRICE_TELLS = [
  'published list price', 'list price', 'catalogue price', 'catalog price', 'price list',
  'pricing file', 'models.json', 'published price', 'documentation', 'docs.',
];

/** Refuse a confirmation that is a price list wearing an observation's name. */
export function assertObservedNotPublished(confirmation: ZeroMarginalCostConfirmation): void {
  const haystack = confirmation.observedBillingRecord.toLowerCase();
  const tell = PUBLISHED_PRICE_TELLS.find((phrase) => haystack.includes(phrase));
  if (tell !== undefined) {
    throw new CostPolicyError('publishedPriceOfferedAsObservation',
      `${confirmation.modelID}: the confirmation cites '${tell}', which is a PUBLISHED PRICE and not an `
      + 'observed charge. free_confirmed requires the account\'s own billing or usage record — what the '
      + 'provider actually billed this credential — because a published zero is a statement of intent and a '
      + 'free tier can meter into a paid overflow. Read the account, not the price list.');
  }
}

/**
 * HOW LONG A ZERO-MARGINAL-COST OBSERVATION IS GOOD FOR.
 *
 * A free tier is a commercial decision, and it changes on no schedule: OpenCode's catalogue dropped
 * Union Alpha between two readings. So a confirmation is a statement about a MOMENT, exactly like a
 * discovery proof, and it expires. Thirty days is chosen against how often an account's billing record
 * can sensibly be re-read by a person; a discovery refresh that sees the route's published price or free
 * status change stales it earlier than that — see `discovery-refresh.ts`.
 */
export const ZERO_MARGINAL_COST_CONFIRMATION_MAX_AGE_MILLISECONDS = 30 * 24 * 60 * 60 * 1_000;

/** Whether a confirmation is still current. An undated one cannot be shown to be, so it is not. */
export function zeroMarginalCostConfirmationFreshness(confirmation: Pick<ZeroMarginalCostConfirmation, 'modelID' | 'observedAt'>,
                                                      now: Date,
                                                      maxAge = ZERO_MARGINAL_COST_CONFIRMATION_MAX_AGE_MILLISECONDS):
  { fresh: boolean; reason: string } {
  const at = Date.parse(confirmation.observedAt);
  if (Number.isNaN(at)) {
    return { fresh: false, reason: `${confirmation.modelID}: the zero-marginal-cost observation carries no readable date `
      + `('${confirmation.observedAt}'), so it cannot be shown to be current. Re-read the account's billing record.` };
  }
  const age = now.getTime() - at;
  if (age > maxAge) {
    return { fresh: false, reason: `${confirmation.modelID}: the zero-marginal-cost observation was made ${confirmation.observedAt}, `
      + `${Math.floor(age / 86_400_000)} day(s) ago, and expires after ${Math.floor(maxAge / 86_400_000)}. A free tier changes on no `
      + 'schedule; re-read the account\'s billing record before treating this route as free.' };
  }
  return { fresh: true, reason: `observed ${confirmation.observedAt}, within ${Math.floor(maxAge / 86_400_000)} days` };
}

/** Every field is required. An unsigned, unsourced, undated confirmation confirms nothing. */
export function validateZeroMarginalCostConfirmation(confirmation: ZeroMarginalCostConfirmation): void {
  const missing = ([
    ['modelID', confirmation.modelID], ['accountBasis', confirmation.accountBasis],
    ['observedBillingRecord', confirmation.observedBillingRecord],
    ['observedAt', confirmation.observedAt], ['confirmedBy', confirmation.confirmedBy],
  ] as [string, string][]).filter(([, value]) => value.trim().length === 0).map(([name]) => name);
  if (missing.length > 0) {
    throw new CostPolicyError('missingConfirmationField',
      `${confirmation.modelID || '(unnamed)'}: a zero-marginal-cost confirmation must carry `
      + `${missing.join(', ')}. This is the evidence that a metered provider costs this account nothing, `
      + 'and it is the only thing a later reader will have to judge that claim by.');
  }
  // A confirmation on a provider that is not metered is not wrong so much as meaningless, and a
  // meaningless record beside a real one teaches a reader to skim both.
  if (executionClassOf(confirmation.provider) !== 'meteredAPI') {
    throw new CostPolicyError('confirmationOnUnmeteredProvider',
      `${confirmation.modelID}: ${confirmation.provider} is not a metered provider, so a zero-marginal-cost `
      + 'confirmation on it claims nothing. free_confirmed exists only to rescue a METERED candidate.');
  }
  assertObservedNotPublished(confirmation);
}

/**
 * An explicit, written override permitting blocked execution.
 *
 * Deliberately awkward to produce. It names the exact candidate, carries the author's own words, and
 * is never inferred from a flag, an environment variable or the mere presence of a pricing file.
 * The policy says `metered` and `unknown_cost` are blocked "unless I explicitly override this policy
 * in the future"; this is the shape that future override has to take.
 */
export interface CostPolicyOverride {
  provider: ProviderID;
  modelID: string;
  /** Which blocked state is being overridden. An override for `metered` does not cover `unknown_cost`. */
  overrides: 'metered' | 'unknown_cost';
  authorizedBy: string;
  authorizedAt: string;
  reason: string;
}

export interface CostEligibilityVerdict {
  eligibility: CostEligibility;
  authorized: boolean;
  /** Why, in words a person can act on. Always populated, including on the authorized path. */
  reason: string;
  /** Present only when a blocked state was permitted by an explicit override. */
  overriddenBy?: CostPolicyOverride;
}

/**
 * Classify one candidate.
 *
 * THE ORDER MATTERS AND IS NOT ALPHABETICAL. Local and subscription are decided structurally, from
 * the execution class, because for those two the provider genuinely does settle the question. Only a
 * metered provider consults a confirmation, and only an exact match on provider AND model rescues
 * it. Everything that falls through is `unknown_cost`.
 */
export function costEligibilityFor(options: {
  provider: ProviderID;
  modelID: string;
  /** Supplied when the caller already computed it; recomputed from the provider when absent. */
  executionClass?: ExecutionClass;
  confirmations?: ZeroMarginalCostConfirmation[];
  overrides?: CostPolicyOverride[];
}): CostEligibilityVerdict {
  const executionClass = options.executionClass ?? executionClassOf(options.provider);

  if (executionClass === 'localRuntime') {
    return { eligibility: 'local', authorized: true,
      reason: 'runs on this machine: no request leaves it and no credential is spent' };
  }
  if (executionClass === 'subscriptionCLI') {
    return { eligibility: 'subscription_included', authorized: true,
      reason: 'reached through the user\'s own already-authenticated first-party CLI session, so the marginal '
        + 'API charge is $0. It is NOT free: a finite subscription allowance is consumed by every attempt.' };
  }

  if (executionClass === 'meteredAPI') {
    const confirmation = (options.confirmations ?? []).find((entry) =>
      entry.provider === options.provider && entry.modelID === options.modelID);
    if (confirmation !== undefined) {
      // Validated HERE and not only at the point it was written, so a confirmation that was edited
      // after the fact, or assembled in memory by a caller, still has to pass the same bar.
      validateZeroMarginalCostConfirmation(confirmation);
      return { eligibility: 'free_confirmed', authorized: true,
        reason: `confirmed zero marginal cost for ${confirmation.accountBasis} against `
          + `${confirmation.observedBillingRecord}, read ${confirmation.observedAt} by ${confirmation.confirmedBy}` };
    }
    const override = findOverride(options.overrides, options.provider, options.modelID, 'metered');
    return {
      eligibility: 'metered',
      authorized: override !== undefined,
      overriddenBy: override,
      reason: override !== undefined
        ? `metered execution explicitly overridden by ${override.authorizedBy} on ${override.authorizedAt}: ${override.reason}`
        : `${options.modelID} on ${options.provider} is billed per token against a credential, and no `
          + 'zero-marginal-cost confirmation names this exact configuration. A published $0 catalogue price is '
          + 'NOT such a confirmation. Blocked by the project cost policy.',
    };
  }

  // Unreachable while `ExecutionClass` has three members, and kept because the day a fourth is added
  // is exactly the day something must refuse rather than guess. A new execution class arrives here
  // and is blocked until somebody classifies it deliberately.
  const override = findOverride(options.overrides, options.provider, options.modelID, 'unknown_cost');
  return {
    eligibility: 'unknown_cost',
    authorized: override !== undefined,
    overriddenBy: override,
    reason: override !== undefined
      ? `unknown-cost execution explicitly overridden by ${override.authorizedBy} on ${override.authorizedAt}: ${override.reason}`
      : `nothing established who pays for ${options.modelID} on ${options.provider}. An unclassified candidate is `
        + 'treated as chargeable, which is the safe direction to be wrong in.',
  };
}

function findOverride(
  overrides: CostPolicyOverride[] | undefined, provider: ProviderID, modelID: string,
  state: 'metered' | 'unknown_cost',
): CostPolicyOverride | undefined {
  return (overrides ?? []).find((entry) =>
    entry.provider === provider && entry.modelID === modelID && entry.overrides === state
    && entry.authorizedBy.trim().length > 0 && entry.reason.trim().length > 0);
}

/** The gate itself. Throws with the reason, or returns the verdict for the manifest to record. */
export function assertCostEligibilityAuthorized(options: {
  candidate: string;
  provider: ProviderID;
  modelID: string;
  executionClass?: ExecutionClass;
  confirmations?: ZeroMarginalCostConfirmation[];
  overrides?: CostPolicyOverride[];
}): CostEligibilityVerdict {
  const verdict = costEligibilityFor(options);
  if (!verdict.authorized) {
    throw new CostPolicyError('notAuthorized',
      `${options.candidate} is ${verdict.eligibility} and this project authorizes only `
      + `${AUTHORIZED_COST_ELIGIBILITIES.join(', ')}. ${verdict.reason}`);
  }
  return verdict;
}

/**
 * The structural billing basis this eligibility must agree with.
 *
 * Both facts are recorded and they answer different questions, so they are allowed to differ in
 * exactly one direction: a `meteredAPI` binding may be `free_confirmed`, because a confirmation is
 * about an account and the binding is about an interface. Nothing else may differ, and this is where
 * a future edit that let `local` drift onto a metered provider gets caught.
 */
export function costEligibilityAgreesWithBillingBasis(
  eligibility: CostEligibility, billingBasis: BillingBasis,
): boolean {
  switch (eligibility) {
    case 'local': return billingBasis === 'local';
    case 'subscription_included': return billingBasis === 'subscriptionIncluded';
    case 'free_confirmed': return billingBasis === 'meteredAPI';
    case 'metered': return billingBasis === 'meteredAPI';
    case 'unknown_cost': return true;
  }
}

/** What a person reads before a campaign runs: who pays for each candidate, and on whose say-so. */
export function costPolicyDisclosure(rows: { candidate: string; verdict: CostEligibilityVerdict }[]): string[] {
  const lines = ['COST ELIGIBILITY — who pays for each candidate, and what established that.', ''];
  for (const row of rows) {
    lines.push(`  ${row.verdict.eligibility}  ${row.candidate}`);
    lines.push(`      ${COST_ELIGIBILITY_LABELS[row.verdict.eligibility]}`);
    lines.push(`      ${row.verdict.reason}`);
    if (row.verdict.overriddenBy) {
      lines.push('      RUNNING UNDER AN EXPLICIT OVERRIDE of the project cost policy.');
    }
  }
  lines.push('', `Authorized for execution: ${AUTHORIZED_COST_ELIGIBILITIES.join(', ')}.`,
    `Blocked: ${BLOCKED_COST_ELIGIBILITIES.join(', ')} — unless explicitly overridden in writing.`,
    '', 'This gate decides EXECUTION only. No score, ranking or retention recommendation reads it.');
  return lines;
}
