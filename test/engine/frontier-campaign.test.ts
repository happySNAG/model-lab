// A whole frontier campaign, driven end to end without one request reaching one provider.
//
// These drive the REAL orchestration — the real ledger, the real guards, the real manifest
// verification, the real residency logic, the real spend tracker — through scripted adapters. The
// frontier half of the routing host is the only thing replaced, which is what makes these tests of
// the code that runs in life rather than of a parallel implementation.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { Campaign, campaignPaths } from '../../src/engine/campaign';
import { Ledger } from '../../src/engine/ledger';
import { runtimeLeasePath } from '../../src/engine/runtime-lease';
import { acquireRuntimeLease } from '../../src/engine/runtime-lease';
import {
  configurationFor, envelopeOf, localBinding, meteredBinding, routingHost, scriptedAdapter,
  subscriptionBinding, temporaryRoot,
} from './frontier-harness';
import * as path from 'node:path';

let root: string;
let campaignRoot: string;
beforeEach(() => {
  campaignRoot = temporaryRoot('frontier-campaigns-');
  root = path.join(campaignRoot, 'run');
});
afterEach(() => fs.rmSync(campaignRoot, { recursive: true, force: true }));

describe('a frontier-only campaign', () => {
  const envelope = envelopeOf(subscriptionBinding('claudeCLI:sonnet'), subscriptionBinding('claudeCLI:haiku'));

  it('runs to completion and reconciles, with no local runtime involved at all', async () => {
    const { host } = routingHost({ envelope });
    const campaign = Campaign.create(root, configurationFor(envelope), host);
    const status = await campaign.run({ campaignRootDirectory: campaignRoot });
    expect(status.state).toBe('complete');
    expect(status.reconciliation.balances).toBe(true);
    expect(status.terminalCount).toBe(status.slotCount);
  });

  it('TAKES NO OLLAMA ENDPOINT LEASE, because it reaches no Ollama', async () => {
    const { host } = routingHost({ envelope });
    // The lease is taken against the host's runtime identity, and a frontier-only routing host
    // offers none. This is the structural form of the exemption: not a flag to check, but the
    // absence of the thing a lease is taken against.
    expect(host.runtimeIdentity).toBeUndefined();

    const campaign = Campaign.create(root, configurationFor(envelope), host);
    await campaign.run({ campaignRootDirectory: campaignRoot });
    const events = campaign.ledger.events().map((event) => event.kind);
    expect(events).not.toContain('runtimeLeaseAcquired');
    expect(events).not.toContain('runtimeLeaseRefused');
  });

  it('runs even while another campaign holds the local endpoint, because it wants nothing from it', async () => {
    // A live lease on the local runtime, held by somebody else.
    const lease = acquireRuntimeLease(campaignRoot, {
      processType: 'terminal', command: 'another campaign', campaignID: 'campaign:other',
      campaignName: 'other', endpoint: 'http://127.0.0.1:11434',
    });
    expect(fs.existsSync(runtimeLeasePath(campaignRoot, 'http://127.0.0.1:11434'))).toBe(true);

    const { host } = routingHost({ envelope });
    const campaign = Campaign.create(root, configurationFor(envelope), host);
    const status = await campaign.run({ campaignRootDirectory: campaignRoot });
    expect(status.state).toBe('complete');
    lease.release();
  });

  it('manages no residency, and says so in the trace rather than being silently absent', async () => {
    const { host } = routingHost({ envelope });
    const campaign = Campaign.create(root, configurationFor(envelope), host);
    await campaign.run({ campaignRootDirectory: campaignRoot });
    const events = campaign.ledger.events();
    expect(events.filter((event) => event.kind === 'residencyVerified')).toHaveLength(0);
    const notApplicable = events.filter((event) => event.kind === 'residencyNotApplicable');
    expect(notApplicable.length).toBeGreaterThan(0);
    expect(String(notApplicable[0].why)).toMatch(/no weights were loaded on this machine/);
  });
});

