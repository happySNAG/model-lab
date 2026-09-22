// Pass 7 · the project cost policy: who may be EXECUTED, and who only priced.
//
// The policy set on 2026-09-20 authorizes free_confirmed, subscription_included and local, and
// blocks metered and unknown_cost unless explicitly overridden in writing. These tests hold the two
// halves of that apart: classification (what a candidate IS) and enforcement (where it is stopped).

import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AUTHORIZED_COST_ELIGIBILITIES, BLOCKED_COST_ELIGIBILITIES, COST_ELIGIBILITIES, CostPolicyError,
  CostPolicyOverride, ZeroMarginalCostConfirmation, costEligibilityAgreesWithBillingBasis,
  costEligibilityFor, isAuthorizedCostEligibility, validateZeroMarginalCostConfirmation,
} from '../../src/engine/cost-eligibility';
import type { AttemptAuthorization } from '../../src/engine/campaign';
import { buildCampaignPlan } from '../../src/engine/campaign-builder';
import { billingBasisOf, executionClassOf } from '../../src/engine/provider';
import type { CampaignConfiguration } from '../../src/engine/campaign';
import { buildHostForCampaign } from '../../src/engine/host-factory';
import { SYNTHETIC_HARDWARE } from '../../src/engine/synthetic';
import {
  SUITES, TEST_PRICING, candidatesFor, envelopeOf, localBinding, meteredBinding, routingHost,
  subscriptionBinding,
} from './frontier-harness';

const CONFIRMATION: ZeroMarginalCostConfirmation = {
  provider: 'opencodeCLI',
  modelID: 'opencode/big-pickle',
  accountBasis: 'OpenCode Zen account seth@example, credential held by the opencode CLI',
  observedBillingRecord: 'OpenCode Zen account usage export for 2026-09-01..2026-09-20, all rows $0.00',
  observedAt: '2026-09-20T22:00:00Z',
  confirmedBy: 'Seth Leopold',
};

const OVERRIDE: CostPolicyOverride = {
  provider: 'opencodeCLI',
  modelID: 'opencode/big-pickle',
  overrides: 'metered',
  authorizedBy: 'Seth Leopold',
  authorizedAt: '2026-09-20T22:00:00Z',
  reason: 'one-off, budget accepted in writing',
};

describe('Pass 7 · the five states, and which of them may run', () => {
  it('names exactly five states and authorizes exactly three', () => {
    expect(COST_ELIGIBILITIES).toEqual(
      ['free_confirmed', 'subscription_included', 'local', 'metered', 'unknown_cost']);
    expect(AUTHORIZED_COST_ELIGIBILITIES).toEqual(['free_confirmed', 'subscription_included', 'local']);
    expect(BLOCKED_COST_ELIGIBILITIES).toEqual(['metered', 'unknown_cost']);
    // No state is both, and none is neither: the two lists partition the union.
    expect([...AUTHORIZED_COST_ELIGIBILITIES, ...BLOCKED_COST_ELIGIBILITIES].sort())
      .toEqual([...COST_ELIGIBILITIES].sort());
    for (const state of AUTHORIZED_COST_ELIGIBILITIES) expect(isAuthorizedCostEligibility(state)).toBe(true);
    for (const state of BLOCKED_COST_ELIGIBILITIES) expect(isAuthorizedCostEligibility(state)).toBe(false);
  });

  it('classifies a local runtime as local, and authorizes it', () => {
    const verdict = costEligibilityFor({ provider: 'ollama', modelID: 'llama3.2:3b' });
    expect(verdict.eligibility).toBe('local');
    expect(verdict.authorized).toBe(true);
  });

  it('classifies both subscription CLIs as subscription_included, and says it is not free', () => {
    for (const provider of ['claudeCLI', 'codexCLI'] as const) {
      const verdict = costEligibilityFor({ provider, modelID: 'whatever' });
      expect(verdict.eligibility).toBe('subscription_included');
      expect(verdict.authorized).toBe(true);
      // The distinction the policy turns on: $0 marginal charge, finite allowance.
      expect(verdict.reason).toMatch(/NOT free|finite/);
    }
  });

  it('classifies every metered provider as metered, and BLOCKS it', () => {
    for (const provider of ['opencodeCLI', 'anthropicAPI', 'openaiAPI'] as const) {
      const verdict = costEligibilityFor({ provider, modelID: 'm' });
      expect(verdict.eligibility).toBe('metered');
      expect(verdict.authorized).toBe(false);
    }
  });

  it('says in the refusal that a published $0 is not a confirmation', () => {
    const verdict = costEligibilityFor({ provider: 'opencodeCLI', modelID: 'opencode/big-pickle' });
    expect(verdict.reason).toMatch(/published \$0 catalogue price is NOT such a confirmation/);
  });
});

