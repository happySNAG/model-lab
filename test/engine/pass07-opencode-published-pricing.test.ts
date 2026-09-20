// Pass 7 · the OpenCode published pricing capture, and the distinction it is not allowed to blur.
//
// WHAT THIS FILE HOLDS SHUT. A pricing capture is the easiest place in this engine to turn a seller's
// claim into a measurement, because the two are the same shape: a number, a source, a date. So the
// assertions here are mostly about WORDING AND PROVENANCE rather than about arithmetic, and that is
// deliberate — the arithmetic of multiplying by zero is not where this goes wrong.
//
// THE FOUR THINGS A ZERO LIST PRICE MUST NOT DO, each with a test below:
//
//   · it must not become an OBSERVED charge. `costProvenance` stays `unavailable`.
//   · it must not reclassify a metered candidate as free, subscription-included or local.
//   · it must not shrink the TOKEN floor and ceiling, which are the real exposure.
//   · it must not excuse a spending ceiling. `authorizeSpending` still refuses zero.
//
// AND ONE THING THE CAPTURE ITSELF MUST NOT DO: invent a rate the provider did not publish. The
// catalogue publishes `cache_write` for exactly one of the six, and the capture says so for exactly
// one of the six.
//
// NOTHING HERE CONTACTS ANY PROVIDER, launches any CLI, or reads the live catalogue. Every figure is
// read from the committed pricing file and the committed capture module.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FREE_OPENCODE_DEVELOPMENT_POOL } from '../../src/engine/discovery';
import {
  OPENCODE_COST_EXPLANATION, OPENCODE_COST_PROVENANCE, OPENCODE_FIRST_LIVE_REQUEST_MODEL,
} from '../../src/engine/opencode-cli';
import {
  OPENCODE_CACHE_TIER_TREATMENT, OPENCODE_REPORTED_COST_FIGURE, OPENCODE_REPORTED_COST_IS_NOT_A_CHARGE,
  OPENCODE_ZEN_CATALOGUE_PATH, OPENCODE_ZEN_CATALOGUE_SHA256, OPENCODE_ZEN_PRICING_CAPTURED_AT,
  OPENCODE_ZEN_PRICING_CLI_VERSION, OPENCODE_ZEN_PRICING_COMMAND, OPENCODE_ZEN_PRICING_SOURCE,
  OPENCODE_ZEN_PRICING_UNIT, OPENCODE_ZEN_PUBLISHED_PRICES, POST_RUN_RECONCILIATION_REQUIRED,
  PUBLISHED_PRICE_IS_NOT_A_MEASURED_CHARGE, PublishedCataloguePrice, ZERO_LIST_PRICE_DOES_NOT_MEAN_ZERO_BILL,
  assertNoUnpricedTier, openCodePricingFileEntries, publishedPriceFor, publishedUSDToMicroUSD, snapshotFor,
} from '../../src/engine/opencode-pricing';
import { OPENCODE_BIG_PICKLE_OBSERVED } from './fixtures/opencode-run-json';
import { billingBasisOf, executionClassOf, pricingFor } from '../../src/engine/provider';
import { SpendingError, authorizeSpending, worstCaseAttemptMicroUSD } from '../../src/engine/spending';
import { EVIDENCE_STATUS, PRICING_FILE, SMOKE_EVIDENCE, estimateCohort } from '../../scripts/pass07-opencode-cost-estimate';

const repositoryRoot = path.resolve(__dirname, '..', '..');
const pricingFileContents = JSON.parse(
  fs.readFileSync(path.join(repositoryRoot, PRICING_FILE), 'utf8')) as Record<string, unknown>;

