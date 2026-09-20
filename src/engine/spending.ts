// Benchmark engine · nobody's card gets charged by a program that did not first say what it would
// cost and get told yes.
//
// THE RULE. Not one metered request leaves this machine unless an authorization record for THIS
// campaign already exists on disk, written before the run began, naming the provider, the model, how
// many attempts are planned, what that is estimated to cost between its floor and its ceiling, when
// those prices were captured, and a hard ceiling the run stops at. The record is written first and
// the run reads it back. An in-memory flag would be an authorization that vanishes on a resume,
// which is exactly the run nobody watched.
//
// AN ESTIMATE THAT CANNOT BE CALCULATED IS A REFUSAL, NOT A GUESS. If the prices are missing, or the
// prompt sizes are unknown, Cernum declines the paid run and says which input was absent. A benchmark
// that guesses at what it will spend is a benchmark asking somebody to approve a number nobody
// computed, and "it was only an estimate" is not a thing to say after the bill arrives.
//
// MIN AND MAX ARE A REAL BRACKET, NOT A SPREAD AROUND A GUESS.
//
//   maximum  every attempt fills its ENTIRE frozen input budget and its ENTIRE frozen output budget.
//            This is a genuine upper bound: the binding caps both, and the adapter enforces the cap.
//   minimum  every attempt pays for its estimated input and produces NO output at all. Input is
//            charged whatever happens, so this is a genuine floor.
//
// The input estimate is the one number here that is not exact, and it carries its own method: the
// divisor used is written into the record. A reader who disagrees with the divisor can see it and
// recompute, which is the difference between an estimate and a number somebody made up.
//
// SUBSCRIPTION EXECUTION IS NOT FREE AND IS NOT PRICED HERE. It has no per-token charge, so it
// appears in the authorization as subscription-included with a marginal API charge of zero and an
// allowance that is consumed. It never contributes to the ceiling, because a ceiling in dollars
// cannot govern a quota measured in something else.

import { CanonicalValue, digestObject } from './canonical';
import { OperationalEnvelope, PricingSnapshot, ProviderBinding, ProviderID, isMetered } from './provider';
import { openCodeEstimatedInputFloor } from './opencode-cli';

export const AUTHORIZATION_FORMAT_VERSION = 1;

export class SpendingError extends Error {
  constructor(readonly code:
    | 'notEstimable' | 'notAuthorized' | 'ceilingReached' | 'authorizationMismatch' | 'ceilingNotPositive',
              message: string) {
    super(message);
    this.name = 'SpendingError';
  }
}

/** USD, integer-scaled to millionths so the canonical encoder never sees a float. */
export function formatMicroUSD(microUSD: number): string {
  const dollars = microUSD / 1_000_000;
  // Sub-cent figures are the normal case for a single attempt; rendering them as "$0.00" would make
  // every per-attempt cost look like nothing.
  if (microUSD !== 0 && Math.abs(dollars) < 0.01) return `$${dollars.toFixed(6)}`;
  return `$${dollars.toFixed(2)}`;
}

function tokensToMicroUSD(tokens: number, microUSDPerMillionTokens: number, round: 'floor' | 'ceil'): number {
  const exact = (tokens * microUSDPerMillionTokens) / 1_000_000;
  return round === 'floor' ? Math.floor(exact) : Math.ceil(exact);
}

