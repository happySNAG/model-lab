// What happens when a provider misbehaves, and what is still true afterwards.
//
// The property every test here checks is the SAME one Pass 3's ledger tests check, extended to a
// provider that is not on this machine: whatever went wrong, the campaign can be resumed, no
// completed attempt is repeated, and no slot ends up with two outcomes or none. For a paid provider
// that property is not merely tidy — a resume that repeated a finished attempt would pay twice for
// one answer.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Campaign } from '../../src/engine/campaign';
import { Ledger } from '../../src/engine/ledger';
import { campaignPaths } from '../../src/engine/campaign';
import { authorizeSpending, estimateSpending } from '../../src/engine/spending';
import { operationalEnvelopeDigest } from '../../src/engine/provider';
import { plannedWorkFor } from '../../src/engine/campaign-builder';
import {
  catalogue, configurationFor, envelopeOf, localBinding, meteredBinding, routingHost,
  scriptedAdapter, subscriptionBinding, temporaryRoot,
} from './frontier-harness';

let campaignRoot: string;
let root: string;
beforeEach(() => {
  campaignRoot = temporaryRoot('frontier-resilience-');
  root = path.join(campaignRoot, 'run');
});
afterEach(() => fs.rmSync(campaignRoot, { recursive: true, force: true }));

const SUBSCRIPTION = envelopeOf(subscriptionBinding('claudeCLI:sonnet'));

describe('a provider failure is a recorded outcome, not a crash', () => {
  /**
   * SUPERSEDED IN PASS 8, DELIBERATELY. This case previously asserted that a rate limit was
   * recorded as a `runtimeError` row and the campaign carried on — "records a rate limit as a
   * runtimeError and keeps going".
   *
   * That was wrong, and a 440-attempt campaign is what made it obvious. The ranking's counting rule
   * treats everything that is not a pass, a partial, an awaited review or inapplicable as a FAIL, so
   * a `runtimeError` row became a quality failure for a model that was never allowed to answer. A
   * subscription that throttles halfway through a long run would have handed every remaining
   * candidate a wall of zeroes and inverted the leaderboard.
   *
   * So a throttle now aborts and records nothing. The behaviour the old assertion described is kept
   * in the name of this test, because a reader who finds the old expectation somewhere else deserves
   * to know it was replaced on purpose rather than lost.
   */
  it('ABORTS on a rate limit rather than recording a runtimeError that would count as a failure', async () => {
    const adapter = scriptedAdapter('claudeCLI', {}, {
      failure: { kind: 'rateLimited', detail: '429 slow down' },
    });
    const { host } = routingHost({ envelope: SUBSCRIPTION, adapters: { claudeCLI: adapter } });
    const campaign = Campaign.create(root, configurationFor(SUBSCRIPTION), host);
    const status = await campaign.run({ campaignRootDirectory: campaignRoot });

    expect(status.state).toBe('aborted');
    // The property this file exists to protect still holds: no slot has two outcomes or none it
    // cannot account for. It has NO outcome, and the abort says which slots are still runnable.
    expect(status.reconciliation.balances).toBe(true);
    expect(campaign.ledger.results.size).toBe(0);
    const abort = campaign.ledger.standingAbort()!;
    expect(abort.stage).toBe('providerThrottling');
    expect(abort.reason).toMatch(/claudeCLI\.rateLimited/);
    expect(abort.blockedSlotCount).toBe(campaign.ledger.plan.length);
  });

  it('records a timeout as a timeout, and marks the row so a metrics table can count it', async () => {
    const adapter = scriptedAdapter('claudeCLI', {}, {
      failure: { kind: 'timeout', detail: 'the tool did not finish within its deadline' },
    });
    const { host } = routingHost({ envelope: SUBSCRIPTION, adapters: { claudeCLI: adapter } });
    const campaign = Campaign.create(root, configurationFor(SUBSCRIPTION), host);
    await campaign.run({ campaignRootDirectory: campaignRoot });
    for (const row of campaign.ledger.results.values()) expect(row.timedOut).toBe(true);
  });

  it('does NOT check the provider identity on a failed attempt: there was no answer to attribute', async () => {
    const adapter = scriptedAdapter('claudeCLI', {}, {
      failure: { kind: 'transport', detail: 'the socket closed' }, reportedModelID: 'something-else',
    });
    const { host } = routingHost({ envelope: SUBSCRIPTION, adapters: { claudeCLI: adapter } });
    const campaign = Campaign.create(root, configurationFor(SUBSCRIPTION), host);
    // A failure whose response happens to carry a different model name must not be reported as a
    // substitution: nothing was answered, so nothing was substituted.
    const status = await campaign.run({ campaignRootDirectory: campaignRoot });
    expect(status.state).toBe('complete');
    expect(campaign.ledger.events().some((event) => event.kind === 'providerModelSubstituted')).toBe(false);
  });

  it('resumes after a provider failure and re-runs ONLY what never became terminal', async () => {
    const failing = scriptedAdapter('claudeCLI', {}, { failure: { kind: 'transport', detail: 'down' } });
    const { host } = routingHost({ envelope: SUBSCRIPTION, adapters: { claudeCLI: failing } });
    const campaign = Campaign.create(root, configurationFor(SUBSCRIPTION), host);
    const first = await campaign.run({ campaignRootDirectory: campaignRoot, maxAttempts: 2, lock: false });
    expect(first.terminalCount).toBe(2);

    // A failure IS terminal. Resuming does not re-run it — and for a paid provider, that is the
    // difference between one charge and two.
    const working = scriptedAdapter('claudeCLI');
    const resumed = Campaign.open(root, configurationFor(SUBSCRIPTION), routingHost({ envelope: SUBSCRIPTION, adapters: { claudeCLI: working } }).host);
    const status = await resumed.run({ campaignRootDirectory: campaignRoot, lock: false });
    expect(status.state).toBe('complete');
    expect(status.reconciliation.duplicateTerminalResults).toBe(0);
    expect(working.requests).toHaveLength(status.slotCount - 2);
  });
});

