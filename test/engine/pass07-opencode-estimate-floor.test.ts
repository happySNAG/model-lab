// Pass 7 · the OpenCode spending FLOOR, corrected against the request Cernum actually measured.
//
// WHAT THE PREVIOUS PASS FIXED, AND WHAT IT LEFT. `pass07-opencode-input-budget.test.ts` corrected the
// CEILING: `maxInputTokens`, the figure `worstCaseAttemptMicroUSD` and `SpendTracker.check` stop a run
// against. It did not touch the other end of the range. `estimateSpending` still derived its floor from
// `promptCharacters / 4` for every provider alike, which estimates a PROMPT — and on this provider the
// prompt is not the request. `opencode run` is handed a prompt and sends an AGENT TURN with the prompt
// inside it.
//
// WHY A FLOOR THAT LOW IS NOT MERELY IMPRECISE. On the proposed first cohort — `foundation`, 4 attempts —
// the generic floor is 210 tokens, against 31,712 tokens of scaffolding a captured envelope says those
// four requests inject before a single benchmark character is counted. That is not a conservative
// estimate that happens to be low; it is a floor BELOW THE MINIMUM THE EVIDENCE PERMITS, so the range a
// person was asked to authorize began at a number the request cannot reach.
//
// WHY THE FLOOR DOES NOT USE THE CEILING'S NUMBER. `OPENCODE_INJECTED_INPUT_TOKENS` is 16,384: measured,
// rounded to a power of two, doubled for the fact that it is one sample. A ceiling may carry that margin.
// A floor may not — an inflated floor is a second ceiling wearing the word "minimum". So the floor uses
// the measurement itself, 7,928, unrounded and undoubled.
//
// THE EVIDENCE IS THE CAPTURE AND NOTHING ELSE, and PRICING IS NOT PART OF IT. Every token figure here is
// read out of `fixtures/opencode-run-json.ts`. The one price in this file is a fixture invented by this
// file to make a token difference visible as a dollar difference; it is not a provider price list, it was
// never fetched, and Cernum holds no pricing snapshot for OpenCode. NOTHING HERE CONTACTS ANY PROVIDER.

import { describe, expect, it } from 'vitest';
import { BuiltCampaign, budgetsFor, buildCampaignPlan } from '../../src/engine/campaign-builder';
import { buildEngineCatalogue } from '../../src/engine/catalogue';
import {
  OPENCODE_FLOOR_INJECTED_INPUT_TOKENS, OPENCODE_INJECTED_INPUT_TOKENS, OPENCODE_INPUT_FLOOR_DERIVATION,
  OPENCODE_MEASURED_REQUEST_INPUT, openCodeEstimatedInputFloor,
} from '../../src/engine/opencode-cli';
import { PricingSnapshot, ProviderBinding, operationalEnvelopeDigest } from '../../src/engine/provider';
import {
  SpendTracker, SpendingError, authorizeSpending, estimateSpending, worstCaseAttemptMicroUSD,
} from '../../src/engine/spending';
import {
  AdmittedCandidateEvidence, IdentityAdmission, REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE,
  authorizeIdentityAdmission,
} from '../../src/engine/identity-admission';
import { OPENCODE_BIG_PICKLE_OBSERVED } from './fixtures/opencode-run-json';

const OPENCODE_MODEL = 'opencode/big-pickle';
const LABEL = 'pass-7-opencode-floor';
const OPENCODE_CANDIDATE = `opencodeCLI:${OPENCODE_MODEL}`;
const CLAUDE_CANDIDATE = 'claudeCLI:claude-opus-5';
const SUITES = ['suite.model-lab.foundation'];

/** A fixture rate, so a token difference is visible as a dollar difference. Never fetched from anyone. */
const PRICES: PricingSnapshot = {
  source: 'a fixture written by this test; not a provider price list and never fetched from anyone',
  capturedAt: '2026-01-01T00:00:00Z',
  currency: 'USD',
  inputMicroUSDPerMillionTokens: 3_000_000,
  outputMicroUSDPerMillionTokens: 15_000_000,
  reasoningMicroUSDPerMillionTokens: null,
};

