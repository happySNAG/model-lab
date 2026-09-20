// Pass 7 · the OpenCode input budget, corrected against the request Cernum actually measured.
//
// WHAT WAS WRONG. A campaign's input budget came from `budgetsFor`, which is the largest synthetic
// context any chosen case declares, counted in CHARACTERS. Across the whole catalogue that is 588.
// The one live OpenCode request this engine has ever sent carried 7,933 input-side tokens for a
// nineteen-character prompt — 13.5x the budget — because `opencode run` is handed a prompt and sends
// an AGENT TURN: system prompt, tool schemas, session scaffolding, and the prompt inside it.
//
// WHY THAT IS NOT MERELY AN INACCURATE ESTIMATE. `maxInputTokens` is what `worstCaseAttemptMicroUSD`
// computes from, and that is the figure `SpendTracker.check` stops a run against BEFORE the request
// that would breach a ceiling. A ceiling sized from a budget 13.5x below the request is not a strict
// ceiling that occasionally lets something through; it is a ceiling that cannot fire until the run
// is already an order of magnitude past it. The correction is to the bound, and the estimate follows.
//
// THE EVIDENCE IS THE CAPTURE AND NOTHING ELSE. Every figure asserted here is read out of
// `fixtures/opencode-run-json.ts` — the sanitized bytes `opencode run --format json` wrote on
// 2026-09-20 — rather than retyped, so a test that still passes against a re-captured envelope is
// passing for the right reason. NOTHING IN THIS FILE CONTACTS ANY PROVIDER: every assertion is about
// budget arithmetic, estimate objects and refusals.

import { describe, expect, it } from 'vitest';
import {
  BuiltCampaign, budgetsFor, buildCampaignPlan, plannedWorkFor,
} from '../../src/engine/campaign-builder';
import { buildEngineCatalogue } from '../../src/engine/catalogue';
import {
  OPENCODE_INJECTED_INPUT_TOKENS, OPENCODE_INPUT_BUDGET_DERIVATION, OPENCODE_MEASURED_REQUEST_INPUT,
  openCodeInputBudget,
} from '../../src/engine/opencode-cli';
import {
  OPENCODE_SMOKE_MAX_INPUT_TOKENS, SMOKE_MAX_INPUT_TOKENS, SMOKE_MAX_OUTPUT_TOKENS, authorizeSmoke,
  buildSmokeBinding, isSmokeAuthorizationRefusal, projectedMeteredBoundMicroUSD, smokeInputBudgetFor,
} from '../../src/engine/smoke-binding';
import {
  PricingSnapshot, ProviderBinding, ProviderID, operationalEnvelopeDigest,
} from '../../src/engine/provider';
import {
  SpendTracker, SpendingError, attemptCostMicroUSD, authorizeSpending, estimateSpending,
  worstCaseAttemptMicroUSD,
} from '../../src/engine/spending';
import { AdmittedCandidateEvidence, IdentityAdmission, REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE, authorizeIdentityAdmission } from '../../src/engine/identity-admission';
import { OPENCODE_BIG_PICKLE_OBSERVED } from './fixtures/opencode-run-json';

const OPENCODE_MODEL = 'opencode/big-pickle';
const LABEL = 'pass-7-opencode-budget';
const OPENCODE_CANDIDATE = `opencodeCLI:${OPENCODE_MODEL}`;
const SUITES = ['suite.model-lab.foundation'];

/** Real-looking rates so a difference in budget shows up as a difference in dollars. Never fetched. */
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

/** A plan with one OpenCode candidate, admitted, and whatever else the caller names. Nothing is frozen. */
function planWith(frontier: Record<string, unknown>[], repeats = 1,
                  admitted?: AdmittedCandidateEvidence[]): BuiltCampaign {
  return buildCampaignPlan({
    label: LABEL,
    suiteIDs: SUITES,
    repeatsPerCase: repeats,
    local: [],
    endpoint: 'http://127.0.0.1:11434',
    hardware: HARDWARE,
    runtimeVersion: 'test',
    frontier,
    provenModels: [],
    identityAdmission: admission(...(admitted ?? [])),
  } as never);
}

const openCodeCandidate = (over: Record<string, unknown> = {}) => ({
  name: OPENCODE_CANDIDATE, provider: 'opencodeCLI', modelID: OPENCODE_MODEL, effort: 'none',
  thinkingMode: 'disabled', pricing: PRICES, ...over,
});