describe('an interruption mid-campaign', () => {
  it('pauses at a slot boundary and resumes with no slot attempted twice', async () => {
    let paused = false;
    const adapter = scriptedAdapter('claudeCLI');
    const { host } = routingHost({ envelope: SUBSCRIPTION, adapters: { claudeCLI: adapter }, shouldCancel: () => paused });
    const campaign = Campaign.create(root, configurationFor(SUBSCRIPTION), host);
    let seen = 0;
    const status = await campaign.run({
      campaignRootDirectory: campaignRoot, lock: false,
      shouldPause: () => paused,
      onProgress: () => { seen += 1; if (seen >= 2) paused = true; },
    });
    expect(status.state).toBe('paused');
    expect(campaign.ledger.results.size).toBe(2);

    paused = false;
    const second = scriptedAdapter('claudeCLI');
    const resumed = Campaign.open(root, configurationFor(SUBSCRIPTION), routingHost({ envelope: SUBSCRIPTION, adapters: { claudeCLI: second } }).host);
    const done = await resumed.run({ campaignRootDirectory: campaignRoot, lock: false });
    expect(done.state).toBe('complete');
    expect(done.reconciliation.duplicateTerminalResults).toBe(0);
    expect(adapter.requests.length + second.requests.length).toBe(done.slotCount);
  });

  it('survives a torn final row: the unfsynced attempt is re-run, and nothing else is', async () => {
    const adapter = scriptedAdapter('claudeCLI');
    const { host } = routingHost({ envelope: SUBSCRIPTION, adapters: { claudeCLI: adapter } });
    const campaign = Campaign.create(root, configurationFor(SUBSCRIPTION), host);
    await campaign.run({ campaignRootDirectory: campaignRoot, maxAttempts: 3, lock: false });

    // A crash between the write and the fsync leaves a half-written final line.
    const results = campaignPaths(root).ledger + '/results.jsonl';
    const raw = fs.readFileSync(results, 'utf8');
    fs.writeFileSync(results, raw + '{"slotKey":"claudeCLI:sonnet|suite.model-l', 'utf8');

    const reopened = Ledger.open(campaignPaths(root).ledger);
    expect(reopened.anomalies.some((anomaly) => anomaly.kind === 'repairedTornWrite')).toBe(true);
    expect(reopened.results.size).toBe(3);

    const second = scriptedAdapter('claudeCLI');
    const resumed = Campaign.open(root, configurationFor(SUBSCRIPTION), routingHost({ envelope: SUBSCRIPTION, adapters: { claudeCLI: second } }).host);
    const status = await resumed.run({ campaignRootDirectory: campaignRoot, lock: false });
    expect(status.state).toBe('complete');
    expect(status.reconciliation.duplicateTerminalResults).toBe(0);
    expect(second.requests).toHaveLength(status.slotCount - 3);
  });

  it('keeps a metered campaign\'s ceiling across the interruption', async () => {
    const metered = envelopeOf(meteredBinding('anthropicAPI:m'));
    const authorization = authorizeSpending(
      estimateSpending(metered, plannedWorkFor(catalogue(1), ['anthropicAPI:m'], 1)),
      {
        campaignID: 'c', authorizedAt: 'now', authorizedBy: 'the test',
        hardCeilingMicroUSD: 1_000_000_000, operationalEnvelopeDigest: operationalEnvelopeDigest(metered),
      },
    );
    const first = routingHost({ envelope: metered, adapters: { anthropicAPI: scriptedAdapter('anthropicAPI') }, authorization });
    const campaign = Campaign.create(root, configurationFor(metered), first.host);
    campaign.writeAuthorization(authorization);
    await campaign.run({ campaignRootDirectory: campaignRoot, maxAttempts: 2, lock: false });
    const spentBefore = first.spend.spentMicroUSD;
    expect(spentBefore).toBeGreaterThan(0);

    // A new process: the tracker starts at zero and is restored from the rows on disk.
    const second = routingHost({
      envelope: metered, adapters: { anthropicAPI: scriptedAdapter('anthropicAPI') },
      authorization, priorRows: campaign.ledgerRows(),
    });
    // The harness builds its own tracker; restore it exactly as the host factory does in life.
    const { restoreSpendFromRows } = await import('../../src/engine/spending');
    restoreSpendFromRows(second.spend, campaign.ledgerRows());
    expect(second.spend.spentMicroUSD).toBe(spentBefore);
  });
});