const HARDWARE = {
  platform: 'darwin', architecture: 'arm64', model: 't', cpuCoreCount: 1, physicalMemoryBytes: 1, osVersion: 't',
};

function evidenceFor(modelID = OPENCODE_MODEL): AdmittedCandidateEvidence {
  return {
    provider: 'opencodeCLI',
    requestedModelID: modelID,
    requestedEffort: 'none',
    cliVersion: 'opencode-ai 1.18.31',
    authenticationBasis: 'toolManagedCredential — OpenCode Zen [api]',
    evidenceDigest: 'mlo1:0123456789abcdef',
    evidenceCapturedAt: '2026-09-20T18:53:30Z',
    returnedModelID: '',
    state: REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE,
  };
}

function admission(...admitted: AdmittedCandidateEvidence[]): IdentityAdmission {
  return authorizeIdentityAdmission({
    campaignLabel: LABEL,
    authorizedAt: '2026-09-20T19:00:00Z',
    authorizedBy: 'the test, standing in for the written Pass 7 approval',
    admitted: admitted.length > 0 ? admitted : [evidenceFor()],
  });
}

/** Claude arrives PROVEN, because the identity exception is OpenCode's alone and must stay that way. */
const PROVEN_CLAUDE = {
  provider: 'claudeCLI', modelID: 'claude-opus-5', displayName: 'Claude Opus 5', availability: 'proven',
  evidence: 'a fixture written by this test; no provider was contacted', verifiedModelID: 'claude-opus-5',
  desiredEfforts: ['none'], discoveredAt: '2026-09-20T18:00:00Z',
};

function planWith(frontier: Record<string, unknown>[], repeats = 1): BuiltCampaign {
  return buildCampaignPlan({
    label: LABEL,
    suiteIDs: SUITES,
    repeatsPerCase: repeats,
    local: [],
    endpoint: 'http://127.0.0.1:11434',
    hardware: HARDWARE,
    runtimeVersion: 'test',
    frontier,
    provenModels: [PROVEN_CLAUDE],
    identityAdmission: admission(),
  } as never);
}

const openCodeCandidate = (over: Record<string, unknown> = {}) => ({
  name: OPENCODE_CANDIDATE, provider: 'opencodeCLI', modelID: OPENCODE_MODEL, effort: 'none',
  thinkingMode: 'disabled', pricing: PRICES, ...over,
});

/** A subscription provider, to prove the correction did not leak sideways. */
const claudeCandidate = () => ({
  name: CLAUDE_CANDIDATE, provider: 'claudeCLI', modelID: 'claude-opus-5', effort: 'none',
  thinkingMode: 'disabled',
});

const bindingFor = (plan: BuiltCampaign, candidate: string): ProviderBinding =>
  plan.envelope.bindings.find((entry) => entry.candidate === candidate)!;

const estimateFor = (plan: BuiltCampaign, candidate: string) =>
  estimateSpending(plan.envelope, plan.plannedWork).perCandidate.find((e) => e.candidate === candidate)!;

const defaults = () => budgetsFor(buildEngineCatalogue(SUITES, 1));

/** The generic floor, spelled out here so a test can say what it is INSTEAD of. */
const genericFloor = (plan: BuiltCampaign, candidate: string) =>
  Math.ceil(plan.plannedWork.find((w) => w.candidate === candidate)!.promptCharacters / 4);

