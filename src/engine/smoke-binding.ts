// Cernum · the ONE binding an identity smoke test is described by, executed under, and recorded as.
//
// THE DEFECT THIS MODULE EXISTS FOR, found by a dry-run audit on a MacBook Pro before any live
// request was sent. `commandSmoke` built its request out of two different descriptions of the same
// candidate:
//
//   the PREVIEW  called `authorizationClassOf(provider)`, which derives the billing basis from the
//                provider registry. For OpenCode it printed, correctly, `meteredAPI — billed per
//                token against your own credential.`
//   the REQUEST  called a local `smokeBinding()` helper that wrote `executionClass:
//                'subscriptionCLI'`, `billingBasis: 'subscriptionIncluded'` and `authorizationMode:
//                'subscriptionCLISession'` as LITERALS, for every provider it was ever given.
//
// So a live OpenCode smoke would have spent metered money and written down a record saying the
// marginal API charge was $0 and the cost was covered by a subscription — the exact misreport this
// engine refuses by hand everywhere else, produced by the one code path that did not go through
// `validateBinding`. The dry-run and the live record would have disagreed about the same request,
// and the dry-run was the one telling the truth.
//
// THE STRUCTURAL ANSWER. There is one builder, it derives every provider-determined field from the
// registry in `provider.ts`, and it runs `validateBinding` on what it produced before returning it.
// The preview renders THIS object; the request is sent under THIS object; the evidence file and the
// discovery row carry THIS object's fields. A preview that disagrees with a record is then not a
// bug that can be introduced by editing one of two places, because there is one place.

import {
  AuthorizationMode, BillingBasis, EffortLevel, ExecutionClass, PricingSnapshot, ProviderBinding, ProviderID,
  authorizationModeForProvider, billingBasisOf, executionClassOf, isMetered, validateBinding,
} from './provider';
import { openCodeInputBudget } from './opencode-cli';

/**
 * The budgets a smoke request is frozen under.
 *
 * Exported because the projected cost bound is computed FROM them: a person authorising a metered
 * smoke is entitled to see the numbers the bound came out of rather than a figure with no derivation.
 */
export const SMOKE_MAX_INPUT_TOKENS = 1_024;

/**
 * The same budget for OpenCode, plus what OpenCode measurably adds to a request.
 *
 * 1,024 was a budget for the PROMPT, and on this provider the prompt is not the request. The
 * measurement is of THIS EXACT REQUEST and not an analogous one: the captured envelope was produced
 * by `IDENTITY_SMOKE_PROMPT` -- `Reply with only: ok`, nineteen characters -- and reported 7,933
 * input-side tokens. So the bound `projectedMeteredBoundMicroUSD` was checking a ceiling against was
 * 7.7x below the request it was authorising. `openCodeInputBudget` carries the derivation; this
 * names the result so the smoke path and the campaign path are sized by one arithmetic, not two.
 */
export const OPENCODE_SMOKE_MAX_INPUT_TOKENS = openCodeInputBudget(SMOKE_MAX_INPUT_TOKENS);

/**
 * The input budget one smoke request is frozen under, by provider.
 *
 * Only `opencodeCLI` differs, and only because only `opencodeCLI` has been measured. A provider with
 * no measurement keeps the budget it had: inventing an overhead for one nobody has observed would be
 * the same guess this correction exists to remove, pointed the other way.
 */
export function smokeInputBudgetFor(provider: ProviderID): number {
  return provider === 'opencodeCLI' ? OPENCODE_SMOKE_MAX_INPUT_TOKENS : SMOKE_MAX_INPUT_TOKENS;
}

/** The prompt asks for one word. This is the smallest budget worth naming, not an expectation. */
export const SMOKE_MAX_OUTPUT_TOKENS = 16;
export const SMOKE_TIMEOUT_MILLISECONDS = 120_000;

export interface SmokeBindingOptions {
  provider: ProviderID;
  modelID: string;
  effort: EffortLevel;
  /**
   * Published prices for this candidate, when the caller supplied a pricing file that names it.
   * Null for an unpriced metered candidate and for everything that is not billed per token.
   */
  pricing?: PricingSnapshot | null;
}

export class SmokeBindingError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'SmokeBindingError';
  }
}