/** What one candidate is expected to cost, and how that was arrived at. */
export interface CandidateCostEstimate {
  candidate: string;
  provider: ProviderID;
  billingBasis: string;
  requestedModelID: string;
  plannedAttempts: number;
  /** From the frozen prompts, divided by the stated divisor. An estimate, labelled as one. */
  estimatedInputTokens: number;
  /** The frozen output budget times the attempts. The real ceiling, not an estimate. */
  maximumOutputTokens: number;
  /** The frozen input budget times the attempts. The real ceiling. */
  maximumInputTokens: number;
  minimumMicroUSD: number;
  maximumMicroUSD: number;
  /** Null for anything not billed per token. */
  pricing: PricingSnapshot | null;
  /** The divisor used to turn prompt characters into a token estimate. Stated so it can be argued with. */
  charactersPerTokenEstimate: number;
  /**
   * How `estimatedInputTokens` was arrived at, in words.
   *
   * Present because the floor is no longer one arithmetic for every provider: on `opencodeCLI` it
   * carries a measured per-attempt overhead the divisor knows nothing about, and a reader of an
   * authorization is entitled to see which of the two produced the number they are approving.
   */
  estimatedInputTokenFloorBasis: string;
  /** In words, for a person reading the authorization rather than the code. */
  statement: string;
}

export interface SpendingEstimate {
  estimable: boolean;
  /** Populated when `estimable` is false: which input was missing, by name. */
  notEstimableBecause: string[];
  perCandidate: CandidateCostEstimate[];
  totalMinimumMicroUSD: number;
  totalMaximumMicroUSD: number;
  meteredCandidateCount: number;
  subscriptionCandidateCount: number;
  localCandidateCount: number;
  /** The oldest pricing timestamp across every metered binding — the age of the estimate. */
  oldestPricingCapturedAt: string | null;
}

/**
 * The per-candidate facts the estimator needs from the plan and the catalogue.
 *
 * `promptCharacters` is the sum over every planned attempt of the prompt and supplied-context length
 * this candidate will actually send. It comes from the FROZEN prompts, so it is exact input to an
 * inexact conversion rather than an estimate of an estimate.
 */
export interface PlannedWork {
  candidate: string;
  plannedAttempts: number;
  promptCharacters: number;
}

export interface EstimateOptions {
  /**
   * Characters per token. Four is the conventional English-text figure and is deliberately a
   * PARAMETER rather than a constant: it is wrong for code, wrong for non-Latin scripts, and the
   * number that is wrong is the one written into the record where a reader can see it.
   */
  charactersPerTokenEstimate?: number;
}

/**
 * What this campaign is expected to cost, or why that cannot be said.
 *
 * Returns `estimable: false` rather than throwing, because a campaign with no metered candidates is
 * perfectly estimable at zero and a caller needs to tell those two apart.
 */
