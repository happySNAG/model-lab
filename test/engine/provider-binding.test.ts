// The frozen operational envelope: what it refuses, and why its digest has to be deterministic.

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RETRY, MIXED_EXECUTION_REASONS, ProviderBindingError, billingBasisOf, billingLabel,
  bindingFor, buildOperationalEnvelope, describeBinding, executionClassOf, isFrontier, isLocal,
  isMetered, localOllamaBinding, operationalEnvelopeDigest, pricingFor, validateBinding,
} from '../../src/engine/provider';
import { localBinding, meteredBinding, subscriptionBinding, TEST_PRICING } from './frontier-harness';

describe('an execution class is a property of the provider, not a choice', () => {
  it('fixes the class and the billing basis from the provider alone', () => {
    expect(executionClassOf('ollama')).toBe('localRuntime');
    expect(executionClassOf('claudeCLI')).toBe('subscriptionCLI');
    expect(executionClassOf('codexCLI')).toBe('subscriptionCLI');
    expect(executionClassOf('anthropicAPI')).toBe('meteredAPI');
    expect(executionClassOf('openaiAPI')).toBe('meteredAPI');
    expect(billingBasisOf('localRuntime')).toBe('local');
    expect(billingBasisOf('subscriptionCLI')).toBe('subscriptionIncluded');
    expect(billingBasisOf('meteredAPI')).toBe('meteredAPI');
  });

  it('refuses a binding that claims a class its provider is not reached through', () => {
    const binding = { ...subscriptionBinding('claudeCLI:x'), executionClass: 'meteredAPI' as const };
    expect(() => validateBinding(binding)).toThrow(ProviderBindingError);
  });

  it('refuses a billing basis that does not follow from the class', () => {
    const binding = { ...subscriptionBinding('claudeCLI:x'), billingBasis: 'local' as const };
    expect(() => validateBinding(binding)).toThrow(/billed as subscriptionIncluded/);
  });
});

describe('a metered binding must be priceable, and an unmetered one must not carry a price', () => {
  it('refuses a metered binding with no pricing snapshot', () => {
    expect(() => validateBinding({ ...meteredBinding('anthropicAPI:m'), pricing: null }))
      .toThrow(/refuses a paid run it cannot price rather than guessing/);
  });

  it('refuses a per-token price on execution that is not billed per token', () => {
    expect(() => validateBinding({ ...subscriptionBinding('claudeCLI:x'), pricing: TEST_PRICING }))
      .toThrow(/a number that looks like a cost and is not one/);
  });

  it('refuses a local binding that carries an authorization mode it has no credential for', () => {
    expect(() => validateBinding({ ...localBinding('alpha:1b'), authorizationMode: 'apiKeyEnvironment' }))
      .toThrow(/needs no authorization mode/);
  });

  it('refuses a metered binding that does not say where its key comes from', () => {
    expect(() => validateBinding({ ...meteredBinding('anthropicAPI:m'), authorizationMode: 'none' }))
      .toThrow(/must name where its key comes from/);
  });
});

describe('a verified identity has to name something', () => {
  it('refuses to call an identity verified when no identifier was returned', () => {
    expect(() => validateBinding({ ...subscriptionBinding('claudeCLI:x'), identityState: 'verified', verifiedModelID: '' }))
      .toThrow(/An identity nobody can name is not verified/);
  });

  it('records a local model with no weights digest as unverifiable rather than verified', () => {
    const binding = localOllamaBinding({
      candidate: 'alpha:1b', modelID: 'alpha:1b', runtimeDigest: '',
      thinkingMode: 'disabled', maxInputTokens: 10, maxOutputTokens: 10, timeoutMilliseconds: 10,
    });
    expect(binding.identityState).toBe('unverifiable');
    expect(binding.verifiedModelID).toBe('');
    expect(binding.identityEvidence).toMatch(/reported no weights digest/);
  });
});