/**
 * The binding for one smoke request: the smallest honest description of it this engine can write.
 *
 * Every provider-determined field is DERIVED. Nothing here decides what OpenCode's billing basis is
 * or how Codex authorises a request; the registry decides, this assembles, and `validateBinding`
 * refuses the result if the two ever stop agreeing.
 */
export function buildSmokeBinding(options: SmokeBindingOptions): ProviderBinding {
  const executionClass: ExecutionClass = executionClassOf(options.provider);
  const billingBasis: BillingBasis = billingBasisOf(executionClass);
  const authorizationMode: AuthorizationMode = authorizationModeForProvider(options.provider);
  const metered = billingBasis === 'meteredAPI';
  const pricing = metered ? (options.pricing ?? null) : null;

  if (!metered && options.pricing) {
    throw new SmokeBindingError('unmeteredWithPricing',
      `${options.provider} is not billed per token, so a per-token price on it would be a number that looks like a `
      + 'cost and is not one. The pricing file entry was not applied.');
  }

  const binding: ProviderBinding = {
    candidate: `${options.provider}:${options.modelID}:${options.effort}`,
    provider: options.provider,
    executionClass,
    requestedModelID: options.modelID,
    // UNVERIFIABLE IS THE HONEST STARTING STATE, and changing it is the whole point of the exercise.
    // A smoke binding that claimed a verified identity before asking would be assuming its answer.
    identityState: 'unverifiable',
    verifiedModelID: '',
    identityEvidence: 'nothing has established this identity yet; that is what this request is for',
    effort: options.effort,
    thinkingMode: 'runtimeDefault',
    sampling: { temperatureMilli: null, topPMilli: null, seed: null },
    maxInputTokens: smokeInputBudgetFor(options.provider),
    // This engine cannot ENFORCE an output budget through a CLI. It is recorded on every attempt as
    // not-enforceable rather than pretended otherwise, and it is what the cost bound is computed from.
    maxOutputTokens: SMOKE_MAX_OUTPUT_TOKENS,
    timeoutMilliseconds: SMOKE_TIMEOUT_MILLISECONDS,
    // NO RETRY, NOT EVEN ONCE. See the header of `identity-smoke.ts`: a retried smoke spends a second
    // allowance slot to get a second opinion about the same question.
    retry: { maxRetries: 0, backoffMilliseconds: 0, retryOn: [] },
    billingBasis,
    pricing,
    authorizationMode,
  };

  // Validated HERE, at the only place a smoke binding is built, so the smoke path is held to the same
  // terms a campaign manifest is. `allowUnpricedMetered` relaxes the price requirement and nothing
  // else — an unpriced metered smoke still needs the explicit acknowledgement below before it runs.
  validateBinding(binding, { allowUnpricedMetered: true });
  return binding;
}

/**
 * The worst case this request could cost, from the frozen budgets and the published prices.
 *
 * A BOUND, NOT AN ESTIMATE. It assumes the input budget is filled and the output budget is filled at
 * whichever of the output and reasoning rates is higher — so the real charge cannot exceed it, which
 * is the only property that makes it usable as a ceiling. `undefined` when there is no price, and
 * `undefined` is never rendered as zero anywhere downstream.
 */
export function projectedMeteredBoundMicroUSD(binding: ProviderBinding): number | undefined {
  if (!isMetered(binding) || binding.pricing === null) return undefined;
  const price = binding.pricing;
  const perOutputToken = Math.max(price.outputMicroUSDPerMillionTokens, price.reasoningMicroUSDPerMillionTokens ?? 0);
  const input = Math.ceil((binding.maxInputTokens * price.inputMicroUSDPerMillionTokens) / 1_000_000);
  const output = Math.ceil((binding.maxOutputTokens * perOutputToken) / 1_000_000);
  return input + output;
}

/** What a person actually authorised, written down in the shape the evidence file carries. */
export interface SmokeAuthorization {
  billingBasis: BillingBasis;
  /**
   * `notRequired`   nothing is billed per token, so there is nothing to authorise a charge for.
   * `pricedCeiling` a metered run whose worst case was computed and compared against a stated ceiling.
   * `unpricedAcknowledged` a metered run whose cost is UNAVAILABLE and was run anyway, once, on the
   *                 record, by somebody who said in writing that the provider may bill them an amount
   *                 this tool cannot state.
   */
  kind: 'notRequired' | 'pricedCeiling' | 'unpricedAcknowledged';
  /** The ceiling that was stated, in microUSD. Absent when none was required or none could be. */
  ceilingMicroUSD?: number;
  /** The worst case across every request in scope. Absent when there is no price to compute one from. */
  projectedBoundMicroUSD?: number;
  /** EXACTLY how many requests this authorization covers. Never "up to", never a default. */
  requestCount: number;
  /** In words, for a person reading the evidence a year later rather than reading this code. */
  statement: string;
  authorizedAt: string;
}