describe('Pass 7 · the capture is the six cohort members and nobody else', () => {
  it('prices every model in the free development pool, and no model outside it', () => {
    expect(OPENCODE_ZEN_PUBLISHED_PRICES.map((row) => row.modelID).sort())
      .toEqual(FREE_OPENCODE_DEVELOPMENT_POOL.map((entry) => entry.modelID).sort());
  });

  it('leaves out the finance model the cohort deliberately leaves out', () => {
    // `opencode/ling-3.0-flash-fin-free` publishes the same zero and is not a development model. Pricing
    // it would price a member of no cohort, and a price sitting in a file is an invitation to use it.
    expect(publishedPriceFor('opencode/ling-3.0-flash-fin-free')).toBeUndefined();
  });

  it('carries OpenCode\'s own provider/model address unchanged, so what is priced is what is asked for', () => {
    for (const row of OPENCODE_ZEN_PUBLISHED_PRICES) expect(row.modelID.startsWith('opencode/')).toBe(true);
  });
});

describe('Pass 7 · the published figures, recorded as published', () => {
  it('records input $0 and output $0 per million tokens for all six, as the catalogue publishes them', () => {
    for (const row of OPENCODE_ZEN_PUBLISHED_PRICES) {
      expect(row.publishedUSDPerMillionTokens.input, row.modelID).toBe(0);
      expect(row.publishedUSDPerMillionTokens.output, row.modelID).toBe(0);
      expect(row.inputMicroUSDPerMillionTokens, row.modelID).toBe(0);
      expect(row.outputMicroUSDPerMillionTokens, row.modelID).toBe(0);
      expect(row.currency, row.modelID).toBe('USD');
      expect(row.unit, row.modelID).toBe(OPENCODE_ZEN_PRICING_UNIT);
    }
  });

  it('marks them free the way the catalogue marks them — by price, not by a flag it does not publish', () => {
    // The catalogue has no boolean `free` field. Five of the six say `-free` in their NAME, which is not a
    // price; `opencode/big-pickle` says nothing and publishes the same zero. A cohort read off identifiers
    // would have dropped a member.
    for (const row of OPENCODE_ZEN_PUBLISHED_PRICES) expect(row.freeMarking, row.modelID).toBe('zeroListPrice');
    expect(publishedPriceFor('opencode/big-pickle')!.modelID).not.toContain('free');
  });

  it('scales a published dollar figure to integer microUSD, so a real rate would survive the capture', () => {
    // Guards the conversion against being a hardcoded zero: the six are zero because the PROVIDER is, and
    // the same function must carry $0.05/Mtok and $15/Mtok correctly the day one of them stops being free.
    expect(publishedUSDToMicroUSD(0)).toBe(0);
    expect(publishedUSDToMicroUSD(0.05)).toBe(50_000);
    expect(publishedUSDToMicroUSD(15)).toBe(15_000_000);
    expect(Number.isInteger(publishedUSDToMicroUSD(3.125))).toBe(true);
  });

  it('publishes NO reasoning tier, and records null rather than zero — they are different claims', () => {
    for (const row of OPENCODE_ZEN_PUBLISHED_PRICES) {
      // null: "the provider does not bill reasoning apart", which routes reasoning through the output rate.
      // zero would assert a separate tier priced at nothing, which the catalogue never says.
      expect(row.reasoningMicroUSDPerMillionTokens, row.modelID).toBeNull();
      expect(row.publishedUSDPerMillionTokens.reasoning, row.modelID).toBeNull();
      expect(snapshotFor(row).reasoningMicroUSDPerMillionTokens, row.modelID).toBeNull();
    }
  });
});