export function estimateSpending(envelope: OperationalEnvelope, work: PlannedWork[],
                                 options: EstimateOptions = {}): SpendingEstimate {
  const divisor = options.charactersPerTokenEstimate ?? 4;
  const byCandidate = new Map(work.map((entry) => [entry.candidate, entry]));
  const notEstimableBecause: string[] = [];
  const perCandidate: CandidateCostEstimate[] = [];

  for (const binding of envelope.bindings) {
    const planned = byCandidate.get(binding.candidate);
    if (!planned) {
      notEstimableBecause.push(`${binding.candidate}: the plan says nothing about how many attempts it will make, so `
        + 'there is no quantity to price');
      continue;
    }
    const promptDerivedInputTokens = Math.ceil(planned.promptCharacters / divisor);
    const maximumInputTokens = binding.maxInputTokens * planned.plannedAttempts;
    const maximumOutputTokens = binding.maxOutputTokens * planned.plannedAttempts;
    // PROVIDER-SCOPED, and scoped here rather than in `PlannedWork` on purpose. `promptCharacters` is a
    // fact about the frozen prompts and is the same number whoever is asked to answer them; what differs
    // is what a given provider WRAPS AROUND those characters before sending them. Only `opencodeCLI` has
    // been measured, so only `opencodeCLI` moves -- inventing an overhead for a provider nobody has
    // observed would be the same guess this corrects, pointed the other way. See
    // `OPENCODE_INPUT_FLOOR_DERIVATION`.
    const estimatedInputTokens = binding.provider === 'opencodeCLI'
      ? openCodeEstimatedInputFloor(promptDerivedInputTokens, planned.plannedAttempts, maximumInputTokens)
      : promptDerivedInputTokens;
    const floorBasis = estimatedInputTokens === promptDerivedInputTokens
      ? `${planned.promptCharacters} prompt characters at ${divisor} characters per token`
      : `${planned.promptCharacters} prompt characters at ${divisor} characters per token (${promptDerivedInputTokens}), `
        + `plus the measured per-attempt OpenCode injected context across ${planned.plannedAttempts} attempt(s), `
        + `held at or below the ${maximumInputTokens}-token input ceiling`;

    if (!isMetered(binding)) {
      perCandidate.push({
        candidate: binding.candidate,
        provider: binding.provider,
        billingBasis: binding.billingBasis,
        requestedModelID: binding.requestedModelID,
        plannedAttempts: planned.plannedAttempts,
        estimatedInputTokens,
        maximumInputTokens,
        maximumOutputTokens,
        minimumMicroUSD: 0,
        maximumMicroUSD: 0,
        pricing: null,
        charactersPerTokenEstimate: divisor,
        estimatedInputTokenFloorBasis: floorBasis,
        statement: binding.billingBasis === 'local'
          ? `${binding.candidate}: ${planned.plannedAttempts} attempt(s) on the local runtime. No monetary cost. `
            + 'Wall-clock time is still recorded, and no electricity cost is invented.'
          : `${binding.candidate}: ${planned.plannedAttempts} attempt(s) through a subscription you already pay for. `
            + 'Marginal API charge $0. This consumes a finite allowance, which is tracked separately and is not a '
            + 'dollar figure — subscription usage is not free, it is already bought.',
      });
      continue;
    }

    const pricing = binding.pricing;
    if (!pricing) {
      // Unreachable through `validateBinding`, which refuses a metered binding without pricing. Kept
      // because the refusal must exist at the point of spending too, not only at the point of freezing.
      notEstimableBecause.push(`${binding.candidate}: no pricing snapshot, so its cost cannot be computed`);
      continue;
    }
    if (planned.promptCharacters <= 0) {
      notEstimableBecause.push(`${binding.candidate}: the frozen prompts report no length, so the input tokens this `
        + 'campaign will pay for cannot be estimated');
      continue;
    }

    const minimumMicroUSD = tokensToMicroUSD(estimatedInputTokens, pricing.inputMicroUSDPerMillionTokens, 'floor');
    const maximumMicroUSD = tokensToMicroUSD(maximumInputTokens, pricing.inputMicroUSDPerMillionTokens, 'ceil')
      + tokensToMicroUSD(maximumOutputTokens, pricing.outputMicroUSDPerMillionTokens, 'ceil');

    perCandidate.push({
      candidate: binding.candidate,
      provider: binding.provider,
      billingBasis: binding.billingBasis,
      requestedModelID: binding.requestedModelID,
      plannedAttempts: planned.plannedAttempts,
      estimatedInputTokens,
      maximumInputTokens,
      maximumOutputTokens,
      minimumMicroUSD,
      maximumMicroUSD,
      pricing,
      charactersPerTokenEstimate: divisor,
      estimatedInputTokenFloorBasis: floorBasis,
      statement: `${binding.candidate}: ${planned.plannedAttempts} attempt(s) billed per token against your key. `
        + `Between ${formatMicroUSD(minimumMicroUSD)} and ${formatMicroUSD(maximumMicroUSD)}. The floor assumes every `
        + `attempt pays for its input (about ${estimatedInputTokens} tokens, from ${floorBasis}) and produces nothing; `
        + `the ceiling assumes every attempt fills its whole ${binding.maxInputTokens}-token input budget and its whole `
        + `${binding.maxOutputTokens}-token output budget. Prices captured ${pricing.capturedAt} from ${pricing.source}.`,
    });
  }

  const metered = perCandidate.filter((entry) => entry.billingBasis === 'meteredAPI');
  const pricingDates = metered.map((entry) => entry.pricing!.capturedAt).sort();

  return {
    estimable: notEstimableBecause.length === 0,
    notEstimableBecause,
    perCandidate,
    totalMinimumMicroUSD: perCandidate.reduce((sum, entry) => sum + entry.minimumMicroUSD, 0),
    totalMaximumMicroUSD: perCandidate.reduce((sum, entry) => sum + entry.maximumMicroUSD, 0),
    meteredCandidateCount: metered.length,
    subscriptionCandidateCount: perCandidate.filter((entry) => entry.billingBasis === 'subscriptionIncluded').length,
    localCandidateCount: perCandidate.filter((entry) => entry.billingBasis === 'local').length,
    oldestPricingCapturedAt: pricingDates[0] ?? null,
  };
}