describe('Pass 7 · the floor is the measurement, not the ceiling\'s margin', () => {
  it('takes its overhead from the captured envelope, undoubled and unrounded', () => {
    const t = OPENCODE_BIG_PICKLE_OBSERVED.tokens;

    // The floor's overhead IS the injected figure the capture yields: (input + cacheRead + cacheWrite)
    // less the prompt's own share. Read through, not retyped.
    expect(OPENCODE_FLOOR_INJECTED_INPUT_TOKENS).toBe(OPENCODE_MEASURED_REQUEST_INPUT.injectedInputTokens);
    expect(OPENCODE_FLOOR_INJECTED_INPUT_TOKENS)
      .toBe(t.input + t.cacheRead + t.cacheWrite - OPENCODE_MEASURED_REQUEST_INPUT.promptInputTokens);

    // A FLOOR MAY NOT CARRY THE CEILING'S SAFETY MARGIN. If these two were ever made equal, the floor
    // would stop being a floor and this is the assertion that would catch it.
    expect(OPENCODE_FLOOR_INJECTED_INPUT_TOKENS).toBeLessThan(OPENCODE_INJECTED_INPUT_TOKENS);
    expect(OPENCODE_INJECTED_INPUT_TOKENS).toBe(16_384);
    expect(OPENCODE_FLOOR_INJECTED_INPUT_TOKENS).toBe(7_928);
  });

  it('adds the overhead once per attempt, because every attempt is its own --pure session', () => {
    expect(openCodeEstimatedInputFloor(210, 4, 1_000_000))
      .toBe(210 + OPENCODE_FLOOR_INJECTED_INPUT_TOKENS * 4);
    expect(openCodeEstimatedInputFloor(210, 1, 1_000_000))
      .toBe(210 + OPENCODE_FLOOR_INJECTED_INPUT_TOKENS);
    // Not added once for the whole campaign, which is the tempting cheaper reading.
    expect(openCodeEstimatedInputFloor(210, 4, 1_000_000))
      .toBeGreaterThan(210 + OPENCODE_FLOOR_INJECTED_INPUT_TOKENS);
  });

  it('states its derivation in words, and the words claim no MEASURED dollar figure', () => {
    expect(OPENCODE_INPUT_FLOOR_DERIVATION).toContain('7,933');
    expect(OPENCODE_INPUT_FLOOR_DERIVATION).toContain('7,928');
    // REVISED: this asserted `no pricing snapshot`, which was true until the provider's published
    // catalogue prices were captured. What the sentence must still refuse is the stronger claim — that
    // the floor implies a charge anybody OBSERVED — so the assertion moved to the distinction that
    // survives the capture rather than to the absence that did not.
    expect(OPENCODE_INPUT_FLOOR_DERIVATION).toContain('no MEASURED dollar figure');
    expect(OPENCODE_INPUT_FLOOR_DERIVATION).toContain('PUBLISHED list price');
    expect(OPENCODE_INPUT_FLOOR_DERIVATION).toContain('never a charge this engine observed');
    expect(OPENCODE_INPUT_FLOOR_DERIVATION).not.toMatch(/\$\d/);
  });
});

describe('Pass 7 · OpenCode uses the new provider-scoped floor', () => {
  it('estimates the cohort floor as prompt-derived PLUS the measured per-attempt overhead', () => {
    const plan = planWith([openCodeCandidate()]);
    const estimate = estimateFor(plan, OPENCODE_CANDIDATE);
    const old = genericFloor(plan, OPENCODE_CANDIDATE);

    expect(estimate.plannedAttempts).toBe(4);
    expect(old).toBe(210);
    expect(estimate.estimatedInputTokens)
      .toBe(old + OPENCODE_FLOOR_INJECTED_INPUT_TOKENS * estimate.plannedAttempts);
    expect(estimate.estimatedInputTokens).toBe(31_922);
  });

  it('is MATERIALLY higher than the generic estimate, not a rounding difference', () => {
    const plan = planWith([openCodeCandidate()]);
    const estimate = estimateFor(plan, OPENCODE_CANDIDATE);
    const old = genericFloor(plan, OPENCODE_CANDIDATE);

    // The previous floor was two orders of magnitude below the corrected one. A test that only asserted
    // `>` would pass against a one-token change; this is the claim the commit actually makes.
    expect(estimate.estimatedInputTokens).toBeGreaterThan(old * 100);
  });

  it('explains in the record which arithmetic produced the number, and in the statement a person reads',
    () => {
      const estimate = estimateFor(planWith([openCodeCandidate()]), OPENCODE_CANDIDATE);

      expect(estimate.estimatedInputTokenFloorBasis).toContain('OpenCode injected context');
      expect(estimate.estimatedInputTokenFloorBasis).toContain('4 attempt(s)');
      expect(estimate.statement).toContain(`about ${estimate.estimatedInputTokens} tokens`);
      expect(estimate.statement).toContain('OpenCode injected context');
    });

  it('scales with repeats, because attempts scale with repeats', () => {
    const estimate = estimateFor(planWith([openCodeCandidate()], 3), OPENCODE_CANDIDATE);

    expect(estimate.plannedAttempts).toBe(12);
    expect(estimate.estimatedInputTokens).toBe(630 + OPENCODE_FLOOR_INJECTED_INPUT_TOKENS * 12);
  });
});

