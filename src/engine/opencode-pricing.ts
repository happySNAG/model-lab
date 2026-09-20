// Cernum · what OpenCode Zen PUBLISHES it will charge for the six models in the proposed first
// cohort, read off the provider's own catalogue, with the command, the file, its digest and the
// moment it was read.
//
// ============================================================================================
// THIS FILE CONTAINS PUBLISHED LIST PRICES. IT CONTAINS NO OBSERVED CHARGE.
// ============================================================================================
//
// THE TWO FACTS THIS MODULE EXISTS TO KEEP APART, because collapsing them is the specific failure
// Cernum was built to refuse:
//
//   PUBLISHED LIST PRICE   what the provider SAYS it will charge. A statement by the seller about
//                          its own price list. Citable, dated, and exactly as reliable as the seller.
//   OBSERVED CHARGE        what Cernum WATCHED the provider charge, read back per request. This
//                          engine has never obtained one of these from OpenCode and does not obtain
//                          one here. `OPENCODE_COST_PROVENANCE` is still `unavailable`.
//
// A list price is an input to an ESTIMATE. An observed charge is a MEASUREMENT. `estimateSpending`
// consumes the first and `SpendTracker.record(..., 'providerReported')` consumes the second, and the
// day those two start reading the same number is the day a Cernum artefact reports a charge nobody
// watched. So every figure below is labelled at the point of use, the `source` string that travels
// into the manifest says the word `published`, and `POST_RUN_RECONCILIATION_REQUIRED` is carried
// wherever these prices are shown.
//
// -- WHAT WAS READ, AND HOW ---------------------------------------------------------------------
//
// `opencode models opencode` was run and printed 71 `provider/model` identifiers. That listing is
// served out of OpenCode's locally cached catalogue at `~/.cache/opencode/models.json` — the same
// cached file described in `OPENCODE_LISTING_IS_A_CATALOGUE`, which proves nothing about entitlement
// and is not being asked to. What it DOES carry, per model, is a `cost` object, and that object is
// the provider's published price list. Seven of the 71 listed identifiers publish `input: 0` and
// `output: 0`; six of those seven are the development pool in `FREE_OPENCODE_DEVELOPMENT_POOL` and
// are the models priced here. The seventh, `opencode/ling-3.0-flash-fin-free`, is a finance-domain
// model left out of the cohort deliberately, so it is left out of the pricing capture too rather
// than priced for a cohort it is not in.
//
// NO MODEL WAS ASKED ANYTHING. `opencode models` reaches no model, spends nothing, and returns no
// completion. Reading a price list is not a request, and this capture made none.
//
// THE UNIT, ESTABLISHED RATHER THAN ASSUMED. The catalogue's `cost` numbers are USD PER MILLION
// TOKENS, which was checked against entries whose prices are independently known before any zero was
// trusted: `claude-opus-4-5` publishes `input: 5, output: 25` and `claude-haiku-4-5` publishes
// `input: 1, output: 5`. Those are per-million-token figures at face value and nonsense at any other
// scale, so a published `0` is $0 per million tokens and not a rounded-down fraction of a cent.
//
// -- WHY A ZERO LIST PRICE IS RECORDED AS A PRICE AND NOT AS "FREE" -----------------------------
//
// `pricingFor` accepts zero. It does not have to be talked into it: the validator requires a
// non-negative integer, and zero is one. So the honest recording of a published zero is a pricing
// snapshot whose rates are zero, WITH its source and its capture time, and not the absence of a
// snapshot and not a `billingBasis` of anything other than `meteredAPI`.
//
// The distinction matters because the alternatives are both wrong in ways that have already bitten
// this engine once. Omitting the snapshot would make the cohort NOT ESTIMABLE and refuse the run for
// a missing input that is not missing. Reclassifying the models as `subscriptionIncluded` or `local`
// because they cost nothing would stamp every row with a zero marginal charge on a metered service —
// the exact misreport `codexCLI` refuses by hand and the reason `executionClassOf` sends
// `opencodeCLI` to `meteredAPI` regardless of price. A metered candidate at a published rate of zero
// is still a metered candidate.
//
// -- WHAT THE CATALOGUE DOES AND DOES NOT MARK --------------------------------------------------
//
// THERE IS NO `free` FLAG. The catalogue publishes no boolean saying a model is free; it publishes a
// price of zero. Those are different assertions and the second is the one on the record, so
// `freeMarking` below says `zeroListPrice` rather than `flagged`. Five of the six carry `-free` in
// their identifier, which is a NAME and is not a price; `opencode/big-pickle` does not carry it and
// publishes the same zero. A cohort assembled by reading identifiers would have missed one of its own
// members and included nothing it checked.
//
// CACHE TIERS ARE RECORDED AS PUBLISHED, NEVER AS INFERRED. The catalogue publishes `cache_read: 0`
// for all six. It publishes `cache_write: 0` for `opencode/big-pickle` ALONE; for the other five the
// key is ABSENT, and absent is recorded as absent. Inventing `cache_write: 0` for those five would be
// putting a number in the provider's mouth, and it is the cheapest possible lie to tell because the
// invented figure happens to be right today.
//
// NO REASONING TIER IS PUBLISHED FOR ANY OF THE SIX, so `reasoningMicroUSDPerMillionTokens` is NULL
// and not zero. `PricingSnapshot` already distinguishes these: null means "the provider does not bill
// reasoning apart", which routes reasoning tokens through the output rate in
// `attemptCostMicroUSD`, and zero would mean "the provider bills reasoning separately, at nothing".
// All six report `reasoning: true` as a CAPABILITY. A capability flag is not a price tier.
//
// AND NO CONTEXT TIER. Several paid entries in the same catalogue carry `tiers` /
// `context_over_200k` — a second, higher rate above a context threshold, which a single-rate
// `PricingSnapshot` could not express and would silently understate. None of the six publishes one,
// and `assertNoUnpricedTier` refuses the capture if one ever appears rather than dropping it.