export interface SmokeAuthorizationRefusal {
  code: 'meteredNeedsAuthorization' | 'meteredNeedsCeiling' | 'projectedBoundExceedsCeiling'
    | 'unpricedNeedsAcknowledgement' | 'unpricedNeedsOneAttemptScope' | 'unpricedCeilingIsNotABound';
  message: string;
}

export interface SmokeAuthorizationRequest {
  /** The bindings actually planned, already built. The scope is exactly these and nothing else. */
  bindings: ProviderBinding[];
  /** `--authorize-metered <ceiling>` in microUSD, when the person supplied one. */
  ceilingMicroUSD?: number;
  /** `--authorize-unpriced-metered`: the written acknowledgement that the amount is unavailable. */
  unpricedAcknowledged: boolean;
  now?: () => Date;
}

/**
 * THE SENTENCE AN UNPRICED METERED SMOKE HAS TO BE AUTHORISED AGAINST.
 *
 * Written once, printed before the request, and copied verbatim into the evidence — for the reason
 * `MIXED_EXECUTION_REASONS` is written once: three surfaces paraphrasing one caveat is three chances
 * for one of them to soften it.
 */
export const UNPRICED_METERED_DISCLOSURE =
  'THE PROVIDER MAY BILL YOU FOR THIS REQUEST AND CERNUM CANNOT SAY HOW MUCH. This candidate is billed per token '
  + 'against your own credential, no pricing snapshot was supplied for it, and the tool reports no per-request charge '
  + 'this interface can read. The amount is UNAVAILABLE — which is not zero, not free, and not estimated. It will be '
  + 'recorded as unavailable on every artefact this run produces, and the only place the real figure exists is your '
  + 'provider account.';

export const METERED_AUTHORIZATION_NOTE =
  'A metered smoke spends money the moment it is sent, so it is refused unless it was authorised by name. Where a '
  + 'price is known the authorization carries a ceiling and the worst case is checked against it before anything is '
  + 'sent. Where no price is known there is no bound to check, so the scope is narrowed to exactly one request and the '
  + 'acknowledgement has to be explicit.';

/**
 * Decide whether these requests may be sent, and record what that decision was.
 *
 * SUBSCRIPTION AND LOCAL EXECUTION ARE `notRequired`, AND THAT IS NOT THE SAME AS FREE. A
 * subscription smoke consumes a finite allowance; it needs no spending authorization because no
 * money moves at the margin, and the disclosure that precedes it says so in those words.
 */