describe('a mixed campaign', () => {
  const envelope = envelopeOf(localBinding('alpha:1b'), subscriptionBinding('claudeCLI:sonnet'));

  it('takes an endpoint lease, because one of its candidates does use the local runtime', async () => {
    const { host } = routingHost({ envelope, localReachesARuntime: true });
    expect(host.runtimeIdentity).toBeDefined();
    const campaign = Campaign.create(root, configurationFor(envelope), host);
    await campaign.run({ campaignRootDirectory: campaignRoot });
    expect(campaign.ledger.events().some((event) => event.kind === 'runtimeLeaseAcquired')).toBe(true);
  });

  it('exempts only the FRONTIER candidates from the lease, not the campaign', async () => {
    // The same envelope with its local candidate removed takes no lease at all, which is the
    // difference the exemption actually makes.
    const frontierOnly = envelopeOf(subscriptionBinding('claudeCLI:sonnet'));
    expect(routingHost({ envelope: frontierOnly, localReachesARuntime: true }).host.runtimeIdentity).toBeUndefined();
  });

  it('proves residency for the local candidate and records the frontier one as inapplicable', async () => {
    const { host } = routingHost({ envelope });
    const campaign = Campaign.create(root, configurationFor(envelope), host);
    await campaign.run({ campaignRootDirectory: campaignRoot, runtimeLease: false });
    const events = campaign.ledger.events();
    const proved = events.filter((event) => event.kind === 'residencyVerified').map((event) => event.candidate);
    const skipped = events.filter((event) => event.kind === 'residencyNotApplicable').map((event) => event.candidate);
    expect(proved).toContain('alpha:1b');
    expect(proved).not.toContain('claudeCLI:sonnet');
    expect(skipped).toContain('claudeCLI:sonnet');
  });

  it('resumes without repeating a single completed attempt, local or frontier', async () => {
    const first = routingHost({ envelope });
    const campaign = Campaign.create(root, configurationFor(envelope), first.host);
    const partial = await campaign.run({ campaignRootDirectory: campaignRoot, runtimeLease: false, maxAttempts: 5, lock: false });
    expect(partial.state).toBe('paused');
    expect(partial.terminalCount).toBe(5);
    const doneFirst = new Set([...campaign.ledger.results.keys()]);

    // A NEW host and a NEW campaign object, as a resume in another process would be.
    const second = routingHost({ envelope });
    const resumed = Campaign.open(root, configurationFor(envelope), second.host);
    const status = await resumed.run({ campaignRootDirectory: campaignRoot, runtimeLease: false, lock: false });

    expect(status.state).toBe('complete');
    expect(status.reconciliation.duplicateTerminalResults).toBe(0);
    expect(status.reconciliation.balances).toBe(true);
    // Every slot finished before the pause has exactly one result, and it is the original one.
    for (const key of doneFirst) expect(resumed.ledger.results.get(key)?.seq).toBeLessThan(5);
    // And the resumed adapter was asked ONLY for the frontier slots still pending. This is the
    // property that matters for a paid provider: a resume that re-asked a finished slot would be a
    // resume that paid twice for one answer.
    const frontierSlots = resumed.ledger.plan.filter((slot) => slot.candidate === 'claudeCLI:sonnet').map((slot) => slot.slotKey);
    const frontierDoneBefore = frontierSlots.filter((key) => doneFirst.has(key)).length;
    const askedOnResume = (second.adapters.claudeCLI as unknown as { requests: { binding: { candidate: string } }[] }).requests;
    expect(askedOnResume).toHaveLength(frontierSlots.length - frontierDoneBefore);
    for (const request of askedOnResume) expect(request.binding.candidate).toBe('claudeCLI:sonnet');
    // Across both runs, the provider was asked exactly once per frontier slot and never twice.
    const firstRunAsks = (first.adapters.claudeCLI as unknown as { requests: unknown[] }).requests.length;
    expect(firstRunAsks + askedOnResume.length).toBe(frontierSlots.length);
  });

  it('records who answered and on whose bill on EVERY row, local rows included', async () => {
    const { host } = routingHost({ envelope });
    const campaign = Campaign.create(root, configurationFor(envelope), host);
    await campaign.run({ campaignRootDirectory: campaignRoot, runtimeLease: false });
    for (const row of campaign.ledger.results.values()) {
      expect(typeof row.provider).toBe('string');
      expect(typeof row.executionClass).toBe('string');
      expect(typeof row.billingBasis).toBe('string');
    }
    const local = [...campaign.ledger.results.values()].filter((row) => row.candidate === 'alpha:1b');
    expect(local.every((row) => row.billingBasis === 'local')).toBe(true);
    expect(local.every((row) => row.costMicroUSD === 0)).toBe(true);
    const frontier = [...campaign.ledger.results.values()].filter((row) => row.candidate === 'claudeCLI:sonnet');
    expect(frontier.every((row) => row.billingBasis === 'subscriptionIncluded')).toBe(true);
    // Subscription: zero marginal API charge, and recorded as measured rather than unavailable —
    // "this had no per-token charge" is a fact, not an absence of evidence.
    expect(frontier.every((row) => row.costMicroUSD === 0 && row.costProvenance === 'measured')).toBe(true);
  });
});