describe('Pass 7 · cache tiers are recorded as published and never invented', () => {
  it('publishes a cache-read rate for all six and a cache-write rate for exactly one', () => {
    for (const row of OPENCODE_ZEN_PUBLISHED_PRICES) {
      expect(row.cacheReadTierPublished, row.modelID).toBe(true);
      expect(row.publishedUSDPerMillionTokens.cacheRead, row.modelID).toBe(0);
    }
    const withCacheWrite = OPENCODE_ZEN_PUBLISHED_PRICES.filter((row) => row.cacheWriteTierPublished);
    expect(withCacheWrite.map((row) => row.modelID)).toEqual(['opencode/big-pickle']);
  });

  it('records an unpublished cache-write rate as ABSENT, not as a zero this capture made up', () => {
    // The cheapest lie available here: the invented figure happens to be correct today. It is still a
    // number put in the provider's mouth, and it would be wrong the day the provider publishes a real one.
    for (const row of OPENCODE_ZEN_PUBLISHED_PRICES.filter((entry) => !entry.cacheWriteTierPublished)) {
      expect(row.publishedUSDPerMillionTokens.cacheWrite, row.modelID).toBeNull();
      expect(row.publishedUSDPerMillionTokens.cacheWrite, row.modelID).not.toBe(0);
    }
  });

  it('states the conservative treatment Cernum already applies, rather than inventing a new one', () => {
    // The established treatment lives in `frontier-host.ts`: every input-side token — fresh, cache-write
    // and cache-read alike — is priced at the single input rate, which can overstate and cannot understate.
    expect(OPENCODE_CACHE_TIER_TREATMENT).toContain('frontier-host.ts');
    expect(OPENCODE_CACHE_TIER_TREATMENT).toContain('none is invented');
    expect(OPENCODE_CACHE_TIER_TREATMENT).toContain('can overstate a charge and can never understate one');
  });

  it('refuses a capture carrying a context tier a single-rate snapshot cannot express', () => {
    expect(() => assertNoUnpricedTier()).not.toThrow();
    for (const row of OPENCODE_ZEN_PUBLISHED_PRICES) expect(row.contextTierPublished, row.modelID).toBe(false);

    const tiered: PublishedCataloguePrice = { ...OPENCODE_ZEN_PUBLISHED_PRICES[0], contextTierPublished: true };
    expect(() => assertNoUnpricedTier([tiered])).toThrow(/context-tier price/);
    // The refusal names the direction that matters: understating a ceiling, not merely being imprecise.
    expect(() => assertNoUnpricedTier([tiered])).toThrow(/understates the ceiling/);
  });
});

describe('Pass 7 · provenance survives into the one field an artefact will carry', () => {
  it('says PUBLISHED LIST PRICE before it says anything else', () => {
    // `PricingSnapshot` carries `source` and `capturedAt` and nothing else. A reader holding only the
    // snapshot must still be unable to read it as a measurement, so the label is in the source string.
    expect(OPENCODE_ZEN_PRICING_SOURCE.startsWith('PUBLISHED LIST PRICE')).toBe(true);
    expect(OPENCODE_ZEN_PRICING_SOURCE).toContain('not an observed charge');
  });

  it('names the command, the file, its digest, the CLI version and the unit', () => {
    expect(OPENCODE_ZEN_PRICING_SOURCE).toContain(OPENCODE_ZEN_PRICING_COMMAND);
    expect(OPENCODE_ZEN_PRICING_SOURCE).toContain(OPENCODE_ZEN_CATALOGUE_PATH);
    expect(OPENCODE_ZEN_PRICING_SOURCE).toContain(OPENCODE_ZEN_CATALOGUE_SHA256.slice(0, 16));
    expect(OPENCODE_ZEN_PRICING_SOURCE).toContain(OPENCODE_ZEN_PRICING_CLI_VERSION);
    expect(OPENCODE_ZEN_PRICING_SOURCE).toContain(OPENCODE_ZEN_PRICING_UNIT);
  });

  it('stamps every row with the same capture time, in a form that sorts', () => {
    for (const row of OPENCODE_ZEN_PUBLISHED_PRICES) {
      expect(row.capturedAt, row.modelID).toBe(OPENCODE_ZEN_PRICING_CAPTURED_AT);
      expect(row.source, row.modelID).toBe(OPENCODE_ZEN_PRICING_SOURCE);
    }
    expect(OPENCODE_ZEN_PRICING_CAPTURED_AT).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });
});