import { PricingSnapshot, ProviderID } from './provider';
import { OPENCODE_COST_EXPLANATION, OPENCODE_PROVIDER } from './opencode-cli';

/** The command whose output was read. Never documentation, never recollection. */
export const OPENCODE_ZEN_PRICING_COMMAND = 'opencode models opencode';

/**
 * The file the command reads its answer out of, named because the command is a view of it and a
 * reader checking this capture needs the thing that can be re-read, not only the thing that printed.
 */
export const OPENCODE_ZEN_CATALOGUE_PATH = '~/.cache/opencode/models.json';

/**
 * The catalogue's digest at the moment it was read.
 *
 * IT IS A VOLATILE FILE AND THAT IS WHY THE DIGEST IS HERE. `opencode models` refreshes the cache as
 * a side effect — this digest differs from the one the file carried minutes earlier in the same
 * session. So the digest does not promise the file still hashes to this; it pins WHICH bytes these
 * prices were transcribed from, which is the only claim a capture can honestly make about a cache.
 */
export const OPENCODE_ZEN_CATALOGUE_SHA256 =
  '32dbd7b873101532f2bd504a74c1cbebc8adba11fddb9d0f4deabc8bf2fde2f7';

export const OPENCODE_ZEN_CATALOGUE_BYTES = 4_710_099;

/** The CLI that served the listing, as it reported itself to `--version`. */
export const OPENCODE_ZEN_PRICING_CLI_VERSION = 'opencode-ai@1.18.31';

/** The service these prices belong to, and where OpenCode says it publishes them. */
export const OPENCODE_ZEN_SERVICE_NAME = 'OpenCode Zen';
export const OPENCODE_ZEN_API_BASE = 'https://opencode.ai/zen/v1';
export const OPENCODE_ZEN_DOC = 'https://opencode.ai/docs/zen';

/** When these figures were read. Not when they were published, which the catalogue does not say. */
export const OPENCODE_ZEN_PRICING_CAPTURED_AT = '2026-09-20T20:31:54Z';

/** What the listing and the catalogue contained at capture time, so a later drift is visible. */
export const OPENCODE_ZEN_PRICING_LISTED_COUNT = 71;
export const OPENCODE_ZEN_PRICING_CATALOGUE_MODEL_COUNT = 104;
export const OPENCODE_ZEN_PRICING_ZERO_LIST_PRICE_COUNT = 7;

/**
 * The `source` string that travels into every `PricingSnapshot`, and from there into the manifest and
 * into the sentence a person reads before authorizing a run.
 *
 * IT SAYS `PUBLISHED LIST PRICE` IN THE FIRST FOUR WORDS. This string is the only provenance that
 * survives into an artefact — `PricingSnapshot` carries `source` and `capturedAt` and nothing else —
 * so a reader who sees only the snapshot must still be unable to mistake it for a measurement.
 */