/**
 * The record that makes a paid run permissible.
 *
 * Sealed with a digest over the estimate AND the envelope, so an authorization cannot be carried
 * across to a campaign whose bindings changed. Approving one run does not approve the next one.
 */
export interface SpendingAuthorization {
  authorizationFormatVersion: number;
  campaignID: string;
  authorizedAt: string;
  /** Who said yes, in their own words: 'cernum authorize --ceiling 5.00', or the UI's own sentence. */
  authorizedBy: string;
  estimate: SpendingEstimate;
  /** The run stops before the request that would take it past this. Required, and must be positive. */
  hardCeilingMicroUSD: number;
  /** Bound so this authorization cannot be reused for a campaign whose providers or models changed. */
  operationalEnvelopeDigest: string;
  authorizationDigest: string;
}

export interface AuthorizeOptions {
  campaignID: string;
  authorizedAt: string;
  authorizedBy: string;
  hardCeilingMicroUSD: number;
  operationalEnvelopeDigest: string;
}

/**
 * Record an authorization, or refuse to.
 *
 * Refuses when the cost could not be estimated, and refuses a ceiling of zero or less. It does NOT
 * refuse a ceiling below the estimated maximum: a person may legitimately want to spend at most five
 * dollars on a campaign whose worst case is fifty and stop when it runs out. That is what a ceiling
 * is for, and the run stops rather than the authorization being rejected.
 */
export function authorizeSpending(estimate: SpendingEstimate, options: AuthorizeOptions): SpendingAuthorization {
  if (!estimate.estimable) {
    throw new SpendingError('notEstimable',
      'this campaign\'s cost cannot be calculated, so Cernum will not ask you to approve a number nobody computed:\n'
      + estimate.notEstimableBecause.map((reason) => `  · ${reason}`).join('\n'));
  }
  if (options.hardCeilingMicroUSD <= 0) {
    throw new SpendingError('ceilingNotPositive',
      'a hard spending ceiling must be greater than zero. A run authorised with no ceiling is a run with no stopping condition.');
  }
  const body = {
    authorizationFormatVersion: AUTHORIZATION_FORMAT_VERSION,
    campaignID: options.campaignID,
    authorizedAt: options.authorizedAt,
    authorizedBy: options.authorizedBy,
    estimate: estimate as unknown as CanonicalValue,
    hardCeilingMicroUSD: options.hardCeilingMicroUSD,
    operationalEnvelopeDigest: options.operationalEnvelopeDigest,
  };
  return { ...body, estimate, authorizationDigest: digestObject(body as unknown as CanonicalValue) };
}

/** The lines a person reads before saying yes. Authored once; the terminal and the interface quote it. */
export function authorizationDisclosure(estimate: SpendingEstimate, hardCeilingMicroUSD: number): string[] {
  const lines: string[] = [];
  if (estimate.meteredCandidateCount === 0) {
    lines.push('No candidate in this campaign is billed per token, so nothing here will be charged to a card.');
  } else {
    lines.push(`${estimate.meteredCandidateCount} candidate(s) will be billed per token against your own API key.`);
    lines.push(`Estimated total: between ${formatMicroUSD(estimate.totalMinimumMicroUSD)} and `
      + `${formatMicroUSD(estimate.totalMaximumMicroUSD)}.`);
    if (estimate.oldestPricingCapturedAt) {
      lines.push(`Those figures use prices captured ${estimate.oldestPricingCapturedAt}. Cernum does not fetch live `
        + 'prices, so if the provider has changed them since, this estimate is stale and the real cost will differ.');
    }
    lines.push(`The run stops before the request that would take it past ${formatMicroUSD(hardCeilingMicroUSD)}. `
      + 'Attempts already recorded are kept; the remaining slots are blocked and carry no result.');
  }
  for (const entry of estimate.perCandidate) lines.push(entry.statement);
  if (estimate.subscriptionCandidateCount > 0) {
    lines.push('Subscription-included execution is not free. Its marginal API charge is $0 because you already pay for '
      + 'the subscription, and it consumes an allowance that a dollar ceiling cannot govern.');
  }
  return lines;
}

