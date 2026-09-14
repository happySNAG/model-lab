// The terminal and the interface must create the SAME campaign, not an equivalent one.
//
// Pass 3's release-blocking defect was two surfaces configuring a host slightly differently. The
// surface that can differ is now every provider, effort level, budget, timeout, retry policy,
// billing basis and pricing snapshot in the campaign — and every one of them is bound into the
// manifest identity. Two surfaces building those separately would not merely behave differently:
// they would freeze DIFFERENT MANIFESTS for the same request, which is the one thing a frozen
// manifest exists to make impossible.
//
// So both surfaces call `buildCampaignPlan`, and this file asserts that the two request shapes —
// terminal flags and an IPC payload — reduce to byte-identical configurations.

import { describe, expect, it } from 'vitest';
import { CampaignBuildError, budgetsFor, buildCampaignPlan, plannedWorkFor } from '../../src/engine/campaign-builder';
import { buildHostForCampaign, adaptersFor, anthropicBaseURL, openaiBaseURL } from '../../src/engine/host-factory';
import { canonicalJSON, CanonicalValue } from '../../src/engine/canonical';
import { operationalEnvelopeDigest } from '../../src/engine/provider';
import { RoutingHost } from '../../src/engine/frontier-host';
import { LiveHost } from '../../src/engine/live-host';
import { catalogue, provenModel, TEST_PRICING } from './frontier-harness';
import { SYNTHETIC_HARDWARE } from '../../src/engine/synthetic';

const HARDWARE = SYNTHETIC_HARDWARE;
const SUITES = ['suite.model-lab.foundation'];

const LOCAL = {
  name: 'alpha:1b', modelID: 'alpha:1b', runtimeDigest: 'digest-alpha:1b', parameterSize: '1B', quantization: 'Q4_K_M',
};

/** How the TERMINAL expresses it: `--models alpha:1b --frontier claudeCLI:sonnet:high`. */
function fromTerminalFlags() {
  return buildCampaignPlan({
    label: 'a cohort',
    suiteIDs: SUITES,
    repeatsPerCase: 1,
    local: [LOCAL],
    frontier: [{
      name: 'claudeCLI:sonnet@high',
      provider: 'claudeCLI',
      modelID: 'sonnet',
      effort: 'high',
      thinkingMode: 'disabled',
    }],
    observeOnly: false,
    thinkingMode: 'disabled',
    endpoint: 'http://127.0.0.1:11434',
    hardware: HARDWARE,
    runtimeVersion: 'ollama-unreported',
    provenModels: [provenModel('claudeCLI', 'sonnet', ['high', 'max'])],
  });
}

/** How the INTERFACE expresses it: a checkbox for the model, a checkbox for the effort. */
function fromInterfacePayload() {
  const selection = { provider: 'claudeCLI' as const, modelID: 'sonnet', effort: 'high' as const };
  return buildCampaignPlan({
    label: 'a cohort',
    suiteIDs: SUITES,
    repeatsPerCase: 1,
    local: [LOCAL],
    frontier: [{
      // The service's own naming rule, applied here exactly as `frontierRequests` applies it.
      name: `${selection.provider}:${selection.modelID}@${selection.effort}`,
      provider: selection.provider,
      modelID: selection.modelID,
      effort: selection.effort,
      thinkingMode: 'disabled',
    }],
    observeOnly: false,
    thinkingMode: 'disabled',
    endpoint: 'http://127.0.0.1:11434',
    hardware: HARDWARE,
    runtimeVersion: 'ollama-unreported',
    provenModels: [provenModel('claudeCLI', 'sonnet', ['high', 'max'])],
  });
}

describe('the two surfaces freeze the same thing', () => {
  it('produces byte-identical configurations', () => {
    const terminal = fromTerminalFlags().configuration;
    const desktop = fromInterfacePayload().configuration;
    expect(canonicalJSON(desktop as unknown as CanonicalValue)).toBe(canonicalJSON(terminal as unknown as CanonicalValue));
  });

  it('produces the same operational-envelope digest, which is what the manifest binds', () => {
    expect(operationalEnvelopeDigest(fromInterfacePayload().envelope))
      .toBe(operationalEnvelopeDigest(fromTerminalFlags().envelope));
  });

  it('names the same candidates in the same order, because order is bound', () => {
    expect(fromInterfacePayload().configuration.candidates.map((candidate) => candidate.name))
      .toEqual(fromTerminalFlags().configuration.candidates.map((candidate) => candidate.name));
  });

  it('plans the same work, so both surfaces price the same campaign', () => {
    expect(fromInterfacePayload().plannedWork).toEqual(fromTerminalFlags().plannedWork);
  });
});

describe('the builder refuses an unproven model, whichever surface asked', () => {
  const request = (provenModels: ReturnType<typeof provenModel>[]) => () => buildCampaignPlan({
    label: 'a cohort', suiteIDs: SUITES, repeatsPerCase: 1, local: [],
    frontier: [{ name: 'claudeCLI:claude-opus-4-8', provider: 'claudeCLI', modelID: 'claude-opus-4-8', effort: 'none', thinkingMode: 'disabled' }],
    endpoint: 'http://127.0.0.1:11434', hardware: HARDWARE, runtimeVersion: 'x',
    provenModels,
  });

  it('refuses when discovery has proven nothing', () => {
    expect(request([])).toThrow(CampaignBuildError);
    expect(request([])).toThrow(/A model identifier is a plan, not a capability/);
  });

  it('refuses when discovery proved a DIFFERENT model', () => {
    expect(request([provenModel('claudeCLI', 'sonnet')])).toThrow(/has not been proven callable/);
  });

  it('accepts it once discovery has proven it, and records what proved it', () => {
    const built = request([provenModel('claudeCLI', 'claude-opus-4-8')])();
    expect(built.envelope.bindings[0].identityState).toBe('verified');
    expect(built.envelope.bindings[0].verifiedModelID).toBe('claude-opus-4-8');
    expect(built.envelope.bindings[0].identityEvidence).toMatch(/no provider was contacted to produce it/);
  });
});

