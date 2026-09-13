// Money: what is refused, what is estimated, and what stops a run.
//
// Every test here drives the REAL spend tracker through the REAL campaign loop. No request reaches a
// provider — which is the point, because the code under test is the code that decides whether a
// request that would cost money is allowed to leave at all.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Campaign, campaignPaths } from '../../src/engine/campaign';
import {
  SpendTracker, SpendingError, attemptCostMicroUSD, authorizationDisclosure, authorizeSpending,
  estimateSpending, formatMicroUSD, parseCeilingToMicroUSD, restoreSpendFromRows, worstCaseAttemptMicroUSD,
} from '../../src/engine/spending';
import { operationalEnvelopeDigest } from '../../src/engine/provider';
import { plannedWorkFor } from '../../src/engine/campaign-builder';
import {
  TEST_PRICING, catalogue, configurationFor, envelopeOf, localBinding, meteredBinding,
  routingHost, scriptedAdapter, subscriptionBinding, temporaryRoot,
} from './frontier-harness';

let campaignRoot: string;
let root: string;
beforeEach(() => {
  campaignRoot = temporaryRoot('frontier-spend-');
  root = path.join(campaignRoot, 'run');
});
afterEach(() => fs.rmSync(campaignRoot, { recursive: true, force: true }));

const METERED = envelopeOf(meteredBinding('anthropicAPI:m'));
const work = () => plannedWorkFor(catalogue(1), ['anthropicAPI:m'], 1);

function authorization(ceilingMicroUSD: number) {
  return authorizeSpending(estimateSpending(METERED, work()), {
    campaignID: 'campaign:test',
    authorizedAt: '2026-01-01T00:00:00Z',
    authorizedBy: 'the test',
    hardCeilingMicroUSD: ceilingMicroUSD,
    operationalEnvelopeDigest: operationalEnvelopeDigest(METERED),
  });
}

describe('estimating', () => {
  it('brackets a metered candidate between a real floor and a real ceiling', () => {
    const estimate = estimateSpending(METERED, work());
    expect(estimate.estimable).toBe(true);
    expect(estimate.totalMinimumMicroUSD).toBeGreaterThan(0);
    expect(estimate.totalMaximumMicroUSD).toBeGreaterThan(estimate.totalMinimumMicroUSD);
    // The ceiling is the frozen budgets, which the adapter enforces — a genuine upper bound.
    const entry = estimate.perCandidate[0];
    expect(entry.maximumMicroUSD).toBe(
      Math.ceil((entry.maximumInputTokens * TEST_PRICING.inputMicroUSDPerMillionTokens) / 1_000_000)
      + Math.ceil((entry.maximumOutputTokens * TEST_PRICING.outputMicroUSDPerMillionTokens) / 1_000_000));
  });

  it('writes the divisor it used into the record, so the estimate can be argued with', () => {
    const estimate = estimateSpending(METERED, work(), { charactersPerTokenEstimate: 3 });
    expect(estimate.perCandidate[0].charactersPerTokenEstimate).toBe(3);
    expect(estimate.perCandidate[0].statement).toMatch(/3 characters per token/);
  });

  it('prices local execution at zero and never invents an electricity cost', () => {
    const estimate = estimateSpending(envelopeOf(localBinding('alpha:1b')), plannedWorkFor(catalogue(1), ['alpha:1b'], 1));
    expect(estimate.totalMaximumMicroUSD).toBe(0);
    expect(estimate.perCandidate[0].statement).toMatch(/No monetary cost/);
    expect(estimate.perCandidate[0].statement).toMatch(/no electricity cost is invented/);
  });

  it('describes subscription execution as included and finite, never as free', () => {
    const estimate = estimateSpending(envelopeOf(subscriptionBinding('claudeCLI:s')), plannedWorkFor(catalogue(1), ['claudeCLI:s'], 1));
    expect(estimate.subscriptionCandidateCount).toBe(1);
    expect(estimate.meteredCandidateCount).toBe(0);
    expect(estimate.totalMaximumMicroUSD).toBe(0);
    expect(estimate.perCandidate[0].statement).toMatch(/Marginal API charge \$0/);
    expect(estimate.perCandidate[0].statement).toMatch(/not free, it is already bought/);
  });

  it('keeps local, subscription and metered counted separately', () => {
    const mixed = envelopeOf(localBinding('alpha:1b'), subscriptionBinding('claudeCLI:s'), meteredBinding('anthropicAPI:m'));
    const estimate = estimateSpending(mixed, plannedWorkFor(catalogue(1), ['alpha:1b', 'claudeCLI:s', 'anthropicAPI:m'], 1));
    expect(estimate.localCandidateCount).toBe(1);
    expect(estimate.subscriptionCandidateCount).toBe(1);
    expect(estimate.meteredCandidateCount).toBe(1);
  });

  it('REFUSES rather than guesses when the plan says nothing about a candidate', () => {
    const estimate = estimateSpending(METERED, []);
    expect(estimate.estimable).toBe(false);
    expect(estimate.notEstimableBecause[0]).toMatch(/no quantity to price/);
  });

  it('REFUSES rather than guesses when the frozen prompts report no length', () => {
    const estimate = estimateSpending(METERED, [{ candidate: 'anthropicAPI:m', plannedAttempts: 4, promptCharacters: 0 }]);
    expect(estimate.estimable).toBe(false);
    expect(estimate.notEstimableBecause[0]).toMatch(/cannot be estimated/);
  });

  it('refuses to produce an authorization for a campaign it could not price', () => {
    expect(() => authorizeSpending(estimateSpending(METERED, []), {
      campaignID: 'c', authorizedAt: 'now', authorizedBy: 'me', hardCeilingMicroUSD: 1_000_000,
      operationalEnvelopeDigest: 'd',
    })).toThrow(/will not ask you to approve a number nobody computed/);
  });

  it('refuses a ceiling of zero: a run with no stopping condition is not an authorisation', () => {
    expect(() => authorization(0)).toThrow(SpendingError);
    expect(() => parseCeilingToMicroUSD('not money')).toThrow(SpendingError);
    expect(parseCeilingToMicroUSD('$5.00')).toBe(5_000_000);
    expect(parseCeilingToMicroUSD('5')).toBe(5_000_000);
  });

  it('states the pricing timestamp in the disclosure, so a stale estimate is visible', () => {
    const lines = authorizationDisclosure(estimateSpending(METERED, work()), 5_000_000);
    expect(lines.join(' ')).toMatch(/prices captured 2026-01-01T00:00:00Z/);
    expect(lines.join(' ')).toMatch(/Cernum does not fetch live prices/);
    expect(lines.join(' ')).toMatch(/stops before the request that would take it past \$5\.00/);
  });
});