const bindingFor = (plan: BuiltCampaign, candidate: string): ProviderBinding =>
  plan.envelope.bindings.find((entry) => entry.candidate === candidate)!;

const defaults = () => budgetsFor(buildEngineCatalogue(SUITES, 1));

describe('Pass 7 · the budget is derived from the capture, and the capture says cache-read is additional', () => {
  it('reads its measurement out of the captured envelope rather than out of a retype', () => {
    const observed = OPENCODE_BIG_PICKLE_OBSERVED.tokens;

    expect(OPENCODE_MEASURED_REQUEST_INPUT.freshInputTokens).toBe(observed.input);
    expect(OPENCODE_MEASURED_REQUEST_INPUT.cacheReadInputTokens).toBe(observed.cacheRead);
    expect(OPENCODE_MEASURED_REQUEST_INPUT.cacheWriteInputTokens).toBe(observed.cacheWrite);
    expect(OPENCODE_MEASURED_REQUEST_INPUT.modelID).toBe(OPENCODE_MODEL);
  });

  it('CACHE-READ IS ADDITIONAL, and the envelope\'s own total is what proves it', () => {
    const t = OPENCODE_BIG_PICKLE_OBSERVED.tokens;
    // If cache-read were a SUBSET of `input`, the emitted total would be input+output+reasoning.
    // It is not: the runtime's own `total` only reconciles when the cached tokens are added.
    expect(t.input + t.output + t.reasoning + t.cacheRead + t.cacheWrite).toBe(t.total);
    expect(t.input + t.output + t.reasoning).not.toBe(t.total);
    // So the input side of that request is the sum of all three input buckets.
    expect(OPENCODE_MEASURED_REQUEST_INPUT.totalInputTokens).toBe(t.input + t.cacheRead + t.cacheWrite);
  });

  it('budgets the whole measured request and then some, and says where the headroom came from', () => {
    expect(OPENCODE_MEASURED_REQUEST_INPUT.injectedInputTokens)
      .toBe(OPENCODE_MEASURED_REQUEST_INPUT.totalInputTokens - OPENCODE_MEASURED_REQUEST_INPUT.promptInputTokens);
    // The allowance covers the entire measured request, prompt included, with the sample-size margin.
    expect(OPENCODE_INJECTED_INPUT_TOKENS).toBeGreaterThan(OPENCODE_MEASURED_REQUEST_INPUT.totalInputTokens);
    expect(OPENCODE_INJECTED_INPUT_TOKENS).toBe(16_384);
    // ADDED, never maximised: every attempt is its own `--pure` session and pays the overhead again.
    expect(openCodeInputBudget(588)).toBe(588 + OPENCODE_INJECTED_INPUT_TOKENS);
    expect(OPENCODE_INPUT_BUDGET_DERIVATION).toContain('7,933');
    expect(OPENCODE_INPUT_BUDGET_DERIVATION).toContain('16,384');
  });
});

describe('Pass 7 · an OpenCode campaign estimate uses the corrected input budget', () => {
  it('freezes the binding at the suite budget PLUS the measured overhead', () => {
    const plan = planWith([openCodeCandidate()]);
    const binding = bindingFor(plan, OPENCODE_CANDIDATE);

    expect(binding.maxInputTokens).toBe(defaults().maxInputTokens + OPENCODE_INJECTED_INPUT_TOKENS);
    // And the old value — the bare suite budget — is what this replaces.
    expect(binding.maxInputTokens).not.toBe(defaults().maxInputTokens);
    expect(binding.maxInputTokens).toBeGreaterThan(OPENCODE_MEASURED_REQUEST_INPUT.totalInputTokens);
  });

  it('applies the overhead to an EXPLICIT override too: an override sizes the prompt, not the tax', () => {
    const plan = planWith([openCodeCandidate({ maxInputTokens: 2_000 })]);

    expect(bindingFor(plan, OPENCODE_CANDIDATE).maxInputTokens).toBe(2_000 + OPENCODE_INJECTED_INPUT_TOKENS);
  });

  it('carries the corrected budget into the estimate, the disclosure and the per-attempt worst case', () => {
    const repeats = 3;
    const plan = planWith([openCodeCandidate()], repeats);
    const estimate = estimateSpending(plan.envelope, plan.plannedWork);
    const entry = estimate.perCandidate.find((row) => row.candidate === OPENCODE_CANDIDATE)!;
    const binding = bindingFor(plan, OPENCODE_CANDIDATE);
    const attempts = plan.plannedWork.find((row) => row.candidate === OPENCODE_CANDIDATE)!.plannedAttempts;

    expect(estimate.estimable).toBe(true);
    expect(entry.maximumInputTokens).toBe(binding.maxInputTokens * attempts);
    // The sentence a person approves quotes the same number the ceiling is computed from.
    expect(entry.statement).toContain(`${binding.maxInputTokens}-token`);
    expect(worstCaseAttemptMicroUSD(binding))
      .toBe(attemptCostMicroUSD(binding, { inputTokens: binding.maxInputTokens, outputTokens: binding.maxOutputTokens }));
  });
});