export const OPENCODE_ZEN_PRICING_SOURCE =
  `PUBLISHED LIST PRICE (not an observed charge) · ${OPENCODE_ZEN_SERVICE_NAME} model catalogue, read via `
  + `\`${OPENCODE_ZEN_PRICING_COMMAND}\` from ${OPENCODE_ZEN_CATALOGUE_PATH} `
  + `(sha256 ${OPENCODE_ZEN_CATALOGUE_SHA256.slice(0, 16)}…, ${OPENCODE_ZEN_CATALOGUE_BYTES} bytes) · `
  + `${OPENCODE_ZEN_PRICING_CLI_VERSION} · unit USD per million tokens · ${OPENCODE_ZEN_DOC}`;

/** The unit, in words, for an artefact that shows a rate without showing this file. */
export const OPENCODE_ZEN_PRICING_UNIT = 'USD per million tokens';

/**
 * How the catalogue marks a model as costing nothing.
 *
 * `zeroListPrice` — it publishes `input: 0` and `output: 0`. There is no boolean `free` field, so
 * `flagged` is a value this capture can never legitimately carry and exists only so that a future
 * catalogue which DOES flag one can be recorded as flagging it.
 */
export type FreeMarking = 'zeroListPrice' | 'flagged' | 'notFree';

/**
 * One model's published price, exactly as the provider's catalogue states it, plus the scaled
 * integers `PricingSnapshot` needs.
 *
 * BOTH FORMS ARE KEPT ON PURPOSE. `publishedUSDPerMillionTokens` is the provider's own number,
 * transcribed; the `microUSD` fields are Cernum's scaling of it. A reader who disagrees with the
 * scaling can see the figure it was scaled from, which is the same courtesy
 * `charactersPerTokenEstimate` extends to the token estimate.
 */
export interface PublishedCataloguePrice {
  provider: ProviderID;
  /** OpenCode's own `provider/model` address, carried through unchanged. */
  modelID: string;
  /** The catalogue's own `name` field. */
  displayName: string;
  /** Verbatim from the catalogue's `cost` object, in USD per million tokens. */
  publishedUSDPerMillionTokens: {
    input: number;
    output: number;
    /** Null when the catalogue publishes no such key. NEVER a zero this file invented. */
    cacheRead: number | null;
    cacheWrite: number | null;
    /** Null on every row here: the catalogue publishes no reasoning tier for any of the six. */
    reasoning: number | null;
  };
  inputMicroUSDPerMillionTokens: number;
  outputMicroUSDPerMillionTokens: number;
  /** Null, because null and zero mean different things here. See the header. */
  reasoningMicroUSDPerMillionTokens: null;
  currency: 'USD';
  unit: string;
  freeMarking: FreeMarking;
  /** True when the catalogue publishes a separate cache-read rate at all, whatever its value. */
  cacheReadTierPublished: boolean;
  cacheWriteTierPublished: boolean;
  /** True when the catalogue publishes a second rate above a context threshold. False on all six. */
  contextTierPublished: boolean;
  source: string;
  capturedAt: string;
}

/** Scale a published USD-per-million-token figure to the integer microUSD the snapshot carries. */
export function publishedUSDToMicroUSD(usdPerMillionTokens: number): number {
  return Math.round(usdPerMillionTokens * 1_000_000);
}

function publishedRow(
  modelID: string, displayName: string,
  published: { input: number; output: number; cacheRead: number | null; cacheWrite: number | null },
): PublishedCataloguePrice {
  return {
    provider: OPENCODE_PROVIDER,
    modelID,
    displayName,
    publishedUSDPerMillionTokens: { ...published, reasoning: null },
    inputMicroUSDPerMillionTokens: publishedUSDToMicroUSD(published.input),
    outputMicroUSDPerMillionTokens: publishedUSDToMicroUSD(published.output),
    reasoningMicroUSDPerMillionTokens: null,
    currency: 'USD',
    unit: OPENCODE_ZEN_PRICING_UNIT,
    freeMarking: published.input === 0 && published.output === 0 ? 'zeroListPrice' : 'notFree',
    cacheReadTierPublished: published.cacheRead !== null,
    cacheWriteTierPublished: published.cacheWrite !== null,
    contextTierPublished: false,
    source: OPENCODE_ZEN_PRICING_SOURCE,
    capturedAt: OPENCODE_ZEN_PRICING_CAPTURED_AT,
  };
}

