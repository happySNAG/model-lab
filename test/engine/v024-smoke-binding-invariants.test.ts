// Cernum · v0.2.4 — a preview and a record that describe the same request.
//
// THE DEFECT THIS FILE PINS, found by a dry-run audit on a MacBook Pro before any live request was
// sent. `cernum smoke` described each request twice and the two descriptions disagreed:
//
//   the PREVIEW  derived the billing basis from the provider registry, and printed, correctly,
//                `meteredAPI — billed per token against your own credential` for OpenCode.
//   the REQUEST  was built by a local helper that wrote `subscriptionCLI`, `subscriptionIncluded`
//                and `subscriptionCLISession` as LITERALS for every provider it was ever handed.
//
// So a live OpenCode smoke would have spent metered money and written a record saying the marginal
// API charge was $0 and a subscription covered it. Nothing caught it because the smoke path was the
// one binding-building path in this engine that never ran `validateBinding`.
//
// NOT ONE TEST HERE SENDS A REQUEST. Every assertion is about objects and refusals.

import { describe, expect, it } from 'vitest';
import {
  METERED_AUTHORIZATION_NOTE, SMOKE_MAX_INPUT_TOKENS, SMOKE_MAX_OUTPUT_TOKENS, UNPRICED_METERED_DISCLOSURE,
  authorizationClassOf, authorizeSmoke, buildSmokeBinding, isSmokeAuthorizationRefusal,
  projectedMeteredBoundMicroUSD,
} from '../../src/engine/smoke-binding';
import {
  PricingSnapshot, ProviderBinding, ProviderID, billingBasisOf, executionClassOf, isMetered, validateBinding,
} from '../../src/engine/provider';
import { providersWithExecutionAdapter } from '../../src/engine/host-factory';
import { readSmoke } from '../../src/engine/identity-smoke';
import { FrontierResponse } from '../../src/engine/frontier-adapter';

const PRICES: PricingSnapshot = {
  source: 'a fixture written by this test; never fetched from anyone and not a real price',
  capturedAt: '2026-09-17T00:00:00Z',
  currency: 'USD',
  inputMicroUSDPerMillionTokens: 3_000_000,
  outputMicroUSDPerMillionTokens: 15_000_000,
  reasoningMicroUSDPerMillionTokens: null,
};

const modelFor: Record<string, string> = {
  claudeCLI: 'claude-haiku-4-5',
  codexCLI: 'gpt-5.6-sol',
  opencodeCLI: 'opencode/union-alpha',
  anthropicAPI: 'claude-haiku-4-5',
  openaiAPI: 'gpt-5.6-sol',
};

function answered(binding: ProviderBinding, reportedModelID: string): FrontierResponse {
  return {
    answerText: 'ok',
    reportedModelID,
    usage: { inputTokens: 42, visibleOutputTokens: 7, reasoningTokens: 0 },
    usageProvenance: 'providerReported',
    totalElapsedMilliseconds: 240,
    firstVisibleTokenMilliseconds: 200,
    retryCount: 0,
    wastedTokens: 0,
    participatingModelIDs: reportedModelID.length > 0 ? [reportedModelID] : [],
  };
}