describe('the builder refuses a paid campaign it cannot price', () => {
  const metered = (pricing?: typeof TEST_PRICING) => () => buildCampaignPlan({
    label: 'a cohort', suiteIDs: SUITES, repeatsPerCase: 1, local: [],
    frontier: [{
      name: 'anthropicAPI:m', provider: 'anthropicAPI', modelID: 'm', effort: 'none', thinkingMode: 'disabled',
      pricing, authorizationMode: 'apiKeyEnvironment',
    }],
    endpoint: 'http://127.0.0.1:11434', hardware: HARDWARE, runtimeVersion: 'x',
    provenModels: [provenModel('anthropicAPI', 'm')],
  });

  it('refuses a metered candidate with no pricing snapshot', () => {
    expect(metered()).toThrow(/will not run a paid campaign it cannot price/);
  });

  it('accepts one with prices and their provenance', () => {
    expect(metered(TEST_PRICING)().envelope.bindings[0].pricing?.source).toBe(TEST_PRICING.source);
  });

  it('refuses a metered candidate that does not say where its key comes from', () => {
    expect(() => buildCampaignPlan({
      label: 'a cohort', suiteIDs: SUITES, repeatsPerCase: 1, local: [],
      frontier: [{ name: 'anthropicAPI:m', provider: 'anthropicAPI', modelID: 'm', effort: 'none', thinkingMode: 'disabled', pricing: TEST_PRICING }],
      endpoint: 'http://127.0.0.1:11434', hardware: HARDWARE, runtimeVersion: 'x',
      provenModels: [provenModel('anthropicAPI', 'm')],
    })).toThrow(/does not say where its key comes from/);
  });
});

describe('the budgets and guards a campaign gets', () => {
  it('derives token budgets from the FROZEN catalogue rather than from a typed-in number', () => {
    const budgets = budgetsFor(catalogue(1));
    expect(budgets.maxOutputTokens).toBeGreaterThan(0);
    expect(budgets.maxInputTokens).toBeGreaterThan(0);
    const built = fromTerminalFlags();
    expect(built.envelope.bindings[0].maxOutputTokens).toBe(budgets.maxOutputTokens);
  });

  it('drops the benchmark-lane and model-store guards for a campaign with no local candidate', () => {
    const frontierOnly = buildCampaignPlan({
      label: 'a cohort', suiteIDs: SUITES, repeatsPerCase: 1, local: [],
      frontier: [{ name: 'claudeCLI:sonnet', provider: 'claudeCLI', modelID: 'sonnet', effort: 'none', thinkingMode: 'disabled' }],
      endpoint: 'http://127.0.0.1:11434', hardware: HARDWARE, runtimeVersion: 'x',
      provenModels: [provenModel('claudeCLI', 'sonnet')],
    });
    expect(frontierOnly.frontierOnly).toBe(true);
    expect(frontierOnly.configuration.guardPolicy?.benchmarkPort).toBeUndefined();
    expect(frontierOnly.configuration.storeBaseline).toBeUndefined();
    // Everything that is a property of THIS machine is still guarded.
    expect(frontierOnly.configuration.guardPolicy?.minimumFreeDiskBytes).toBeGreaterThan(0);
  });

  it('keeps the local lane guarded when a local candidate is present', () => {
    const built = fromTerminalFlags();
    expect(built.frontierOnly).toBe(false);
    expect(built.configuration.guardPolicy?.benchmarkPort).toBe(11434);
  });

  it('counts planned work from the frozen prompts, exactly', () => {
    const work = plannedWorkFor(catalogue(2), ['a'], 2);
    expect(work[0].plannedAttempts).toBe(catalogue(2).plannable.caseCount * 2);
    expect(work[0].promptCharacters).toBeGreaterThan(0);
  });
});

describe('the host factory is what both surfaces call', () => {
  it('gives a format-3 campaign the plain Pass 3 LiveHost, with nothing new in its path', () => {
    const built = buildHostForCampaign({
      label: 'x', suiteIDs: SUITES, repeatsPerCase: 1, candidates: [LOCAL],
      hardware: HARDWARE, runtimeVersion: 'x',
    }, { endpoint: 'http://127.0.0.1:11434' });
    expect(built.host).toBeInstanceOf(LiveHost);
    expect(built.spend).toBeUndefined();
    expect(built.frontierOnly).toBe(false);
  });

  it('gives a format-4 campaign a routing host with a spend tracker', () => {
    const built = buildHostForCampaign(fromTerminalFlags().configuration, { endpoint: 'http://127.0.0.1:11434' });
    expect(built.host).toBeInstanceOf(RoutingHost);
    expect(built.spend).toBeDefined();
  });

  it('builds an adapter only for the providers the envelope actually names', () => {
    const adapters = adaptersFor(fromTerminalFlags().envelope);
    expect(Object.keys(adapters)).toEqual(['claudeCLI']);
    expect(adapters.anthropicAPI).toBeUndefined();
    expect(adapters.openaiAPI).toBeUndefined();
  });

  it('defaults to the published endpoints and lets only the environment override them', () => {
    expect(anthropicBaseURL({})).toBe('https://api.anthropic.com');
    expect(openaiBaseURL({})).toBe('https://api.openai.com');
    expect(anthropicBaseURL({ CERNUM_ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' })).toBe('http://127.0.0.1:9');
  });
});