describe('Pass 7 · free_confirmed has to be earned, and a price list cannot earn it', () => {
  it('rescues a metered candidate when a confirmation names that exact configuration', () => {
    const verdict = costEligibilityFor({
      provider: 'opencodeCLI', modelID: 'opencode/big-pickle', confirmations: [CONFIRMATION],
    });
    expect(verdict.eligibility).toBe('free_confirmed');
    expect(verdict.authorized).toBe(true);
    // The account, the record and the person are all carried into the reason a reader sees.
    expect(verdict.reason).toContain('Seth Leopold');
    expect(verdict.reason).toContain('usage export');
  });

  it('is per configuration: a confirmation for one model does not free another', () => {
    const verdict = costEligibilityFor({
      provider: 'opencodeCLI', modelID: 'opencode/mimo-v2.5-free', confirmations: [CONFIRMATION],
    });
    expect(verdict.eligibility).toBe('metered');
    expect(verdict.authorized).toBe(false);
  });

  it('REFUSES a published price wearing an observation\'s name', () => {
    // The honest mistake this exists to catch: pasting Cernum's own pricing provenance string into
    // the field that is supposed to hold the opposite kind of evidence.
    for (const tell of [
      'PUBLISHED LIST PRICE (not an observed charge) · OpenCode Zen model catalogue',
      'read from ~/.cache/opencode/models.json',
      'the catalogue price for this model is $0',
      'https://opencode.ai/docs.zen',
    ]) {
      expect(() => validateZeroMarginalCostConfirmation({ ...CONFIRMATION, observedBillingRecord: tell }))
        .toThrow(CostPolicyError);
      expect(() => validateZeroMarginalCostConfirmation({ ...CONFIRMATION, observedBillingRecord: tell }))
        .toThrow(/PUBLISHED PRICE and not an observed charge/);
    }
  });

  it('REFUSES a confirmation missing any of its provenance', () => {
    for (const field of ['modelID', 'accountBasis', 'observedBillingRecord', 'observedAt', 'confirmedBy'] as const) {
      expect(() => validateZeroMarginalCostConfirmation({ ...CONFIRMATION, [field]: '  ' }))
        .toThrow(/must carry/);
    }
  });

  it('REFUSES a confirmation on a provider that is not metered, because it claims nothing', () => {
    expect(() => validateZeroMarginalCostConfirmation({ ...CONFIRMATION, provider: 'claudeCLI' }))
      .toThrow(/not a metered provider/);
  });

  it('validates the confirmation at classification time, not only where it was written', () => {
    const laundered = { ...CONFIRMATION, observedBillingRecord: 'published list price, $0' };
    expect(() => costEligibilityFor({
      provider: 'opencodeCLI', modelID: 'opencode/big-pickle', confirmations: [laundered],
    })).toThrow(CostPolicyError);
  });
});