describe('v0.2.4 · every provider-determined field is derived, never written by hand', () => {
  it('matches the registry for every provider that can be smoke tested', () => {
    for (const provider of providersWithExecutionAdapter()) {
      const pricing = billingBasisOf(executionClassOf(provider)) === 'meteredAPI' ? PRICES : null;
      const binding = buildSmokeBinding({ provider, modelID: modelFor[provider], effort: 'none', pricing });

      expect(binding.executionClass, provider).toBe(executionClassOf(provider));
      expect(binding.billingBasis, provider).toBe(billingBasisOf(executionClassOf(provider)));
      // And the validator every manifest binding passes through accepts this one unchanged.
      expect(() => validateBinding(binding), provider).not.toThrow();
    }
  });

  it('records OpenCode as meteredAPI — never as a subscription, at any effort level', () => {
    for (const effort of ['none', 'low', 'high', 'max'] as const) {
      const binding = buildSmokeBinding({ provider: 'opencodeCLI', modelID: modelFor.opencodeCLI, effort });
      expect(binding.billingBasis).toBe('meteredAPI');
      expect(binding.billingBasis).not.toBe('subscriptionIncluded');
      expect(binding.executionClass).toBe('meteredAPI');
      // Cernum never holds this credential and cannot say where it lives.
      expect(binding.authorizationMode).toBe('toolManagedCredential');
      expect(isMetered(binding)).toBe(true);
    }
  });

  it('gives a subscription CLI the session authorization and no pricing', () => {
    const binding = buildSmokeBinding({ provider: 'claudeCLI', modelID: modelFor.claudeCLI, effort: 'none' });
    expect(binding.billingBasis).toBe('subscriptionIncluded');
    expect(binding.authorizationMode).toBe('subscriptionCLISession');
    expect(binding.pricing).toBeNull();
  });

  it('refuses to hang a per-token price on something not billed per token', () => {
    expect(() => buildSmokeBinding({ provider: 'claudeCLI', modelID: modelFor.claudeCLI, effort: 'none', pricing: PRICES }))
      .toThrow(/not billed per token/);
  });

  it('starts every binding at unverifiable with an empty returned identifier', () => {
    for (const provider of providersWithExecutionAdapter()) {
      const pricing = billingBasisOf(executionClassOf(provider)) === 'meteredAPI' ? PRICES : null;
      const binding = buildSmokeBinding({ provider, modelID: modelFor[provider], effort: 'none', pricing });
      expect(binding.identityState, provider).toBe('unverifiable');
      expect(binding.verifiedModelID, provider).toBe('');
      // And no retry, ever: a retried smoke buys a second opinion about the same question.
      expect(binding.retry.maxRetries, provider).toBe(0);
    }
  });
});

describe('v0.2.4 · the preview and the record cannot disagree, because there is one object', () => {
  it('reads the same billing basis into the disclosure and into the recorded result', () => {
    for (const provider of providersWithExecutionAdapter()) {
      const pricing = billingBasisOf(executionClassOf(provider)) === 'meteredAPI' ? PRICES : null;
      const binding = buildSmokeBinding({ provider, modelID: modelFor[provider], effort: 'none', pricing });
      // What the preview prints, in the exact form the command prints it.
      const preview = authorizationClassOf(binding);
      // What the live record says, having gone all the way through a response.
      const result = readSmoke(binding, answered(binding, modelFor[provider]), '2026-09-17T12:00:00Z');

      expect(result.billingBasis, provider).toBe(binding.billingBasis);
      expect(result.executionClass, provider).toBe(binding.executionClass);
      expect(result.authorizationMode, provider).toBe(binding.authorizationMode);
      expect(preview.startsWith(binding.billingBasis), `${provider}: ${preview}`).toBe(true);
    }
  });

  it('THE REGRESSION ITSELF: a live OpenCode record never claims a $0 subscription charge', () => {
    const binding = buildSmokeBinding({ provider: 'opencodeCLI', modelID: modelFor.opencodeCLI, effort: 'none' });
    const result = readSmoke(binding, answered(binding, modelFor.opencodeCLI), '2026-09-17T12:00:00Z');

    expect(result.billingBasis).toBe('meteredAPI');
    // Not zero. Not free. Unavailable, with a reason a person can act on.
    expect(result.marginalAPIChargeMicroUSD.provenance).toBe('unavailable');
    expect(result.marginalAPIChargeMicroUSD.value).toBeUndefined();
    expect(result.marginalAPIChargeMicroUSD.note).toMatch(/not zero/);
    expect(result.effectiveUserCostMicroUSD.provenance).toBe('unavailable');
    // And it does not report a plan allowance for a thing that has no plan.
    expect(result.subscriptionIncludedUsageMicroUSD.provenance).toBe('unavailable');
    expect(result.subscriptionIncludedUsageMicroUSD.note).toMatch(/billed per token/);
  });

  it('prices a metered request only where prices were supplied, and labels the result estimated', () => {
    const binding = buildSmokeBinding({ provider: 'opencodeCLI', modelID: modelFor.opencodeCLI, effort: 'none', pricing: PRICES });
    const result = readSmoke(binding, answered(binding, modelFor.opencodeCLI), '2026-09-17T12:00:00Z');

    // 42 input tokens at 3,000,000 microUSD/M = 126 microUSD; 7 output at 15,000,000/M = 105.
    // Derived from a published rate and labelled as derived — it is not the figure on a bill.
    expect(result.marginalAPIChargeMicroUSD.provenance).toBe('estimated');
    expect(result.marginalAPIChargeMicroUSD.value).toBe(126 + 105);
    expect(result.pricingSource).toContain('never fetched from anyone');
  });

  it('keeps a subscription record honest in the other direction', () => {
    const binding = buildSmokeBinding({ provider: 'claudeCLI', modelID: modelFor.claudeCLI, effort: 'none' });
    const result = readSmoke(binding, answered(binding, modelFor.claudeCLI), '2026-09-17T12:00:00Z');

    expect(result.marginalAPIChargeMicroUSD.value).toBe(0);
    // Zero at the margin and NOT free: what it costs the person is not derivable from the request.
    expect(result.effectiveUserCostMicroUSD.provenance).toBe('unavailable');
  });
});