describe('silent model substitution', () => {
  const envelope = envelopeOf(subscriptionBinding('claudeCLI:sonnet'));

  it('aborts the candidate when the provider says a different model answered', async () => {
    const adapter = scriptedAdapter('claudeCLI', {}, { reportedModelID: 'some-other-model' });
    const { host } = routingHost({ envelope, adapters: { claudeCLI: adapter } });
    const campaign = Campaign.create(root, configurationFor(envelope), host);
    const status = await campaign.run({ campaignRootDirectory: campaignRoot });

    expect(status.state).toBe('aborted');
    expect(status.standingAbort?.stage).toBe('providerIdentityVerification');
    expect(status.standingAbort?.reason).toMatch(/froze sonnet, and the provider reports that some-other-model answered/);
    // Nothing was scored. A real answer to a question about a different model is not a result.
    expect(campaign.ledger.results.size).toBe(0);
    expect(campaign.ledger.events().some((event) => event.kind === 'providerModelSubstituted')).toBe(true);
  });

  it('accepts an alias resolved to a dated build, and records the exact build', async () => {
    const adapter = scriptedAdapter('claudeCLI', {}, { reportedModelID: 'sonnet-20260114' });
    const { host } = routingHost({ envelope, adapters: { claudeCLI: adapter } });
    const campaign = Campaign.create(root, configurationFor(envelope), host);
    const status = await campaign.run({ campaignRootDirectory: campaignRoot });

    expect(status.state).toBe('complete');
    for (const row of campaign.ledger.results.values()) {
      expect(row.reportedModelID).toBe('sonnet-20260114');
      expect(row.providerIdentityState).toBe('verified');
    }
  });

  it('carries an unverifiable identity rather than blocking on it, and labels every row', async () => {
    const adapter = scriptedAdapter('claudeCLI', {}, { reportedModelID: '' });
    const { host } = routingHost({ envelope, adapters: { claudeCLI: adapter } });
    const campaign = Campaign.create(root, configurationFor(envelope), host);
    const status = await campaign.run({ campaignRootDirectory: campaignRoot });

    expect(status.state).toBe('complete');
    for (const row of campaign.ledger.results.values()) {
      expect(row.providerIdentityState).toBe('unverifiable');
      expect(row.reportedModelID).toBe('');
    }
  });
});

describe('the frozen envelope cannot be edited into something else', () => {
  const envelope = envelopeOf(subscriptionBinding('claudeCLI:sonnet'));

  it('refuses to resume when configuration.json points a candidate at a different effort', async () => {
    const { host } = routingHost({ envelope });
    const campaign = Campaign.create(root, configurationFor(envelope), host);
    await campaign.run({ campaignRootDirectory: campaignRoot, maxAttempts: 1, lock: false });

    const edited = envelopeOf(subscriptionBinding('claudeCLI:sonnet', 'claudeCLI', { effort: 'max' }));
    const tampered = Campaign.open(root, configurationFor(edited), routingHost({ envelope: edited }).host);
    const report = tampered.verify();
    expect(report.intact).toBe(false);
    expect(report.drifts.map((drift) => drift.field)).toContain('operationalEnvelopeDigest');
    await expect(tampered.run({ campaignRootDirectory: campaignRoot, lock: false })).rejects.toThrow(/manifest no longer describes this campaign/);
  });

  it('refuses to resume when a candidate is repointed at a cheaper model', async () => {
    const { host } = routingHost({ envelope });
    Campaign.create(root, configurationFor(envelope), host);
    const swapped = envelopeOf(subscriptionBinding('claudeCLI:sonnet', 'claudeCLI', { requestedModelID: 'haiku', verifiedModelID: 'haiku' }));
    const tampered = Campaign.open(root, configurationFor(swapped), routingHost({ envelope: swapped }).host);
    expect(tampered.verify().intact).toBe(false);
  });

  it('refuses to resume when a metered binding\'s pricing snapshot is edited', async () => {
    const metered = envelopeOf(meteredBinding('anthropicAPI:m'));
    Campaign.create(root, configurationFor(metered), routingHost({ envelope: metered }).host);
    const cheaper = envelopeOf(meteredBinding('anthropicAPI:m', 'anthropicAPI', {
      pricing: { source: 'edited', capturedAt: '2026-01-01T00:00:00Z', currency: 'USD', inputMicroUSDPerMillionTokens: 1, outputMicroUSDPerMillionTokens: 1, reasoningMicroUSDPerMillionTokens: null },
    }));
    const tampered = Campaign.open(root, configurationFor(cheaper), routingHost({ envelope: cheaper }).host);
    expect(tampered.verify().intact).toBe(false);
  });
});

describe('the ledger a frontier campaign leaves behind', () => {
  it('stands on its own: every row names its provider, class and billing basis', async () => {
    const envelope = envelopeOf(subscriptionBinding('claudeCLI:sonnet'));
    const { host } = routingHost({ envelope });
    const campaign = Campaign.create(root, configurationFor(envelope), host);
    await campaign.run({ campaignRootDirectory: campaignRoot });

    const reopened = Ledger.open(campaignPaths(root).ledger);
    expect(reopened.reconcile().complete).toBe(true);
    for (const row of reopened.results.values()) {
      expect(row.provider).toBe('claudeCLI');
      expect(row.executionClass).toBe('subscriptionCLI');
      expect(row.billingBasis).toBe('subscriptionIncluded');
      expect(row.requestedModelID).toBe('sonnet');
    }
  });
});