describe('no paid request happens without recorded authorization', () => {
  it('refuses at the first metered slot and ABORTS rather than recording a result', async () => {
    const adapter = scriptedAdapter('anthropicAPI');
    // No authorization written anywhere.
    const { host } = routingHost({ envelope: METERED, adapters: { anthropicAPI: adapter } });
    const campaign = Campaign.create(root, configurationFor(METERED), host);
    const status = await campaign.run({ campaignRootDirectory: campaignRoot });

    expect(status.state).toBe('aborted');
    expect(status.standingAbort?.stage).toBe('spendingAuthorization');
    expect(status.standingAbort?.reason).toMatch(/carries no recorded spending authorization/);
    // NOT ONE REQUEST LEFT. This is the whole assertion of this file.
    expect(adapter.requests).toHaveLength(0);
    expect(campaign.ledger.results.size).toBe(0);
    // And every remaining slot is blocked, never attempted, carrying no outcome.
    expect(status.blockedCount).toBe(status.slotCount);
  });

  it('does not refuse a subscription candidate, which has no per-token charge to authorise', async () => {
    const envelope = envelopeOf(subscriptionBinding('claudeCLI:s'));
    const adapter = scriptedAdapter('claudeCLI');
    const { host } = routingHost({ envelope, adapters: { claudeCLI: adapter } });
    const campaign = Campaign.create(root, configurationFor(envelope), host);
    const status = await campaign.run({ campaignRootDirectory: campaignRoot });
    expect(status.state).toBe('complete');
    expect(adapter.requests.length).toBeGreaterThan(0);
  });

  it('does not refuse a local candidate either', async () => {
    const envelope = envelopeOf(localBinding('alpha:1b'));
    const { host } = routingHost({ envelope });
    const campaign = Campaign.create(root, configurationFor(envelope), host);
    expect((await campaign.run({ campaignRootDirectory: campaignRoot, runtimeLease: false })).state).toBe('complete');
  });

  it('runs once an authorization is recorded, and the authorization is on disk beside the campaign', async () => {
    const adapter = scriptedAdapter('anthropicAPI');
    const { host } = routingHost({ envelope: METERED, adapters: { anthropicAPI: adapter }, authorization: authorization(5_000_000) });
    const campaign = Campaign.create(root, configurationFor(METERED), host);
    campaign.writeAuthorization(authorization(5_000_000));
    expect(fs.existsSync(campaignPaths(root).authorization)).toBe(true);
    expect(campaign.readAuthorization()?.hardCeilingMicroUSD).toBe(5_000_000);

    const status = await campaign.run({ campaignRootDirectory: campaignRoot });
    expect(status.state).toBe('complete');
    expect(adapter.requests.length).toBe(status.slotCount);
  });

  it('rejects an authorization given for a DIFFERENT set of bindings', () => {
    const forAnother = authorizeSpending(estimateSpending(METERED, work()), {
      campaignID: 'campaign:test', authorizedAt: 'now', authorizedBy: 'me',
      hardCeilingMicroUSD: 5_000_000, operationalEnvelopeDigest: 'a-different-envelope',
    });
    const tracker = new SpendTracker(forAnother, operationalEnvelopeDigest(METERED));
    expect(() => tracker.check(METERED.bindings[0], 1)).toThrow(/given for a different set of provider bindings/);
  });
});