describe('Pass 7 · an override is explicit, written, and narrow', () => {
  it('permits the exact configuration it names, and records who said so', () => {
    const verdict = costEligibilityFor({
      provider: 'opencodeCLI', modelID: 'opencode/big-pickle', overrides: [OVERRIDE],
    });
    // STILL `metered`. An override permits execution; it does not relabel who pays.
    expect(verdict.eligibility).toBe('metered');
    expect(verdict.authorized).toBe(true);
    expect(verdict.overriddenBy?.authorizedBy).toBe('Seth Leopold');
  });

  it('does not cover another model, another provider, or the other blocked state', () => {
    const cases: CostPolicyOverride[] = [
      { ...OVERRIDE, modelID: 'opencode/mimo-v2.5-free' },
      { ...OVERRIDE, provider: 'anthropicAPI' },
      { ...OVERRIDE, overrides: 'unknown_cost' },
    ];
    for (const override of cases) {
      const verdict = costEligibilityFor({
        provider: 'opencodeCLI', modelID: 'opencode/big-pickle', overrides: [override],
      });
      expect(verdict.authorized).toBe(false);
    }
  });

  it('is refused when it is unsigned or gives no reason', () => {
    for (const broken of [{ ...OVERRIDE, authorizedBy: ' ' }, { ...OVERRIDE, reason: '' }]) {
      expect(costEligibilityFor({
        provider: 'opencodeCLI', modelID: 'opencode/big-pickle', overrides: [broken],
      }).authorized).toBe(false);
    }
  });
});

describe('Pass 7 · eligibility and billing basis describe the same candidate', () => {
  it('agrees with the structural billing basis for every provider', () => {
    for (const provider of ['ollama', 'claudeCLI', 'codexCLI', 'opencodeCLI', 'anthropicAPI', 'openaiAPI'] as const) {
      const verdict = costEligibilityFor({ provider, modelID: 'm' });
      const basis = billingBasisOf(executionClassOf(provider));
      expect(costEligibilityAgreesWithBillingBasis(verdict.eligibility, basis)).toBe(true);
    }
  });

  it('allows free_confirmed only on a metered basis, and never lets local drift onto one', () => {
    expect(costEligibilityAgreesWithBillingBasis('free_confirmed', 'meteredAPI')).toBe(true);
    expect(costEligibilityAgreesWithBillingBasis('free_confirmed', 'local')).toBe(false);
    expect(costEligibilityAgreesWithBillingBasis('local', 'meteredAPI')).toBe(false);
    expect(costEligibilityAgreesWithBillingBasis('subscription_included', 'meteredAPI')).toBe(false);
  });
});

describe('Pass 7 · a blocked cohort can still be planned and priced, which is the point', () => {
  const planRequest = () => ({
    label: 'cost-policy-preview',
    suiteIDs: SUITES,
    repeatsPerCase: 1,
    local: [],
    frontier: [{
      name: 'anthropicAPI:some-model', provider: 'anthropicAPI' as const, modelID: 'some-model',
      effort: 'none' as const, thinkingMode: 'disabled' as const, pricing: TEST_PRICING,
      authorizationMode: 'apiKeyEnvironment' as const,
    }],
    endpoint: 'http://127.0.0.1:11434',
    hardware: { machineID: 'm', platform: 'darwin', arch: 'x64', cpuModel: 'test', cpuCount: 8, totalMemoryBytes: 1 },
    runtimeVersion: 'test',
    provenModels: [{
      provider: 'anthropicAPI' as const, modelID: 'some-model', availability: 'proven' as const,
      verifiedModelID: 'some-model', efforts: ['none'], evidence: 'test', observedAt: '2026-09-20T00:00:00Z',
    }],
  });

  it('BUILDS and prices a metered candidate rather than refusing it at plan time', () => {
    // The refusal belongs at the execution boundary. A cohort you may not run is still one you must
    // be able to cost — that price is how somebody decides whether to seek an exception for it.
    const built = buildCampaignPlan(planRequest() as never);
    expect(built.plannedWork.length).toBe(1);
    expect(built.plannedWork[0].plannedAttempts).toBeGreaterThan(0);
  });

  it('carries the verdict out on the plan, so a surface can disclose it without re-deriving it', () => {
    const built = buildCampaignPlan(planRequest() as never);
    expect(built.costEligibility).toEqual([{
      candidate: 'anthropicAPI:some-model',
      verdict: expect.objectContaining({ eligibility: 'metered', authorized: false }),
    }]);
  });
});