describe('Pass 7 · the estimate is no longer below the workload that was actually observed', () => {
  /** The captured request, repeated once per planned attempt: the workload this cohort would run. */
  function observedWorkload(binding: ProviderBinding, attempts: number): { tokens: number; microUSD: number } {
    const perAttempt = attemptCostMicroUSD(binding, {
      inputTokens: OPENCODE_MEASURED_REQUEST_INPUT.totalInputTokens,
      outputTokens: OPENCODE_BIG_PICKLE_OBSERVED.tokens.output,
      reasoningTokens: OPENCODE_BIG_PICKLE_OBSERVED.tokens.reasoning,
    });
    return { tokens: OPENCODE_MEASURED_REQUEST_INPUT.totalInputTokens * attempts, microUSD: perAttempt * attempts };
  }

  it('bounds the observed input volume, in tokens and in dollars, at every repeat count', () => {
    for (const repeats of [1, 3, 10]) {
      const plan = planWith([openCodeCandidate()], repeats);
      const binding = bindingFor(plan, OPENCODE_CANDIDATE);
      const estimate = estimateSpending(plan.envelope, plan.plannedWork);
      const entry = estimate.perCandidate.find((row) => row.candidate === OPENCODE_CANDIDATE)!;
      const observed = observedWorkload(binding, entry.plannedAttempts);

      expect(entry.maximumInputTokens, `repeats=${repeats}`).toBeGreaterThanOrEqual(observed.tokens);
      expect(entry.maximumMicroUSD, `repeats=${repeats}`).toBeGreaterThanOrEqual(observed.microUSD);
      // And the per-attempt gate that actually stops a run bounds one observed attempt too.
      expect(worstCaseAttemptMicroUSD(binding), `repeats=${repeats}`)
        .toBeGreaterThanOrEqual(Math.ceil(observed.microUSD / entry.plannedAttempts));
    }
  });

  it('REGRESSION: the pre-correction budget would have failed that, so the test can tell the difference', () => {
    const plan = planWith([openCodeCandidate()], 3);
    const attempts = plan.plannedWork.find((row) => row.candidate === OPENCODE_CANDIDATE)!.plannedAttempts;
    const beforeCorrection = defaults().maxInputTokens * attempts;
    const observed = OPENCODE_MEASURED_REQUEST_INPUT.totalInputTokens * attempts;

    expect(beforeCorrection).toBeLessThan(observed);
    // 13.5x, which is the number the correction was sized against.
    expect(observed / beforeCorrection).toBeGreaterThan(13);
  });

  it('the spend tracker stops a run whose remaining worst case would breach the ceiling, at the new size', () => {
    const plan = planWith([openCodeCandidate()], 1);
    const binding = bindingFor(plan, OPENCODE_CANDIDATE);
    const estimate = estimateSpending(plan.envelope, plan.plannedWork);
    const worstCase = worstCaseAttemptMicroUSD(binding);
    const authorization = authorizeSpending(estimate, {
      campaignID: 'campaign:pass-7-budget',
      authorizedAt: '2026-09-20T19:00:00Z',
      authorizedBy: 'the test',
      // A ceiling that would have been generous under the OLD budget and is one attempt under the new one.
      hardCeilingMicroUSD: worstCase,
      operationalEnvelopeDigest: operationalEnvelopeDigest(plan.envelope),
    });
    const tracker = new SpendTracker(authorization, operationalEnvelopeDigest(plan.envelope));

    expect(() => tracker.check(binding, worstCase)).not.toThrow();
    tracker.record(worstCase, 'estimated');
    expect(() => tracker.check(binding, worstCase)).toThrow(SpendingError);
  });
});