describe('the envelope', () => {
  it('is deterministic: the same bindings always digest to the same value', () => {
    const a = buildOperationalEnvelope([localBinding('alpha:1b'), subscriptionBinding('claudeCLI:sonnet')]);
    const b = buildOperationalEnvelope([localBinding('alpha:1b'), subscriptionBinding('claudeCLI:sonnet')]);
    expect(operationalEnvelopeDigest(a)).toBe(operationalEnvelopeDigest(b));
  });

  it('digests differently when any frozen setting moves', () => {
    const base = buildOperationalEnvelope([subscriptionBinding('claudeCLI:sonnet')]);
    const effort = buildOperationalEnvelope([subscriptionBinding('claudeCLI:sonnet', 'claudeCLI', { effort: 'high' })]);
    const budget = buildOperationalEnvelope([subscriptionBinding('claudeCLI:sonnet', 'claudeCLI', { maxOutputTokens: 4096 })]);
    const retry = buildOperationalEnvelope([subscriptionBinding('claudeCLI:sonnet', 'claudeCLI', { retry: DEFAULT_RETRY })]);
    const digests = [base, effort, budget, retry].map(operationalEnvelopeDigest);
    expect(new Set(digests).size).toBe(4);
  });

  it('is ORDER-sensitive, because candidate order is bound and thermal state is not reset', () => {
    const forwards = buildOperationalEnvelope([localBinding('alpha:1b'), localBinding('beta:2b')]);
    const backwards = buildOperationalEnvelope([localBinding('beta:2b'), localBinding('alpha:1b')]);
    expect(operationalEnvelopeDigest(forwards)).not.toBe(operationalEnvelopeDigest(backwards));
  });

  it('computes `mixed` rather than believing a declaration', () => {
    const homogeneous = buildOperationalEnvelope([localBinding('alpha:1b'), localBinding('beta:2b')]);
    expect(homogeneous.mixed).toBe(false);
    const mixed = buildOperationalEnvelope([localBinding('alpha:1b'), subscriptionBinding('claudeCLI:sonnet')]);
    expect(mixed.mixed).toBe(true);
    expect(mixed.executionClasses).toEqual(['localRuntime', 'subscriptionCLI']);
    expect(MIXED_EXECUTION_REASONS.length).toBeGreaterThan(0);
  });

  it('knows whether anything in it will be billed per token', () => {
    expect(buildOperationalEnvelope([localBinding('alpha:1b')]).hasMeteredBinding).toBe(false);
    expect(buildOperationalEnvelope([subscriptionBinding('claudeCLI:s')]).hasMeteredBinding).toBe(false);
    expect(buildOperationalEnvelope([meteredBinding('anthropicAPI:m')]).hasMeteredBinding).toBe(true);
  });

  it('refuses two bindings for one candidate, because a model reached two ways is two candidates', () => {
    expect(() => buildOperationalEnvelope([localBinding('alpha:1b'), localBinding('alpha:1b')]))
      .toThrow(/is two candidates and must be named as two/);
  });

  it('refuses an envelope over no bindings', () => {
    expect(() => buildOperationalEnvelope([])).toThrow(ProviderBindingError);
  });

  it('says plainly when a candidate has no binding rather than inventing one', () => {
    const envelope = buildOperationalEnvelope([localBinding('alpha:1b')]);
    expect(() => bindingFor(envelope, 'beta:2b')).toThrow(/no record of who would be asked or who would pay/);
  });
});

describe('the three cost stories are told in three different sentences', () => {
  it('never describes subscription execution as free', () => {
    const subscription = billingLabel(subscriptionBinding('claudeCLI:s'));
    expect(subscription).toMatch(/subscription-included/);
    expect(subscription).toMatch(/finite allowance/);
    expect(subscription).not.toMatch(/\bfree\b/i);
  });

  it('distinguishes local, subscription and metered', () => {
    expect(billingLabel(localBinding('alpha:1b'))).toMatch(/no monetary cost/);
    expect(billingLabel(meteredBinding('anthropicAPI:m'))).toMatch(/billed per token/);
    expect(isLocal(localBinding('a'))).toBe(true);
    expect(isFrontier(subscriptionBinding('claudeCLI:s'))).toBe(true);
    expect(isMetered(subscriptionBinding('claudeCLI:s'))).toBe(false);
    expect(isMetered(meteredBinding('anthropicAPI:m'))).toBe(true);
  });

  it('writes the identity state into the one-line description rather than leaving it implied', () => {
    const unverifiable = subscriptionBinding('claudeCLI:s', 'claudeCLI', { identityState: 'unverifiable', verifiedModelID: '' });
    expect(describeBinding(unverifiable)).toMatch(/identity UNVERIFIABLE/);
    expect(describeBinding(subscriptionBinding('claudeCLI:s'))).toMatch(/identity verified as/);
  });
});

describe('pricing is supplied, never inferred', () => {
  it('reads a complete entry', () => {
    const file = { 'anthropicAPI:m': { ...TEST_PRICING } } as Record<string, unknown>;
    expect(pricingFor(file, 'anthropicAPI', 'm')?.inputMicroUSDPerMillionTokens).toBe(3_000_000);
  });

  it('refuses an entry with no provenance, rather than defaulting one', () => {
    const file = { 'anthropicAPI:m': { ...TEST_PRICING, source: '' } } as Record<string, unknown>;
    expect(pricingFor(file, 'anthropicAPI', 'm')).toBeUndefined();
  });

  it('refuses an entry with no capture time', () => {
    const file = { 'anthropicAPI:m': { ...TEST_PRICING, capturedAt: '' } } as Record<string, unknown>;
    expect(pricingFor(file, 'anthropicAPI', 'm')).toBeUndefined();
  });

  it('refuses a non-integer price, because the canonical encoder cannot hash a float', () => {
    const file = { 'anthropicAPI:m': { ...TEST_PRICING, inputMicroUSDPerMillionTokens: 3.5 } } as Record<string, unknown>;
    expect(pricingFor(file, 'anthropicAPI', 'm')).toBeUndefined();
  });
});