export function authorizeSmoke(request: SmokeAuthorizationRequest): SmokeAuthorization | SmokeAuthorizationRefusal {
  const now = request.now ?? (() => new Date());
  const authorizedAt = now().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const metered = request.bindings.filter(isMetered);
  const requestCount = request.bindings.length;

  if (metered.length === 0) {
    const basis = request.bindings[0]?.billingBasis ?? 'local';
    return {
      billingBasis: basis,
      kind: 'notRequired',
      requestCount,
      statement: basis === 'subscriptionIncluded'
        ? `${requestCount} request(s) against a subscription that is already paid for. The marginal API charge is `
          + '$0 and no card is billed; a finite plan allowance IS consumed, and that is recorded rather than called free.'
        : `${requestCount} request(s) with no monetary cost at the margin.`,
      authorizedAt,
    };
  }

  const bounds = metered.map(projectedMeteredBoundMicroUSD);
  const unpriced = bounds.some((bound) => bound === undefined);

  if (!unpriced) {
    const projectedBoundMicroUSD = bounds.reduce<number>((total, bound) => total + (bound ?? 0), 0);
    if (request.ceilingMicroUSD === undefined) {
      return {
        code: 'meteredNeedsCeiling',
        message: `${metered.length} of these ${requestCount} request(s) are billed per token against your own `
          + 'credential, and a price for them was supplied, so the worst case can be computed and bounded. State the '
          + `ceiling you are authorising:  --authorize-metered <dollars>\n  worst case for this scope: `
          + `${renderMicroUSD(projectedBoundMicroUSD)} (every input budget filled, every output budget filled at the `
          + 'higher of the output and reasoning rates)\nNothing was sent.',
      };
    }
    if (projectedBoundMicroUSD > request.ceilingMicroUSD) {
      return {
        code: 'projectedBoundExceedsCeiling',
        message: `the worst case for this scope is ${renderMicroUSD(projectedBoundMicroUSD)} and you authorised `
          + `${renderMicroUSD(request.ceilingMicroUSD)}. Nothing was sent. Either raise the ceiling deliberately or `
          + 'narrow the scope with --models, and re-run.',
      };
    }
    return {
      billingBasis: 'meteredAPI',
      kind: 'pricedCeiling',
      ceilingMicroUSD: request.ceilingMicroUSD,
      projectedBoundMicroUSD,
      requestCount,
      statement: `${requestCount} metered request(s) authorised against a ceiling of `
        + `${renderMicroUSD(request.ceilingMicroUSD)}. The worst case under the frozen budgets is `
        + `${renderMicroUSD(projectedBoundMicroUSD)}. What the provider actually charges is whatever it charges; this `
        + 'is a bound that was checked before sending, not a receipt.',
      authorizedAt,
    };
  }

  // No price. There is no bound, so a ceiling would be a number with nothing behind it.
  if (request.ceilingMicroUSD !== undefined) {
    return {
      code: 'unpricedCeilingIsNotABound',
      message: 'a ceiling was given for a candidate Cernum holds no pricing for, so there is nothing to check it '
        + 'against and it would be a limit this tool cannot enforce. Either supply prices with --pricing <file>, or '
        + 'acknowledge the unknown amount explicitly with --authorize-unpriced-metered for exactly one request. '
        + 'Nothing was sent.',
    };
  }
  if (!request.unpricedAcknowledged) {
    return {
      code: 'unpricedNeedsAcknowledgement',
      message: `${UNPRICED_METERED_DISCLOSURE}\n\nIf you accept that, say so and narrow the scope to one request:\n`
        + '  --models <one id>  --authorize-unpriced-metered\nOr supply published prices and authorise a ceiling '
        + 'instead:\n  --pricing <file>  --authorize-metered <dollars>\nNothing was sent.',
    };
  }
  if (requestCount !== 1) {
    return {
      code: 'unpricedNeedsOneAttemptScope',
      message: `--authorize-unpriced-metered covers EXACTLY ONE request and this scope is ${requestCount}. An `
        + 'unbounded charge repeated is an unbounded charge multiplied, and a scope nobody counted is not a scope. '
        + 'Name one model at one effort level with --models, and re-run. Nothing was sent.',
    };
  }
  return {
    billingBasis: 'meteredAPI',
    kind: 'unpricedAcknowledged',
    requestCount,
    statement: `exactly 1 metered request authorised with its cost UNAVAILABLE. ${UNPRICED_METERED_DISCLOSURE}`,
    authorizedAt,
  };
}

export function isSmokeAuthorizationRefusal(
  result: SmokeAuthorization | SmokeAuthorizationRefusal): result is SmokeAuthorizationRefusal {
  return 'code' in result;
}

/** Money for a person, to six places. A per-request figure rounded to cents loses most of itself. */
export function renderMicroUSD(microUSD: number): string {
  return `$${(microUSD / 1_000_000).toFixed(6)}`;
}

/**
 * What running this candidate costs, in the words the manifest uses, derived from the BINDING.
 *
 * Took a `ProviderID` before v0.2.4 and was therefore right by accident: it read the registry while
 * the thing it was describing did not. It reads the object that will actually be sent now, so the
 * disclosure cannot describe a request other than the one that happens.
 */
export function authorizationClassOf(binding: ProviderBinding): string {
  switch (binding.billingBasis) {
    case 'subscriptionIncluded':
      return 'subscriptionIncluded — consumes a finite plan allowance you already pay for. Not free.';
    case 'meteredAPI':
      return binding.pricing === null
        ? 'meteredAPI — billed per token against your own credential, at a price Cernum does not hold. The amount is UNAVAILABLE.'
        : 'meteredAPI — billed per token against your own credential, at the prices you supplied.';
    case 'local':
      return 'local — no monetary cost at the margin.';
  }
}