describe('Pass 7 · cache-read can never make the estimate smaller than the input-rate estimate', () => {
  const binding = () => bindingFor(planWith([openCodeCandidate()]), OPENCODE_CANDIDATE);

  it('prices the total input, so adding the cached portion never lowers the figure', () => {
    const b = binding();
    const t = OPENCODE_BIG_PICKLE_OBSERVED.tokens;
    const freshOnly = attemptCostMicroUSD(b, { inputTokens: t.input });
    const wholeInput = attemptCostMicroUSD(b, { inputTokens: t.input + t.cacheRead + t.cacheWrite });

    expect(wholeInput).toBeGreaterThanOrEqual(freshOnly);
    // The schema carries ONE input rate and no cache tier, so the cached portion is charged at it —
    // which can overstate a charge and, by construction, can never understate one.
    expect(wholeInput).toBe(attemptCostMicroUSD(b, { inputTokens: OPENCODE_MEASURED_REQUEST_INPUT.totalInputTokens }));
    expect(b.pricing!.inputMicroUSDPerMillionTokens).toBeGreaterThan(0);
  });

  it('bounds the whole input side with the budget, cached tokens included', () => {
    const b = binding();
    const t = OPENCODE_BIG_PICKLE_OBSERVED.tokens;

    expect(b.maxInputTokens).toBeGreaterThanOrEqual(t.input + t.cacheRead + t.cacheWrite);
    expect(worstCaseAttemptMicroUSD(b))
      .toBeGreaterThanOrEqual(attemptCostMicroUSD(b, {
        inputTokens: t.input + t.cacheRead + t.cacheWrite, outputTokens: t.output, reasoningTokens: t.reasoning,
      }));
  });
});

describe('Pass 7 · no other provider\'s budget moved', () => {
  const others: ProviderID[] = ['claudeCLI', 'codexCLI', 'anthropicAPI', 'openaiAPI'];

  it('leaves a non-OpenCode campaign binding on the budget its suites imply', () => {
    const plan = buildCampaignPlan({
      label: LABEL,
      suiteIDs: SUITES,
      repeatsPerCase: 2,
      local: [],
      endpoint: 'http://127.0.0.1:11434',
      hardware: HARDWARE,
      runtimeVersion: 'test',
      frontier: [{
        name: 'anthropicAPI:claude-haiku-4-5', provider: 'anthropicAPI', modelID: 'claude-haiku-4-5',
        effort: 'none', thinkingMode: 'disabled', pricing: PRICES, authorizationMode: 'apiKeyEnvironment',
      }],
      provenModels: [{
        provider: 'anthropicAPI', modelID: 'claude-haiku-4-5', displayName: 'Haiku',
        availability: 'proven', verifiedModelID: 'claude-haiku-4-5',
        evidence: 'a fixture: the mock provider named it',
      }],
    } as never);
    const binding = bindingFor(plan, 'anthropicAPI:claude-haiku-4-5');
    const estimate = estimateSpending(plan.envelope, plan.plannedWork);
    const entry = estimate.perCandidate[0];

    expect(binding.maxInputTokens).toBe(defaults().maxInputTokens);
    expect(entry.maximumInputTokens).toBe(defaults().maxInputTokens * entry.plannedAttempts);
    expect(binding.maxInputTokens).toBeLessThan(OPENCODE_INJECTED_INPUT_TOKENS);
  });

  it('leaves every non-OpenCode SMOKE binding on 1,024', () => {
    for (const provider of others) {
      expect(smokeInputBudgetFor(provider), provider).toBe(SMOKE_MAX_INPUT_TOKENS);
      const binding = buildSmokeBinding({
        provider, modelID: 'a-model', effort: 'none',
        pricing: provider.endsWith('API') ? PRICES : undefined,
      });
      expect(binding.maxInputTokens, provider).toBe(SMOKE_MAX_INPUT_TOKENS);
    }
  });

  it('raises the OpenCode smoke budget, and its projected bound with it', () => {
    const binding = buildSmokeBinding({
      provider: 'opencodeCLI', modelID: OPENCODE_MODEL, effort: 'none', pricing: PRICES,
    });

    expect(binding.maxInputTokens).toBe(OPENCODE_SMOKE_MAX_INPUT_TOKENS);
    expect(binding.maxInputTokens).toBe(SMOKE_MAX_INPUT_TOKENS + OPENCODE_INJECTED_INPUT_TOKENS);
    expect(binding.maxInputTokens).toBeGreaterThan(OPENCODE_MEASURED_REQUEST_INPUT.totalInputTokens);
    expect(projectedMeteredBoundMicroUSD(binding)).toBe(
      Math.ceil((binding.maxInputTokens * PRICES.inputMicroUSDPerMillionTokens) / 1_000_000)
      + Math.ceil((SMOKE_MAX_OUTPUT_TOKENS * PRICES.outputMicroUSDPerMillionTokens) / 1_000_000));
  });

  it('refuses an OpenCode smoke whose ceiling was sized from the OLD budget', () => {
    const binding = buildSmokeBinding({
      provider: 'opencodeCLI', modelID: OPENCODE_MODEL, effort: 'none', pricing: PRICES,
    });
    const ceilingUnderTheOldBudget =
      Math.ceil((SMOKE_MAX_INPUT_TOKENS * PRICES.inputMicroUSDPerMillionTokens) / 1_000_000)
      + Math.ceil((SMOKE_MAX_OUTPUT_TOKENS * PRICES.outputMicroUSDPerMillionTokens) / 1_000_000);
    const decision = authorizeSmoke({
      bindings: [binding], ceilingMicroUSD: ceilingUnderTheOldBudget, unpricedAcknowledged: false,
    });

    expect(isSmokeAuthorizationRefusal(decision)).toBe(true);
    if (!isSmokeAuthorizationRefusal(decision)) return;
    expect(decision.code).toBe('projectedBoundExceedsCeiling');
    expect(decision.message).toContain('Nothing was sent');
  });
});