describe('Pass 7 · the floor is never below the observed equivalent request overhead', () => {
  it('bounds from below what the one measured request actually spent on input', () => {
    // The floor for ONE attempt must not claim less than the single request Cernum observed. The
    // prompt-derived part is whatever the campaign asks; the overhead is what OpenCode adds regardless.
    const oneAttempt = openCodeEstimatedInputFloor(
      OPENCODE_MEASURED_REQUEST_INPUT.promptInputTokens, 1, 1_000_000,
    );

    expect(oneAttempt).toBe(OPENCODE_MEASURED_REQUEST_INPUT.totalInputTokens);
    expect(oneAttempt).toBeGreaterThanOrEqual(OPENCODE_MEASURED_REQUEST_INPUT.totalInputTokens);
  });

  it('bounds the whole cohort from below at the observed rate, and the OLD floor did not', () => {
    const plan = planWith([openCodeCandidate()]);
    const estimate = estimateFor(plan, OPENCODE_CANDIDATE);
    const observedEquivalent = OPENCODE_MEASURED_REQUEST_INPUT.totalInputTokens * estimate.plannedAttempts;

    expect(estimate.estimatedInputTokens).toBeGreaterThanOrEqual(observedEquivalent);
    // THE TEST CAN TELL THE DIFFERENCE: the pre-correction floor would have FAILED this same check.
    expect(genericFloor(plan, OPENCODE_CANDIDATE)).toBeLessThan(observedEquivalent);
  });

  it('never returns less than the ordinary prompt-derived estimate', () => {
    for (const [prompt, attempts, ceiling] of [[210, 4, 66_076], [5, 1, 7_933], [900, 0, 900],
      [50_000, 2, 10], [0, 3, 1_000_000]] as [number, number, number][]) {
      expect(openCodeEstimatedInputFloor(prompt, attempts, ceiling)).toBeGreaterThanOrEqual(prompt);
    }
  });
});

describe('Pass 7 · the floor never exceeds the configured ceiling', () => {
  it('sits inside the frozen range on the cohort, rather than above its own ceiling', () => {
    const plan = planWith([openCodeCandidate()]);
    const estimate = estimateFor(plan, OPENCODE_CANDIDATE);
    const binding = bindingFor(plan, OPENCODE_CANDIDATE);

    expect(binding.maxInputTokens).toBe(defaults().maxInputTokens + OPENCODE_INJECTED_INPUT_TOKENS);
    expect(estimate.maximumInputTokens).toBe(binding.maxInputTokens * estimate.plannedAttempts);
    expect(estimate.estimatedInputTokens).toBeLessThanOrEqual(estimate.maximumInputTokens);
    // And the range is a range: a floor equal to its ceiling would mean the estimate said nothing.
    expect(estimate.estimatedInputTokens).toBeLessThan(estimate.maximumInputTokens);
  });

  it('clamps to the ceiling when attempts alone would carry it past, rather than reporting a floor above a max',
    () => {
      // A deliberately tiny ceiling: many attempts x the overhead would far exceed it.
      const clamped = openCodeEstimatedInputFloor(100, 10_000, 5_000);

      expect(clamped).toBe(5_000);
      expect(clamped).toBeLessThanOrEqual(5_000);
    });

  it('leaves the degenerate binding visible instead of inventing a number for it', () => {
    // A ceiling hand-set BELOW the prompt is a defect in that binding. The floor returns exactly what
    // the shared estimator would have returned, so the pre-existing problem is not papered over.
    expect(openCodeEstimatedInputFloor(900, 4, 10)).toBe(900);
  });

  it('holds floor <= ceiling across the whole cohort and every repeat count', () => {
    for (const repeats of [1, 2, 3, 5, 10]) {
      const plan = planWith([openCodeCandidate()], repeats);
      const estimate = estimateFor(plan, OPENCODE_CANDIDATE);

      expect(estimate.estimatedInputTokens).toBeLessThanOrEqual(estimate.maximumInputTokens);
      expect(estimate.estimatedInputTokens).toBeGreaterThanOrEqual(genericFloor(plan, OPENCODE_CANDIDATE));
    }
  });
});