describe('a mixed campaign keeps its halves independent', () => {
  it('a frontier failure does not stop the local candidate, and vice versa', async () => {
    const envelope = envelopeOf(localBinding('alpha:1b'), subscriptionBinding('claudeCLI:sonnet'));
    const adapter = scriptedAdapter('claudeCLI', {}, { failure: { kind: 'transport', detail: 'down' } });
    const { host } = routingHost({ envelope, adapters: { claudeCLI: adapter } });
    const campaign = Campaign.create(root, configurationFor(envelope), host);
    const status = await campaign.run({ campaignRootDirectory: campaignRoot, runtimeLease: false });

    expect(status.state).toBe('complete');
    const local = [...campaign.ledger.results.values()].filter((row) => row.candidate === 'alpha:1b');
    const frontier = [...campaign.ledger.results.values()].filter((row) => row.candidate === 'claudeCLI:sonnet');
    expect(local.every((row) => row.status !== 'runtimeError')).toBe(true);
    // The claim here is INDEPENDENCE: the frontier half failed on every slot and the local half did
    // not. Since Pass 11 a dead provider is `envelopeFailure` + `transportFailed` rather than
    // `runtimeError`, because no model answered it — see `attempt-disposition.ts`.
    expect(frontier.every((row) => row.status === 'envelopeFailure')).toBe(true);
    expect(frontier.every((row) => row.disposition === 'transportFailed')).toBe(true);
    // And the local candidate's residency was still proved, whatever the provider did.
    expect(campaign.ledger.events().some((event) => event.kind === 'residencyVerified' && event.candidate === 'alpha:1b')).toBe(true);
  });
});