describe('Pass 7 · every spending authorization gate still holds at the new budget', () => {
  const plan = () => planWith([openCodeCandidate()], 2);

  it('refuses a metered request with no authorization at all, before any ceiling is consulted', () => {
    const built = plan();
    const tracker = new SpendTracker(undefined, operationalEnvelopeDigest(built.envelope));

    expect(() => tracker.check(bindingFor(built, OPENCODE_CANDIDATE), 1))
      .toThrow(/carries no recorded spending authorization/);
  });

  it('refuses an authorization recorded against different bindings', () => {
    const built = plan();
    const estimate = estimateSpending(built.envelope, built.plannedWork);
    const authorization = authorizeSpending(estimate, {
      campaignID: 'campaign:pass-7-budget', authorizedAt: '2026-09-20T19:00:00Z', authorizedBy: 'the test',
      hardCeilingMicroUSD: 50_000_000, operationalEnvelopeDigest: 'mlo1:a-different-envelope',
    });
    const tracker = new SpendTracker(authorization, operationalEnvelopeDigest(built.envelope));

    expect(() => tracker.check(bindingFor(built, OPENCODE_CANDIDATE), 1)).toThrow(/different set of provider bindings/);
  });

  it('still refuses a ceiling of zero, and an estimate that cannot be computed', () => {
    const built = plan();
    const estimate = estimateSpending(built.envelope, built.plannedWork);

    expect(() => authorizeSpending(estimate, {
      campaignID: 'c', authorizedAt: 'now', authorizedBy: 'the test',
      hardCeilingMicroUSD: 0, operationalEnvelopeDigest: operationalEnvelopeDigest(built.envelope),
    })).toThrow(/greater than zero/);

    // An estimate missing its quantity is a refusal, not a guess — the new budget did not soften it.
    const unplanned = estimateSpending(built.envelope, []);
    expect(unplanned.estimable).toBe(false);
    expect(() => authorizeSpending(unplanned, {
      campaignID: 'c', authorizedAt: 'now', authorizedBy: 'the test',
      hardCeilingMicroUSD: 1_000_000, operationalEnvelopeDigest: operationalEnvelopeDigest(built.envelope),
    })).toThrow(/cannot be calculated/);
  });

  it('still refuses an OpenCode candidate the admission record does not name', () => {
    expect(() => planWith([openCodeCandidate({
      name: 'opencodeCLI:opencode/mimo-v2.5-free', modelID: 'opencode/mimo-v2.5-free',
    })])).toThrow(/has not been proven callable/);
  });
});