describe('Pass 7 · every other provider keeps the floor it had', () => {
  it('leaves a subscription candidate on the bare prompt-derived estimate', () => {
    const plan = planWith([openCodeCandidate(), claudeCandidate()]);
    const claude = estimateFor(plan, CLAUDE_CANDIDATE);

    expect(claude.provider).toBe('claudeCLI');
    expect(claude.estimatedInputTokens).toBe(genericFloor(plan, CLAUDE_CANDIDATE));
    expect(claude.estimatedInputTokens).toBe(210);
    expect(claude.estimatedInputTokenFloorBasis).toBe('840 prompt characters at 4 characters per token');
    expect(claude.estimatedInputTokenFloorBasis).not.toContain('OpenCode');
  });

  it('gives two candidates in ONE campaign two different floors from the same prompts', () => {
    // The strongest form of provider-scoping: identical `promptCharacters`, same envelope, same call.
    const plan = planWith([openCodeCandidate(), claudeCandidate()]);
    const openCode = estimateFor(plan, OPENCODE_CANDIDATE);
    const claude = estimateFor(plan, CLAUDE_CANDIDATE);
    const work = plan.plannedWork;

    expect(work[0].promptCharacters).toBe(work[1].promptCharacters);
    expect(openCode.estimatedInputTokens)
      .toBe(claude.estimatedInputTokens + OPENCODE_FLOOR_INJECTED_INPUT_TOKENS * claude.plannedAttempts);
  });

  it('leaves the local runtime alone, and still charges it nothing', () => {
    const plan = buildCampaignPlan({
      label: LABEL, suiteIDs: SUITES, repeatsPerCase: 1,
      local: [{ name: 'ollama:qwen3', modelID: 'qwen3', runtimeDigest: 'sha256:0123456789abcdef',
        parameterSize: '8B', quantization: 'Q4_K_M' }],
      endpoint: 'http://127.0.0.1:11434', hardware: HARDWARE, runtimeVersion: 'test',
      frontier: [], provenModels: [PROVEN_CLAUDE], identityAdmission: admission(),
    } as never);
    const local = estimateFor(plan, 'ollama:qwen3');

    expect(local.estimatedInputTokens).toBe(genericFloor(plan, 'ollama:qwen3'));
    expect(local.minimumMicroUSD).toBe(0);
    expect(local.maximumMicroUSD).toBe(0);
    expect(local.estimatedInputTokenFloorBasis).not.toContain('OpenCode');
  });
});