/** Narrow the authorization union to its refusal branch, so the refusal's fields are readable. */
const refusalOf = (verdict: AttemptAuthorization) => {
  if (verdict.allowed) throw new Error('expected a refusal, and the attempt was authorized');
  return verdict;
};

const slotFor = (envelope: ReturnType<typeof envelopeOf>, candidate: string) => ({
  candidate,
  caseID: [...candidatesFor(envelope)].length > 0 ? 'case.foundation.1' : 'case.foundation.1',
  attempt: 1,
});

describe('Pass 7 · the refusal lands where a request would leave', () => {
  it('BLOCKS a metered attempt before anything is sent, and says why', async () => {
    const envelope = envelopeOf(meteredBinding('anthropicAPI:some-model', 'anthropicAPI'));
    const { host } = routingHost({ envelope, costPolicy: {} });

    const verdict = refusalOf(await host.authorizeAttempt(slotFor(envelope, 'anthropicAPI:some-model') as never));

    expect(verdict.code).toBe('costPolicy.metered');
    expect(verdict.reason).toMatch(/Nothing was sent/);
    expect(verdict.reason).toMatch(/free_confirmed, subscription_included, local/);
  });

  it('ALLOWS a subscription attempt and a local one', async () => {
    const envelope = envelopeOf(subscriptionBinding('claudeCLI:claude-opus-5'), localBinding('llama3.2:3b'));
    const { host } = routingHost({ envelope, costPolicy: {} });

    for (const candidate of ['claudeCLI:claude-opus-5', 'llama3.2:3b']) {
      expect((await host.authorizeAttempt(slotFor(envelope, candidate) as never)).allowed).toBe(true);
    }
  });

  it('lets a confirmed candidate PAST the cost gate, and still leaves it to the spending gate', async () => {
    // THE TWO GATES ARE INDEPENDENT, AND BOTH MUST PASS. `free_confirmed` is a claim about who pays;
    // the binding is still structurally metered, so `SpendTracker` still governs it and a campaign
    // with no recorded authorization still sends nothing. That is the conservative direction, and it
    // is worth stating as a test because the tempting simplification — "confirmed free, therefore
    // skip the ceiling" — would remove the only gate that survives a wrong confirmation.
    const envelope = envelopeOf(meteredBinding('opencodeCLI:opencode/big-pickle', 'opencodeCLI'));
    const { host } = routingHost({ envelope, costPolicy: { confirmations: [CONFIRMATION] } });

    const verdict = refusalOf(await host.authorizeAttempt(slotFor(envelope, 'opencodeCLI:opencode/big-pickle') as never));

    // Refused by SPENDING, not by the cost policy: the cost gate was cleared.
    expect(verdict.code).toMatch(/^spending\./);
    expect(verdict.code).not.toMatch(/^costPolicy\./);
  });

  it('leaves a host that did not opt in behaving exactly as before', async () => {
    // Back-compat, stated as a test: a frozen campaign resumed by an older surface must not change
    // what it does because a policy was added to the engine after it was frozen.
    const envelope = envelopeOf(meteredBinding('anthropicAPI:some-model', 'anthropicAPI'));
    const { host } = routingHost({ envelope });

    const verdict = refusalOf(await host.authorizeAttempt(slotFor(envelope, 'anthropicAPI:some-model') as never));
    // Refused by the SPENDING gate, not the cost policy — which is the pre-existing behaviour.
    expect(verdict.code).toMatch(/^spending\./);
  });
});