describe('v0.2.4 · a metered smoke is refused unless it was authorized by name', () => {
  const unpriced = () => [buildSmokeBinding({ provider: 'opencodeCLI', modelID: modelFor.opencodeCLI, effort: 'none' })];
  const priced = () => [buildSmokeBinding({ provider: 'opencodeCLI', modelID: modelFor.opencodeCLI, effort: 'none', pricing: PRICES })];

  it('refuses an unpriced metered run with no acknowledgement, and says what is unknown', () => {
    const decision = authorizeSmoke({ bindings: unpriced(), unpricedAcknowledged: false });
    expect(isSmokeAuthorizationRefusal(decision)).toBe(true);
    if (!isSmokeAuthorizationRefusal(decision)) return;
    expect(decision.code).toBe('unpricedNeedsAcknowledgement');
    expect(decision.message).toContain('MAY BILL YOU');
    expect(decision.message).toContain('UNAVAILABLE');
    expect(decision.message).toContain('Nothing was sent');
  });

  it('refuses a priced metered run with no ceiling, and shows the worst case it would be checked against', () => {
    const decision = authorizeSmoke({ bindings: priced(), unpricedAcknowledged: false });
    expect(isSmokeAuthorizationRefusal(decision)).toBe(true);
    if (!isSmokeAuthorizationRefusal(decision)) return;
    expect(decision.code).toBe('meteredNeedsCeiling');
    expect(decision.message).toContain('--authorize-metered');
    expect(decision.message).toContain('worst case');
  });

  it('refuses when the projected bound exceeds the ceiling, rather than truncating the scope', () => {
    const bindings = priced();
    const bound = projectedMeteredBoundMicroUSD(bindings[0])!;
    const decision = authorizeSmoke({ bindings, ceilingMicroUSD: bound - 1, unpricedAcknowledged: false });
    expect(isSmokeAuthorizationRefusal(decision)).toBe(true);
    if (!isSmokeAuthorizationRefusal(decision)) return;
    expect(decision.code).toBe('projectedBoundExceedsCeiling');
  });

  it('authorises a priced run inside its ceiling, and records the bound it checked', () => {
    const bindings = priced();
    const bound = projectedMeteredBoundMicroUSD(bindings[0])!;
    const decision = authorizeSmoke({ bindings, ceilingMicroUSD: bound, unpricedAcknowledged: false });
    expect(isSmokeAuthorizationRefusal(decision)).toBe(false);
    if (isSmokeAuthorizationRefusal(decision)) return;
    expect(decision.kind).toBe('pricedCeiling');
    expect(decision.projectedBoundMicroUSD).toBe(bound);
    expect(decision.ceilingMicroUSD).toBe(bound);
    expect(decision.requestCount).toBe(1);
    // A bound that was checked, said to be a bound and not a receipt.
    expect(decision.statement).toContain('not a receipt');
  });

  it('computes the bound from the frozen budgets, so a reader can reproduce it', () => {
    const bound = projectedMeteredBoundMicroUSD(priced()[0])!;
    const expected = Math.ceil((SMOKE_MAX_INPUT_TOKENS * PRICES.inputMicroUSDPerMillionTokens) / 1_000_000)
      + Math.ceil((SMOKE_MAX_OUTPUT_TOKENS * PRICES.outputMicroUSDPerMillionTokens) / 1_000_000);
    expect(bound).toBe(expected);
  });

  it('refuses a ceiling on an unpriced candidate: there would be nothing to check it against', () => {
    const decision = authorizeSmoke({ bindings: unpriced(), ceilingMicroUSD: 1_000_000, unpricedAcknowledged: false });
    expect(isSmokeAuthorizationRefusal(decision)).toBe(true);
    if (!isSmokeAuthorizationRefusal(decision)) return;
    expect(decision.code).toBe('unpricedCeilingIsNotABound');
  });

  it('holds an acknowledged unpriced run to EXACTLY one request', () => {
    const two = [
      buildSmokeBinding({ provider: 'opencodeCLI', modelID: modelFor.opencodeCLI, effort: 'none' }),
      buildSmokeBinding({ provider: 'opencodeCLI', modelID: modelFor.opencodeCLI, effort: 'high' }),
    ];
    const decision = authorizeSmoke({ bindings: two, unpricedAcknowledged: true });
    expect(isSmokeAuthorizationRefusal(decision)).toBe(true);
    if (!isSmokeAuthorizationRefusal(decision)) return;
    expect(decision.code).toBe('unpricedNeedsOneAttemptScope');
    expect(decision.message).toContain('EXACTLY ONE');
  });

  it('authorises exactly one acknowledged unpriced request, and records the unknown honestly', () => {
    const decision = authorizeSmoke({ bindings: unpriced(), unpricedAcknowledged: true });
    expect(isSmokeAuthorizationRefusal(decision)).toBe(false);
    if (isSmokeAuthorizationRefusal(decision)) return;
    expect(decision.kind).toBe('unpricedAcknowledged');
    expect(decision.requestCount).toBe(1);
    expect(decision.ceilingMicroUSD).toBeUndefined();
    expect(decision.projectedBoundMicroUSD).toBeUndefined();
    expect(decision.statement).toContain('UNAVAILABLE');
    // Never silently interpreted as zero — not in the authorization, and not anywhere it is rendered.
    expect(JSON.stringify(decision)).not.toMatch(/"(ceiling|projectedBound)MicroUSD":\s*0/);
  });

  it('needs no spending authorization for a subscription, and still refuses to call it free', () => {
    const bindings = [buildSmokeBinding({ provider: 'claudeCLI', modelID: modelFor.claudeCLI, effort: 'none' })];
    const decision = authorizeSmoke({ bindings, unpricedAcknowledged: false });
    expect(isSmokeAuthorizationRefusal(decision)).toBe(false);
    if (isSmokeAuthorizationRefusal(decision)) return;
    expect(decision.kind).toBe('notRequired');
    expect(decision.statement).toContain('rather than called free');
  });

  it('states the two disclosures in one place, so no surface can soften one', () => {
    expect(UNPRICED_METERED_DISCLOSURE).toContain('not zero, not free, and not estimated');
    expect(METERED_AUTHORIZATION_NOTE).toContain('exactly one request');
  });
});