describe('Pass 7 · the committed pricing file loads through the loader a person would use', () => {
  it('is exactly what the capture module builds, so the file and the module cannot drift', () => {
    expect(pricingFileContents).toEqual(openCodePricingFileEntries());
  });

  it('is keyed <provider>:<model>, so a same-named model on another provider cannot match', () => {
    for (const row of OPENCODE_ZEN_PUBLISHED_PRICES) {
      expect(Object.keys(pricingFileContents)).toContain(`opencodeCLI:${row.modelID}`);
    }
    expect(Object.keys(pricingFileContents)).toHaveLength(OPENCODE_ZEN_PUBLISHED_PRICES.length);
  });

  it('is accepted by pricingFor, with its source and capture time intact', () => {
    for (const row of OPENCODE_ZEN_PUBLISHED_PRICES) {
      const loaded = pricingFor(pricingFileContents, 'opencodeCLI', row.modelID);
      expect(loaded, row.modelID).toBeDefined();
      expect(loaded, row.modelID).toEqual(snapshotFor(row));
      expect(loaded!.source, row.modelID).toContain('PUBLISHED LIST PRICE');
      expect(loaded!.capturedAt, row.modelID).toBe(OPENCODE_ZEN_PRICING_CAPTURED_AT);
    }
  });

  it('loads a rate of ZERO rather than failing to load — zero is a price, not a missing price', () => {
    // The failure this guards: a loader that treated 0 as falsy would return undefined, the cohort would
    // be NOT ESTIMABLE, and the run would be refused for an input that is present and is zero.
    const loaded = pricingFor(pricingFileContents, 'opencodeCLI', 'opencode/big-pickle')!;
    expect(loaded.inputMicroUSDPerMillionTokens).toBe(0);
    expect(loaded.outputMicroUSDPerMillionTokens).toBe(0);
    expect(loaded.reasoningMicroUSDPerMillionTokens).toBeNull();
  });

  it('carries the published-vs-measured warning and the reconciliation requirement in the file itself', () => {
    // The file outlives this session and may be read by somebody who never opens the module.
    for (const key of Object.keys(pricingFileContents)) {
      const row = pricingFileContents[key] as Record<string, unknown>;
      expect(row.pricingProvenance, key).toBe('publishedCataloguePrice');
      expect(String(row.notAMeasuredCharge), key).toContain('NOT a charge Cernum observed');
      expect(String(row.reconciliationRequired), key).toContain('POST-RUN RECONCILIATION IS STILL REQUIRED');
    }
  });

  it('does not write a reasoning rate into the file at all, so the loader reads null and not zero', () => {
    for (const key of Object.keys(pricingFileContents)) {
      expect(pricingFileContents[key], key).not.toHaveProperty('reasoningMicroUSDPerMillionTokens');
    }
  });
});

describe('Pass 7 · a published zero is not an observed charge', () => {
  it('leaves the cost provenance of an OpenCode attempt UNAVAILABLE', () => {
    expect(OPENCODE_COST_PROVENANCE).toBe('unavailable');
    expect(OPENCODE_COST_EXPLANATION).toContain('UNAVAILABLE');
    expect(OPENCODE_COST_EXPLANATION).toContain('not measured');
  });

  it('corrects the cost explanation without softening the part that was load-bearing', () => {
    // It used to say Cernum "holds no pricing" for OpenCode, which this capture made false. The claim that
    // had to survive is the other one: no charge was ever OBSERVED.
    expect(OPENCODE_COST_EXPLANATION).toContain('PUBLISHED list prices');
    expect(OPENCODE_COST_EXPLANATION).not.toContain('holds no pricing');
    expect(OPENCODE_COST_EXPLANATION).toContain('no OBSERVED charge');
  });

  it('keeps the one reported cost figure as an unlabelled zero, not as a measurement', () => {
    expect(OPENCODE_REPORTED_COST_FIGURE.modelID).toBe(OPENCODE_FIRST_LIVE_REQUEST_MODEL);
    expect(OPENCODE_REPORTED_COST_FIGURE.reportedCost).toBe(OPENCODE_BIG_PICKLE_OBSERVED.cost);
    expect(OPENCODE_REPORTED_COST_FIGURE.promotedToACharge).toBe(false);
    expect(OPENCODE_REPORTED_COST_FIGURE.unit).toContain('UNDECLARED');
    expect(OPENCODE_REPORTED_COST_IS_NOT_A_CHARGE).toContain('corroborates');
    expect(OPENCODE_REPORTED_COST_IS_NOT_A_CHARGE).toContain('measures nothing');
  });

  it('says the published price is not an entitlement either', () => {
    expect(PUBLISHED_PRICE_IS_NOT_A_MEASURED_CHARGE).toContain('DISCOVERED and UNPROVEN');
    expect(PUBLISHED_PRICE_IS_NOT_A_MEASURED_CHARGE).toContain('may be stale');
  });

  it('requires post-run reconciliation against the provider account, in writing', () => {
    expect(POST_RUN_RECONCILIATION_REQUIRED).toContain('provider account');
    expect(POST_RUN_RECONCILIATION_REQUIRED).toContain('not evidence that');
    expect(POST_RUN_RECONCILIATION_REQUIRED).toContain('ESTIMATED FROM A PRICE LIST');
  });
});