describe('Pass 7 · this is an execution gate and NEVER a scoring input', () => {
  // The instruction that came with the policy, enforced rather than promised: quality is what it is
  // regardless of who paid for the request that measured it. A cost rule that quietly reweighted a
  // ranking would be the worst kind of bias — invisible, well-meant, and baked into the numbers.
  const SCORING_MODULES = ['scoring.ts', 'ranking.ts', 'retention.ts'];

  it('is not imported by any scoring, ranking or retention module', () => {
    for (const file of SCORING_MODULES) {
      const source = fs.readFileSync(path.join('src', 'engine', file), 'utf8');
      expect(source).not.toMatch(/cost-eligibility/);
      expect(source).not.toMatch(/costEligibility|CostEligibility/);
    }
  });

  it('does not read a score, a rank or a verdict itself', () => {
    const source = fs.readFileSync(path.join('src', 'engine', 'cost-eligibility.ts'), 'utf8');
    for (const forbidden of ['./scoring', './ranking', './retention', './adjudication']) {
      expect(source).not.toContain(`from '${forbidden}'`);
    }
  });
});


describe('Pass 7 · the policy reaches the host from the CAMPAIGN, not from the invocation', () => {
  // THE GAP THIS CLOSES. `cost-eligibility.ts` existed, `RoutingHost` enforced it, and nothing ever
  // passed it: `buildHostForCampaign` never set `costPolicy`, so the gate was unreachable from
  // either surface and the policy was, in practice, inert. These tests are about the WIRING — that
  // the opt-in travels from the frozen configuration to the host, and that a campaign frozen before
  // the policy existed still resumes under the rules it was created under.

  function configurationWith(costPolicy: CampaignConfiguration['costPolicy']): CampaignConfiguration {
    return {
      label: 'wiring', suiteIDs: ['suite.model-lab.foundation'], repeatsPerCase: 1,
      candidates: [], hardware: SYNTHETIC_HARDWARE, runtimeVersion: 'test',
      operationalEnvelope: envelopeOf(meteredBinding('anthropicAPI:some-model', 'anthropicAPI')),
      costPolicy,
    };
  }

  it('ENFORCES the policy when the frozen configuration carries it', async () => {
    const configuration = configurationWith({});
    const { host } = buildHostForCampaign(configuration, { endpoint: 'http://127.0.0.1:11434' });
    const envelope = configuration.operationalEnvelope!;

    expect(host.authorizeAttempt).toBeDefined();
    const verdict = await host.authorizeAttempt!(slotFor(envelope, 'anthropicAPI:some-model') as never);

    expect(verdict.allowed).toBe(false);
    // The COST gate refused it, before the spending gate got the chance. An unauthorized-by-cost
    // candidate must not depend on there happening to be no spending authorization as well.
    expect(refusalOf(verdict).code).toBe('costPolicy.metered');
  });

  it('leaves a configuration frozen BEFORE the policy existed exactly as it was', async () => {
    // A campaign on disk with no `costPolicy` key. Resuming it must not start refusing attempts its
    // first half ran — a frozen campaign whose second half obeys different rules is not the campaign
    // that was authorised.
    const configuration = configurationWith(undefined);
    const { host } = buildHostForCampaign(configuration, { endpoint: 'http://127.0.0.1:11434' });
    const envelope = configuration.operationalEnvelope!;

    const verdict = refusalOf(await host.authorizeAttempt!(slotFor(envelope, 'anthropicAPI:some-model') as never));

    expect(verdict.code).toMatch(/^spending\./);
    expect(verdict.code).not.toMatch(/^costPolicy\./);
  });

  it('carries a written override through the configuration to the gate', async () => {
    const override = {
      provider: 'anthropicAPI' as const, modelID: 'some-model', overrides: 'metered' as const,
      authorizedBy: 'the operator', authorizedAt: '2026-09-20T00:00:00Z',
      reason: 'explicitly authorized in writing for this campaign',
    };
    const configuration = configurationWith({ overrides: [override] });
    const { host } = buildHostForCampaign(configuration, { endpoint: 'http://127.0.0.1:11434' });
    const envelope = configuration.operationalEnvelope!;

    const verdict = refusalOf(await host.authorizeAttempt!(slotFor(envelope, 'anthropicAPI:some-model') as never));

    // Past the cost gate on the override; still held by the spending gate, which the override does
    // not speak to. Two gates, both of which must pass.
    expect(verdict.code).toMatch(/^spending\./);
  });
});