/**
 * The running total, and the thing that stops a run.
 *
 * Holds MEASURED spend — provider-reported usage where the provider reports it, and the estimate
 * otherwise, tracked separately so the two are never added together as though they were the same
 * quality of number.
 */
export class SpendTracker {
  private meteredMicroUSD = 0;
  private estimatedMicroUSD = 0;
  private attempts = 0;

  /**
   * `expectedEnvelopeDigest` is what this campaign's bindings actually hash to now. An authorization
   * recorded against a different one is rejected rather than honoured: approving a run of Haiku at a
   * five-dollar ceiling must not silently authorise a run of Opus at the same ceiling.
   */
  constructor(readonly authorization: SpendingAuthorization | undefined,
              private readonly expectedEnvelopeDigest?: string) {}

  get spentMicroUSD(): number {
    return this.meteredMicroUSD + this.estimatedMicroUSD;
  }

  get providerReportedMicroUSD(): number {
    return this.meteredMicroUSD;
  }

  get estimatedOnlyMicroUSD(): number {
    return this.estimatedMicroUSD;
  }

  get meteredAttempts(): number {
    return this.attempts;
  }

  get ceilingMicroUSD(): number | undefined {
    return this.authorization?.hardCeilingMicroUSD;
  }

  /** Restore a total from a resumed campaign's ledger, so a ceiling survives a restart. */
  restore(providerReportedMicroUSD: number, estimatedMicroUSD: number, attempts: number): void {
    this.meteredMicroUSD = providerReportedMicroUSD;
    this.estimatedMicroUSD = estimatedMicroUSD;
    this.attempts = attempts;
  }

  /**
   * May this binding send a request right now?
   *
   * Two refusals, in this order. An unauthorized run is refused before a ceiling is even consulted,
   * because "you are over budget" is the wrong thing to tell somebody who never approved a budget.
   */
  check(binding: ProviderBinding, worstCaseMicroUSD: number): void {
    if (!isMetered(binding)) return;
    if (!this.authorization) {
      throw new SpendingError('notAuthorized',
        `${binding.candidate} is billed per token and this campaign carries no recorded spending authorization. `
        + 'Nothing was sent. Authorize it explicitly — the authorization names the provider, the model, the planned '
        + 'attempts, the estimated cost and a hard ceiling — and it is written to disk before the first request.');
    }
    if (this.expectedEnvelopeDigest !== undefined
        && this.authorization.operationalEnvelopeDigest !== this.expectedEnvelopeDigest) {
      throw new SpendingError('authorizationMismatch',
        'the recorded authorization was given for a different set of provider bindings than this campaign now has. '
        + 'Nothing was sent. Approving one run does not approve another: authorize this campaign as it stands, with '
        + 'its own estimate and its own ceiling.');
    }
    const ceiling = this.authorization.hardCeilingMicroUSD;
    if (this.spentMicroUSD >= ceiling) {
      throw new SpendingError('ceilingReached',
        `this campaign has reached its hard spending ceiling of ${formatMicroUSD(ceiling)} `
        + `(${formatMicroUSD(this.spentMicroUSD)} recorded across ${this.attempts} metered attempt(s)). `
        + 'Nothing further was sent. The attempts already recorded are kept.');
    }
    if (this.spentMicroUSD + worstCaseMicroUSD > ceiling) {
      throw new SpendingError('ceilingReached',
        `the next ${binding.candidate} attempt could cost up to ${formatMicroUSD(worstCaseMicroUSD)}, which would take `
        + `this campaign past its hard ceiling of ${formatMicroUSD(ceiling)} (${formatMicroUSD(this.spentMicroUSD)} `
        + 'recorded so far). Nothing was sent — the ceiling stops the request that WOULD exceed it, rather than '
        + 'noticing afterwards that one did.');
    }
  }