/**
 * The six published prices, in the order `FREE_OPENCODE_DEVELOPMENT_POOL` declares the cohort.
 *
 * Every `cost` object below was transcribed from the catalogue read at
 * `OPENCODE_ZEN_PRICING_CAPTURED_AT` and nothing was filled in from the row above it. That
 * `cache_write` is present on exactly one of the six is the visible proof of that: a capture written
 * by pattern would have six identical rows, and this one does not.
 */
export const OPENCODE_ZEN_PUBLISHED_PRICES: PublishedCataloguePrice[] = [
  // The only row whose identifier does NOT say `free`, and the only one publishing a cache-write rate.
  publishedRow('opencode/big-pickle', 'Big Pickle',
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
  publishedRow('opencode/mimo-v2.5-free', 'MiMo V2.5 Free',
    { input: 0, output: 0, cacheRead: 0, cacheWrite: null }),
  publishedRow('opencode/muse-spark-1.2-contributor-free', 'Muse Spark 1.2 Free',
    { input: 0, output: 0, cacheRead: 0, cacheWrite: null }),
  publishedRow('opencode/muse-spark-1.3-contributor-free', 'Muse Spark 1.3 Free',
    { input: 0, output: 0, cacheRead: 0, cacheWrite: null }),
  publishedRow('opencode/nemotron-3-ultra-free', 'Nemotron 3 Ultra Free',
    { input: 0, output: 0, cacheRead: 0, cacheWrite: null }),
  publishedRow('opencode/nemotron-3.5-lightning-free', 'Nemotron 3.5 Lightning Free',
    { input: 0, output: 0, cacheRead: 0, cacheWrite: null }),
];

/** The published price for one OpenCode model, or undefined. Never a fallback, never a neighbour's. */
export function publishedPriceFor(modelID: string): PublishedCataloguePrice | undefined {
  return OPENCODE_ZEN_PUBLISHED_PRICES.find((row) => row.modelID === modelID);
}

/**
 * The pricing snapshot a binding is frozen under, built from a published row.
 *
 * This is the ONE function that turns a published price into the shape the estimator consumes, so
 * there is one place where the crossing happens and one place a reader has to check that the crossing
 * is labelled. `source` carries the label; `capturedAt` carries the age.
 */
export function snapshotFor(row: PublishedCataloguePrice): PricingSnapshot {
  return {
    source: row.source,
    capturedAt: row.capturedAt,
    currency: 'USD',
    inputMicroUSDPerMillionTokens: row.inputMicroUSDPerMillionTokens,
    outputMicroUSDPerMillionTokens: row.outputMicroUSDPerMillionTokens,
    reasoningMicroUSDPerMillionTokens: row.reasoningMicroUSDPerMillionTokens,
  };
}

/**
 * The capture, in the shape `--pricing <file>` and `pricingFor` read.
 *
 * Keyed `<provider>:<model>` — the form `pricingFor` tries first — so a pricing file cannot be
 * matched to a same-named model on a different provider. Built here rather than hand-written into the
 * JSON so the committed file and this module cannot drift; a test asserts they are equal.
 */
export function openCodePricingFileEntries(): Record<string, unknown> {
  const entries: Record<string, unknown> = {};
  for (const row of OPENCODE_ZEN_PUBLISHED_PRICES) {
    entries[`${row.provider}:${row.modelID}`] = {
      source: row.source,
      capturedAt: row.capturedAt,
      inputMicroUSDPerMillionTokens: row.inputMicroUSDPerMillionTokens,
      outputMicroUSDPerMillionTokens: row.outputMicroUSDPerMillionTokens,
      // NOT `reasoningMicroUSDPerMillionTokens: 0`. `pricingFor` reads a missing key as null, which is
      // what "the provider publishes no reasoning tier" means; a zero would assert a tier priced at
      // nothing. The key is deliberately absent rather than explicitly null so that the file is
      // exactly what `pricingFor` expects to be handed by a person writing one.
      pricingProvenance: 'publishedCataloguePrice',
      publishedUSDPerMillionTokens: row.publishedUSDPerMillionTokens,
      unit: row.unit,
      currency: row.currency,
      freeMarking: row.freeMarking,
      cacheReadTierPublished: row.cacheReadTierPublished,
      cacheWriteTierPublished: row.cacheWriteTierPublished,
      contextTierPublished: row.contextTierPublished,
      cacheTierTreatment: OPENCODE_CACHE_TIER_TREATMENT,
      notAMeasuredCharge: PUBLISHED_PRICE_IS_NOT_A_MEASURED_CHARGE,
      reconciliationRequired: POST_RUN_RECONCILIATION_REQUIRED,
    };
  }
  return entries;
}

/**
 * Refuse a capture that has become unrepresentable, rather than rounding the problem away.
 *
 * A context tier is a second rate above a token threshold. `PricingSnapshot` carries ONE input rate,
 * so a tiered model priced through it would be estimated at the cheap rate and charged at the dear
 * one — an understatement in the one direction a spending ceiling cannot survive. None of the six
 * publishes a tier today. If one starts to, this throws, and a human decides what to do about it.
 */
export function assertNoUnpricedTier(rows: PublishedCataloguePrice[] = OPENCODE_ZEN_PUBLISHED_PRICES): void {
  const tiered = rows.filter((row) => row.contextTierPublished).map((row) => row.modelID);
  if (tiered.length > 0) {
    throw new Error(
      `${tiered.join(', ')}: the catalogue now publishes a context-tier price, and a PricingSnapshot carries one `
      + 'input rate. Estimating a tiered model at its base rate understates the ceiling, which is the one direction '
      + 'a ceiling cannot be wrong in. Price it by hand at the HIGHEST published tier, or leave it out of the cohort.');
  }
}

/**
 * The sentence that must appear wherever these figures do.
 *
 * Written as a constant rather than as a paragraph in each caller because a warning reworded at three
 * surfaces is a warning that says three things, and the weakest wording is the one somebody quotes.
 */
export const PUBLISHED_PRICE_IS_NOT_A_MEASURED_CHARGE =
  `This is ${OPENCODE_ZEN_SERVICE_NAME}'s PUBLISHED LIST PRICE, read from the provider's own model catalogue on `
  + `${OPENCODE_ZEN_PRICING_CAPTURED_AT}. It is a statement by the provider about what it will charge. It is NOT a `
  + 'charge Cernum observed: no OpenCode request has ever returned a per-request charge to this interface, and the '
  + 'cost provenance of an OpenCode attempt remains UNAVAILABLE — for a zero-list-price model exactly as much as for '
  + 'a $15/Mtok one. A published price may be stale, may be wrong, may not apply to this credential, and says nothing '
  + 'about whether this credential may call the model at all: every row in the cohort is still DISCOVERED and UNPROVEN.';

/**
 * How the cache tiers the catalogue does and does not publish are treated, and why that is the
 * conservative direction.
 *
 * Cernum's established treatment is already on disk and is not being invented here: `frontier-host.ts`
 * prices `totalInputTokens` — fresh plus cache-write plus cache-read — at the single input rate the
 * snapshot carries, precisely because the schema has no cache tier, and charging a cached token at the
 * full input rate can only OVERSTATE a charge. That is the treatment applied to these six.
 *
 * So the published `cache_read: 0` on all six, and the published `cache_write: 0` on `big-pickle`, are
 * RECORDED and are not used as rates — there is no field to put them in. The five rows with no
 * published cache-write rate get no invented one; their cache-write tokens are charged at the input
 * rate like every other input-side token. At a published input rate of zero every one of those
 * products is zero, which is exactly why the treatment has to be written down now: it is unfalsifiable
 * today and load-bearing the moment a rate stops being zero.
 */
export const OPENCODE_CACHE_TIER_TREATMENT =
  `${OPENCODE_ZEN_SERVICE_NAME} publishes a separate cache-read rate for all six models and a cache-write rate for `
  + 'opencode/big-pickle only. Cernum\'s PricingSnapshot has no cache tier, so no cache rate is used as a rate and '
  + 'none is invented for the five models that publish no cache-write figure. Instead the treatment already '
  + 'established in frontier-host.ts applies unchanged: every input-side token — fresh, cache-write and cache-read '
  + 'alike — is priced at the single published input rate. That can overstate a charge and can never understate one, '
  + 'which is the only direction in which an imprecise pricing model is safe for a spending ceiling.';

/**
 * Why a $0 published list price does not end the matter, said in the place the $0 is recorded.
 *
 * A calculated ceiling of $0.00 is an arithmetic result about a price list. It is not a guarantee
 * about a bill, and the gap between those is not rhetorical: the price may have changed since
 * `capturedAt` — Cernum never fetches, by design, so a stale capture is the normal failure — the
 * credential may be billed under terms the public catalogue does not describe, a free tier may be
 * rate-limited into a paid overflow, and this engine has no observed charge from OpenCode to check any
 * of it against. `authorizeSpending` refuses a ceiling of zero for the related reason: a run whose
 * stopping condition is zero has no stopping condition.
 */
export const ZERO_LIST_PRICE_DOES_NOT_MEAN_ZERO_BILL =
  'A published list price of $0/$0 makes the CALCULATED ceiling for this cohort $0.00, because the calculation is '
  + 'tokens times the published rate and the published rate is zero. It does not make the BILL zero, and the two are '
  + 'not the same claim. Cernum never fetches prices, so this capture is as current as its capturedAt and no more; a '
  + 'published rate is not the terms this credential is billed under; a free tier can be metered into a paid '
  + 'overflow; and this engine holds no observed OpenCode charge to check any of that against. The token floor and '
  + 'ceiling are therefore the real magnitudes of this cohort and must be read as the exposure: they are large, they '
  + 'are measured, and they are what a changed price would be multiplied by.';

/**
 * THE ONE FIGURE OPENCODE HAS EVER REPORTED ABOUT MONEY, and why it is still not an observed charge.
 *
 * It would be easy, and wrong, to say Cernum has read nothing from OpenCode about cost. It has read
 * exactly one thing. The captured envelope in `test/engine/fixtures/opencode-run-json.ts` carries
 * `"cost":0` on its `step-finish` part — a key that was PRESENT, so it is a reported zero rather than
 * a silence — and the adapter preserves it verbatim as `openCodeReportedCostUnitUnverified`.
 *
 * IT IS NOT PROMOTED TO A CHARGE, AND THE REASON IS NOT SQUEAMISHNESS. OpenCode declares no unit for
 * that number: not a currency, not a scale. `attemptCostMicroUSD` deals in integer microUSD, and a
 * bare number whose unit nobody established cannot be put in that column — which is why
 * `costProvenance` for an OpenCode attempt is `unavailable` and `OPENCODE_COST_EXPLANATION` still
 * stands. The tempting shortcut is that zero is zero in every unit, so this one is safe to promote.
 * It is not safe: an unlabelled zero is equally consistent with "nothing was charged" and with "this
 * field was never computed", and the second is a common thing for a free tier to emit. One sample, on
 * one model, from a field with no declared unit, is corroboration of the published $0 for
 * `opencode/big-pickle` and is not a measurement of it — and it says nothing at all about the other
 * five, which have never been sent a request.
 */
export const OPENCODE_REPORTED_COST_FIGURE = {
  modelID: 'opencode/big-pickle',
  observedAt: '2026-09-20',
  /** Verbatim from the captured `step-finish` part. Present, and therefore a reported zero. */
  reportedCost: 0,
  unit: 'UNDECLARED — OpenCode names no currency and no scale for this field',
  carriedAs: 'rawUsage.openCodeReportedCostUnitUnverified',
  promotedToACharge: false,
} as const;

export const OPENCODE_REPORTED_COST_IS_NOT_A_CHARGE =
  'OpenCode reported `cost: 0` on the one request Cernum has ever sent it (opencode/big-pickle, 2026-09-20). The key '
  + 'was present, so that is a reported zero and not a silence, and it is preserved verbatim as '
  + 'openCodeReportedCostUnitUnverified. It is NOT recorded as an observed charge: OpenCode declares no currency and '
  + 'no scale for the field, and an unlabelled zero is as consistent with "never computed" as with "nothing was '
  + 'billed". It corroborates the published $0 for that one model. It measures nothing, and it says nothing about the '
  + 'other five, which have never been sent a request at all.';

/**
 * The warning that outlives the estimate. Carried into the authorization disclosure and the admission
 * record, because the moment this is most needed is after the run, when the numbers look settled.
 */
export const POST_RUN_RECONCILIATION_REQUIRED =
  'POST-RUN RECONCILIATION IS STILL REQUIRED. These are published catalogue prices, not observed charges, so a '
  + 'completed run at an estimated $0.00 is not evidence that $0.00 was billed. After any scored OpenCode campaign, '
  + 'the provider account\'s own usage and billing record must be read and compared against what Cernum estimated, '
  + 'and the difference recorded. Until that comparison exists, the cost of an OpenCode campaign is ESTIMATED FROM A '
  + `PRICE LIST and nothing more. ${OPENCODE_COST_EXPLANATION}`;