describe('the hard ceiling stops further requests', () => {
  it('stops BEFORE the request that would exceed it, not after one did', async () => {
    // A ceiling small enough that the very first attempt's worst case would breach it.
    const worstCase = worstCaseAttemptMicroUSD(METERED.bindings[0]);
    const adapter = scriptedAdapter('anthropicAPI');
    const { host } = routingHost({
      envelope: METERED, adapters: { anthropicAPI: adapter }, authorization: authorization(Math.max(1, worstCase - 1)),
    });
    const campaign = Campaign.create(root, configurationFor(METERED), host);
    const status = await campaign.run({ campaignRootDirectory: campaignRoot });

    expect(status.state).toBe('aborted');
    expect(status.standingAbort?.reason).toMatch(/would take this campaign past its hard ceiling/);
    expect(adapter.requests).toHaveLength(0);
  });

  it('keeps the attempts already recorded and blocks only the rest', async () => {
    const perAttempt = attemptCostMicroUSD(METERED.bindings[0], { inputTokens: 120, outputTokens: 30 });
    const worstCase = worstCaseAttemptMicroUSD(METERED.bindings[0]);
    // The ceiling refuses when `spent + worstCase > ceiling`, so a ceiling of one worst case plus
    // one actual attempt's cost leaves room for exactly two attempts and then stops. Deriving it
    // rather than typing a number is what makes this a test of the RULE and not of a magic constant.
    const ceiling = worstCase + perAttempt;
    const adapter = scriptedAdapter('anthropicAPI');
    const { host, spend } = routingHost({
      envelope: METERED, adapters: { anthropicAPI: adapter }, authorization: authorization(ceiling),
    });
    const campaign = Campaign.create(root, configurationFor(METERED), host);
    const status = await campaign.run({ campaignRootDirectory: campaignRoot });

    expect(status.state).toBe('aborted');
    expect(campaign.ledger.results.size).toBeGreaterThan(0);
    expect(campaign.ledger.results.size).toBeLessThan(status.slotCount);
    expect(campaign.ledger.results.size).toBe(2);
    expect(status.blockedCount).toBe(status.slotCount - campaign.ledger.results.size);
    expect(spend.spentMicroUSD).toBe(perAttempt * campaign.ledger.results.size);
    expect(adapter.requests).toHaveLength(2);
    // Blocked slots carry no result at all — they were never attempted, so they have no outcome to
    // carry. (The two that DID run are scored by the real evaluators against the real cases; what
    // they scored is beside the point here, only that exactly two of them exist.)
    const blocked = campaign.ledger.standingAbort()?.blockedSlotKeys ?? [];
    expect(blocked).toHaveLength(status.slotCount - 2);
    for (const key of blocked) expect(campaign.ledger.results.has(key)).toBe(false);
    expect(status.reconciliation.balances).toBe(true);
  });

  it('survives a resume: the total is rebuilt from the ledger, not restarted at zero', async () => {
    const perAttempt = attemptCostMicroUSD(METERED.bindings[0], { inputTokens: 120, outputTokens: 30 });
    const generous = authorization(1_000_000_000);
    const first = routingHost({ envelope: METERED, adapters: { anthropicAPI: scriptedAdapter('anthropicAPI') }, authorization: generous });
    const campaign = Campaign.create(root, configurationFor(METERED), first.host);
    campaign.writeAuthorization(generous);
    await campaign.run({ campaignRootDirectory: campaignRoot, maxAttempts: 2, lock: false });
    expect(first.spend.spentMicroUSD).toBe(perAttempt * 2);

    // A fresh tracker, as a new process would have.
    const fresh = new SpendTracker(generous, operationalEnvelopeDigest(METERED));
    expect(fresh.spentMicroUSD).toBe(0);
    restoreSpendFromRows(fresh, campaign.ledgerRows());
    expect(fresh.spentMicroUSD).toBe(perAttempt * 2);
    expect(fresh.meteredAttempts).toBe(2);
    expect(fresh.providerReportedMicroUSD).toBe(perAttempt * 2);
  });

  it('counts a refused attempt\'s burned input tokens, so the ceiling cannot leak', async () => {
    const generous = authorization(1_000_000_000);
    const adapter = scriptedAdapter('anthropicAPI', {}, {
      failure: { kind: 'refused', detail: 'scripted refusal' },
      usage: { inputTokens: 500, visibleOutputTokens: 0 },
      usageProvenance: 'providerReported',
    });
    const { host, spend } = routingHost({ envelope: METERED, adapters: { anthropicAPI: adapter }, authorization: generous });
    const campaign = Campaign.create(root, configurationFor(METERED), host);
    await campaign.run({ campaignRootDirectory: campaignRoot, maxAttempts: 1, lock: false });
    // The request failed and still cost its input. Money spent is money spent.
    expect(spend.spentMicroUSD).toBe(attemptCostMicroUSD(METERED.bindings[0], { inputTokens: 500, outputTokens: 0 }));
  });
});

describe('money is rendered so a sub-cent figure is visible', () => {
  it('keeps the digits on a figure smaller than a cent', () => {
    expect(formatMicroUSD(450)).toBe('$0.000450');
    expect(formatMicroUSD(5_000_000)).toBe('$5.00');
    expect(formatMicroUSD(0)).toBe('$0.00');
  });
});