describe('Pass 7 · a zero price does not reclassify a metered candidate', () => {
  it('keeps opencodeCLI on meteredAPI, whatever the price says', () => {
    // The failure this refuses: a free model reclassified as subscription-included or local, which would
    // stamp every row with a zero marginal charge on a service that bills per token.
    expect(executionClassOf('opencodeCLI')).toBe('meteredAPI');
    expect(billingBasisOf(executionClassOf('opencodeCLI'))).toBe('meteredAPI');
  });

  it('prices every cohort binding as metered in the estimate, not as free or subscription-included', () => {
    const estimate = estimateCohort(repositoryRoot);
    expect(estimate.candidates).toBe(FREE_OPENCODE_DEVELOPMENT_POOL.length);
    expect(estimate.lines.join('\n')).toContain('billed per token against your key');
    expect(estimate.lines.join('\n')).not.toContain('subscription you already pay for');
  });
});

describe('Pass 7 · the non-executing cohort estimate', () => {
  const estimate = estimateCohort(repositoryRoot);

  it('is estimable, at a dollar floor and ceiling of zero, from the published rate', () => {
    expect(estimate.dollarFloorMicroUSD).toBe(0);
    expect(estimate.dollarCeilingMicroUSD).toBe(0);
  });

  it('reports token magnitudes that are emphatically NOT zero — the exposure the price hides', () => {
    // Per candidate: 210 prompt-derived tokens plus 7,928 measured injected tokens per attempt, across four
    // attempts. Six candidates. These are the numbers a changed price would be multiplied by.
    expect(estimate.plannedAttemptsPerCandidate).toBe(4);
    expect(estimate.tokenFloor).toBe(6 * (210 + 7_928 * 4));
    expect(estimate.tokenFloor).toBe(191_532);
    expect(estimate.tokenCeiling).toBe(6 * ((135 + 16_384) * 4 + 64 * 4));
    expect(estimate.tokenCeiling).toBe(397_992);
    expect(estimate.tokenCeiling).toBeGreaterThan(estimate.tokenFloor);
  });

  it('carries the pricing source and capture time into the figures it reports', () => {
    expect(estimate.pricingSource).toBe(OPENCODE_ZEN_PRICING_SOURCE);
    expect(estimate.capturedAt).toBe(OPENCODE_ZEN_PRICING_CAPTURED_AT);
    expect(estimate.lines.join('\n')).toContain(OPENCODE_ZEN_PRICING_CAPTURED_AT);
  });

  it('reports every cohort member as accepted-and-unverifiable, and names the artifact each rests on', () => {
    // WHAT THIS ASSERTION USED TO BE, AND WHY IT MOVED. Until 2026-09-20T20:52Z it read "five of the six
    // have never been sent a request": one member was execution-proven and the rest were a catalogue entry
    // and a price. All six have since been smoked once each with --evidence, so that assertion was checking
    // a shortfall that no longer exists. The claim it is replaced by is the one that SURVIVES a complete
    // cohort: a smoke establishes acceptance, never identity, and a cohort with six smokes behind it is
    // exactly as unproven as a cohort with one.
    expect(EVIDENCE_STATUS[OPENCODE_FIRST_LIVE_REQUEST_MODEL]).toBe('requestAcceptedIdentityUnverifiable');
    for (const entry of FREE_OPENCODE_DEVELOPMENT_POOL) {
      expect(EVIDENCE_STATUS[entry.modelID]).toBe('requestAcceptedIdentityUnverifiable');
      // Every status of that kind must be backed by a NAMED artifact. A status asserted without one would
      // be the manufactured evidence this whole preview is written to avoid.
      expect(SMOKE_EVIDENCE[entry.modelID]?.artifact).toMatch(/^pass07-.*\.json$/);
      expect(SMOKE_EVIDENCE[entry.modelID]?.capturedAt).toMatch(/^2026-09-20T\d\d:\d\d:\d\dZ$/);
    }
    expect(Object.values(EVIDENCE_STATUS).filter((value) => value === 'noRequestEverSent')).toHaveLength(0);
    // NOT 'executionProven', and never a word that reads as selectable. The reply names no model on this
    // path, so a substituted model would be indistinguishable and the status must not imply otherwise.
    expect(Object.values(EVIDENCE_STATUS)).not.toContain('executionProven');
  });

  it('leaves noRequestEverSent reachable for a pool member with no artifact', () => {
    // The union keeps both values so a model added to the pool later reads as unsmoked rather than
    // inheriting the status of the six that were. This is the guard on that, since nothing in the cohort
    // exercises the branch today.
    expect(SMOKE_EVIDENCE['opencode/model-that-was-never-smoked']).toBeUndefined();
    expect(Object.keys(SMOKE_EVIDENCE)).toHaveLength(FREE_OPENCODE_DEVELOPMENT_POOL.length);
  });

  it('explains that a zero list price does not make the BILL zero', () => {
    expect(ZERO_LIST_PRICE_DOES_NOT_MEAN_ZERO_BILL).toContain('CALCULATED ceiling');
    expect(ZERO_LIST_PRICE_DOES_NOT_MEAN_ZERO_BILL).toContain('does not make the BILL zero');
    expect(ZERO_LIST_PRICE_DOES_NOT_MEAN_ZERO_BILL).toContain('as current as its capturedAt');
  });
});