  /** Record what an attempt actually cost, keeping provider-reported and estimated figures apart. */
  record(microUSD: number, provenance: 'providerReported' | 'estimated'): void {
    if (provenance === 'providerReported') this.meteredMicroUSD += microUSD;
    else this.estimatedMicroUSD += microUSD;
    this.attempts += 1;
  }
}

/** The worst this one attempt can cost, from the frozen budgets. Used to stop BEFORE the request. */
export function worstCaseAttemptMicroUSD(binding: ProviderBinding): number {
  if (!isMetered(binding) || !binding.pricing) return 0;
  return tokensToMicroUSD(binding.maxInputTokens, binding.pricing.inputMicroUSDPerMillionTokens, 'ceil')
    + tokensToMicroUSD(binding.maxOutputTokens, binding.pricing.outputMicroUSDPerMillionTokens, 'ceil');
}

/** What one attempt actually cost, from counted tokens. Integer microUSD; never a float. */
export function attemptCostMicroUSD(binding: ProviderBinding, tokens: {
  inputTokens?: number; outputTokens?: number; reasoningTokens?: number;
}): number {
  const pricing = binding.pricing;
  if (!isMetered(binding) || !pricing) return 0;
  let total = 0;
  if (tokens.inputTokens !== undefined) total += tokensToMicroUSD(tokens.inputTokens, pricing.inputMicroUSDPerMillionTokens, 'ceil');
  if (tokens.outputTokens !== undefined) total += tokensToMicroUSD(tokens.outputTokens, pricing.outputMicroUSDPerMillionTokens, 'ceil');
  if (tokens.reasoningTokens !== undefined) {
    // A provider that does not bill reasoning apart bills it as output, which is what the frontier
    // adapters already report it as. Adding it again at the output rate would double-charge it.
    const rate = pricing.reasoningMicroUSDPerMillionTokens;
    if (rate !== null) total += tokensToMicroUSD(tokens.reasoningTokens, rate, 'ceil');
  }
  return total;
}

/** Parse a human ceiling — "5", "5.00", "$5.00" — into integer microUSD. Refuses anything else. */
export function parseCeilingToMicroUSD(text: string): number {
  const cleaned = text.trim().replace(/^\$/, '');
  if (!/^\d+(\.\d{1,6})?$/.test(cleaned)) {
    throw new SpendingError('ceilingNotPositive',
      `'${text}' is not a spending ceiling. Give it in dollars, like 5 or 5.00.`);
  }
  return Math.round(Number(cleaned) * 1_000_000);
}

/**
 * Rebuild a tracker's totals from a resumed campaign's ledger rows.
 *
 * A ceiling that only existed in memory would be a ceiling that resets every time somebody pressed
 * resume — five dollars, then five more, then five more. The rows are the record, so the total
 * carries across a restart, across a crash, and across being resumed from the other surface.
 */
export function restoreSpendFromRows(tracker: SpendTracker, rows: Record<string, unknown>[]): void {
  let reported = 0;
  let estimated = 0;
  let attempts = 0;
  for (const row of rows) {
    if (row.billingBasis !== 'meteredAPI') continue;
    attempts += 1;
    const cost = typeof row.costMicroUSD === 'number' ? row.costMicroUSD : 0;
    if (row.costProvenance === 'providerReported') reported += cost;
    else estimated += cost;
  }
  tracker.restore(reported, estimated, attempts);
}