describe('Pass 7 · authorization, the cost gate and pricing are untouched by a token correction', () => {
  const plan = () => planWith([openCodeCandidate()], 2);

  it('refuses a metered request with no authorization at all, before any ceiling is consulted', () => {
    const built = plan();
    const tracker = new SpendTracker(undefined, operationalEnvelopeDigest(built.envelope));

    expect(() => tracker.check(bindingFor(built, OPENCODE_CANDIDATE), 1))
      .toThrow(/carries no recorded spending authorization/);
  });

  it('refuses an authorization recorded against different bindings', () => {
    const built = plan();
    const authorization = authorizeSpending(estimateSpending(built.envelope, built.plannedWork), {
      campaignID: 'campaign:pass-7-floor', authorizedAt: '2026-09-20T19:00:00Z', authorizedBy: 'the test',
      hardCeilingMicroUSD: 50_000_000, operationalEnvelopeDigest: 'mlo1:a-different-envelope',
    });
    const tracker = new SpendTracker(authorization, operationalEnvelopeDigest(built.envelope));

    expect(() => tracker.check(bindingFor(built, OPENCODE_CANDIDATE), 1))
      .toThrow(/different set of provider bindings/);
  });

  it('still refuses a ceiling of zero, and an estimate that cannot be computed', () => {
    const built = plan();

    expect(() => authorizeSpending(estimateSpending(built.envelope, built.plannedWork), {
      campaignID: 'c', authorizedAt: 'now', authorizedBy: 'the test',
      hardCeilingMicroUSD: 0, operationalEnvelopeDigest: operationalEnvelopeDigest(built.envelope),
    })).toThrow(/greater than zero/);

    const unplanned = estimateSpending(built.envelope, []);
    expect(unplanned.estimable).toBe(false);
    expect(() => authorizeSpending(unplanned, {
      campaignID: 'c', authorizedAt: 'now', authorizedBy: 'the test',
      hardCeilingMicroUSD: 1_000_000, operationalEnvelopeDigest: operationalEnvelopeDigest(built.envelope),
    })).toThrow(/cannot be calculated/);
  });

  it('still stops a run at the hard ceiling, on the same worst-case figure as before', () => {
    const built = plan();
    const binding = bindingFor(built, OPENCODE_CANDIDATE);
    const worstCase = worstCaseAttemptMicroUSD(binding);
    const authorization = authorizeSpending(estimateSpending(built.envelope, built.plannedWork), {
      campaignID: 'campaign:pass-7-floor', authorizedAt: '2026-09-20T19:00:00Z', authorizedBy: 'the test',
      hardCeilingMicroUSD: worstCase, operationalEnvelopeDigest: operationalEnvelopeDigest(built.envelope),
    });
    const tracker = new SpendTracker(authorization, operationalEnvelopeDigest(built.envelope));

    // The gate is computed from `maxInputTokens`, which this pass did not touch.
    expect(() => tracker.check(binding, worstCase)).not.toThrow();
    tracker.record(worstCase, 'estimated');
    expect(() => tracker.check(binding, worstCase)).toThrow(SpendingError);
  });

  it('refuses to estimate a metered OpenCode candidate with no pricing, exactly as before', () => {
    // PRICING STAYS SEPARATE FROM TOKEN ESTIMATION. Correcting the token floor must not conjure a rate.
    // Cernum holds no pricing snapshot for OpenCode, and the refusal fires before the estimator is even
    // reached: a metered binding cannot be BUILT without one. A corrected floor did not soften that.
    expect(() => planWith([openCodeCandidate({ pricing: undefined })], 1))
      .toThrow(/will not estimate a cost from prices it invented/);
  });

  it('turns the corrected floor into dollars only through the snapshot, at the snapshot\'s own rate', () => {
    const built = planWith([openCodeCandidate()], 1);
    const estimate = estimateFor(built, OPENCODE_CANDIDATE);

    // The floor's dollars are the floor's TOKENS times the rate the snapshot carries, and nothing else.
    expect(estimate.minimumMicroUSD)
      .toBe(Math.floor((estimate.estimatedInputTokens * PRICES.inputMicroUSDPerMillionTokens) / 1_000_000));
    expect(estimate.pricing).toBe(PRICES);
    expect(estimate.pricing!.source).toContain('never fetched');
    // And the floor is still a floor: strictly below the ceiling it is quoted beside.
    expect(estimate.minimumMicroUSD).toBeLessThan(estimate.maximumMicroUSD);
  });
});