describe('Pass 7 · a zero estimate does not excuse a spending ceiling', () => {
  it('still refuses an authorization with a ceiling of zero', () => {
    const estimate = estimateCohort(repositoryRoot);
    // The tempting inference: the estimate is $0.00, so a ceiling is pointless. `authorizeSpending` refuses
    // it for the reason that outlives the price — a run with no stopping condition has no stopping
    // condition, and the published price is the one input here nobody has verified.
    expect(() => authorizeSpending({
      estimable: true, notEstimableBecause: [], perCandidate: [], totalMinimumMicroUSD: 0,
      totalMaximumMicroUSD: 0, meteredCandidateCount: 6, subscriptionCandidateCount: 0, localCandidateCount: 0,
      oldestPricingCapturedAt: OPENCODE_ZEN_PRICING_CAPTURED_AT,
    }, {
      campaignID: 'pass-7-zero-ceiling', authorizedAt: OPENCODE_ZEN_PRICING_CAPTURED_AT,
      authorizedBy: 'the test', hardCeilingMicroUSD: 0, operationalEnvelopeDigest: 'digest',
    })).toThrow(SpendingError);
    expect(estimate.dollarCeilingMicroUSD).toBe(0);
  });

  it('computes a per-attempt worst case of zero at a zero rate, and a real one at a real rate', () => {
    // Proves the worst case reads the RATE rather than being short-circuited for OpenCode: swap the
    // published zero for a real figure and the same binding's worst case moves.
    const zeroRate = snapshotFor(publishedPriceFor('opencode/big-pickle')!);
    const binding = {
      candidate: 'opencodeCLI:opencode/big-pickle', provider: 'opencodeCLI', executionClass: 'meteredAPI',
      billingBasis: 'meteredAPI', maxInputTokens: 16_519, maxOutputTokens: 64, pricing: zeroRate,
    };
    expect(worstCaseAttemptMicroUSD(binding as never)).toBe(0);

    const paid = { ...binding, pricing: { ...zeroRate, inputMicroUSDPerMillionTokens: 3_000_000 } };
    expect(worstCaseAttemptMicroUSD(paid as never)).toBeGreaterThan(0);
  });
});
