// The runtime-endpoint lease: one campaign owns one Ollama at a time.
//
// The campaign lock stops two processes running the same campaign. It says nothing about two
// DIFFERENT campaigns pointed at the same runtime — and two campaigns sharing one Ollama take turns
// evicting each other's weights, so each one's residency proof stops being true the moment the other
// loads a model. Both would finish clean and both would be wrong, with nothing in either ledger to
// show it. These tests hold the lease to refusing that, to letting genuinely separate endpoints run
// side by side, and to never breaking a live lease on its own judgement.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  RuntimeLeaseError, acquireRuntimeLease, breakRuntimeLease, inspectRuntimeLease, leasedEndpoints,
  runtimeLeaseDirectory, runtimeLeasePath,
} from '../../src/engine/runtime-lease';
import { normalizeEndpoint } from '../../src/engine/execution';
import { Campaign, CampaignConfiguration } from '../../src/engine/campaign';
import { SYNTHETIC_HARDWARE, SYNTHETIC_STORE_BASELINE, SyntheticHost, steppingClock, syntheticCandidate } from '../../src/engine/synthetic';

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-lease-')); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const QUIET = { heartbeatIntervalMilliseconds: 0 };
const ENDPOINT = 'http://127.0.0.1:11434';

function request(overrides: Partial<Parameters<typeof acquireRuntimeLease>[1]> = {}) {
  return {
    processType: 'terminal' as const,
    command: 'cernum run alpha',
    campaignID: 'campaign:alpha',
    campaignName: 'alpha',
    endpoint: ENDPOINT,
    modelStoreListingDigest: 'store-digest-aaaa',
    modelStoreCount: 8,
    ...overrides,
  };
}

/** A lease written as if by another process, without going through `acquire`. */
function plant(endpoint: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  const record = {
    lockFormatVersion: 1,
    nonce: 'plantedplantedplantedplanted0000',
    pid: 998_001,
    processType: 'desktop',
    command: 'Cernum · Campaigns screen',
    hostname: os.hostname(),
    campaignID: 'campaign:other',
    campaignName: 'the-other-one',
    endpoint: normalizeEndpoint(endpoint),
    endpointAsGiven: endpoint,
    modelStoreListingDigest: 'store-digest-bbbb',
    modelStoreCount: 8,
    acquiredAt: '2026-09-11T09:00:00Z',
    heartbeatAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    ...fields,
  };
  fs.mkdirSync(runtimeLeaseDirectory(root), { recursive: true });
  fs.writeFileSync(runtimeLeasePath(root, endpoint), JSON.stringify(record, null, 2) + '\n', 'utf8');
  return record;
}

describe('what counts as the same endpoint', () => {
  it('treats the spellings of one loopback server as one endpoint', () => {
    const forms = ['http://127.0.0.1:11434', 'http://localhost:11434', 'http://LOCALHOST:11434/', 'http://[::1]:11434'];
    const normalized = new Set(forms.map(normalizeEndpoint));
    expect([...normalized]).toEqual(['http://127.0.0.1:11434']);
    // And therefore one lease file, whichever form a caller typed.
    expect(new Set(forms.map((form) => runtimeLeasePath(root, form))).size).toBe(1);
  });

  it('keeps genuinely different servers apart', () => {
    expect(normalizeEndpoint('http://127.0.0.1:11434')).not.toBe(normalizeEndpoint('http://127.0.0.1:11435'));
    expect(normalizeEndpoint('http://127.0.0.1:11434')).not.toBe(normalizeEndpoint('http://10.0.0.4:11434'));
    expect(runtimeLeasePath(root, 'http://127.0.0.1:11434')).not.toBe(runtimeLeasePath(root, 'http://127.0.0.1:11435'));
  });

  it('does not put an endpoint into the path it leases under', () => {
    const nasty = 'http://127.0.0.1:11434/../../../etc';
    expect(path.dirname(runtimeLeasePath(root, nasty))).toBe(runtimeLeaseDirectory(root));
    expect(path.basename(runtimeLeasePath(root, nasty))).toMatch(/^[0-9a-f]{32}\.lease$/);
  });
});

describe('taking a runtime', () => {
  it('records who took it, for which campaign, and what it sees installed there', () => {
    const handle = acquireRuntimeLease(root, request(), QUIET);
    const written = JSON.parse(fs.readFileSync(runtimeLeasePath(root, ENDPOINT), 'utf8')) as Record<string, unknown>;
    expect(written.pid).toBe(process.pid);
    expect(written.processType).toBe('terminal');
    expect(written.hostname).toBe(os.hostname());
    expect(written.campaignID).toBe('campaign:alpha');
    expect(written.campaignName).toBe('alpha');
    expect(written.endpoint).toBe('http://127.0.0.1:11434');
    expect(written.modelStoreListingDigest).toBe('store-digest-aaaa');
    expect(written.modelStoreCount).toBe(8);
    expect(typeof written.acquiredAt).toBe('string');
    expect(typeof written.heartbeatAt).toBe('string');
    handle.release();
  });

  it('refuses a SECOND campaign on the same endpoint, naming the one that has it', () => {
    plant(ENDPOINT, { pid: 998_002 });
    const error = (() => {
      try { acquireRuntimeLease(root, request({ campaignName: 'beta', campaignID: 'campaign:beta' }), { ...QUIET, processIsAlive: () => true }); return undefined; }
      catch (caught) { return caught as RuntimeLeaseError; }
    })();
    expect(error).toBeInstanceOf(RuntimeLeaseError);
    expect(error!.code).toBe('heldByLiveOwner');
    expect(error!.endpoint).toBe('http://127.0.0.1:11434');
    expect(error!.message).toContain("campaign 'the-other-one'");
    expect(error!.message).toContain('desktop process 998002');
    expect(error!.message).toMatch(/take turns evicting each other's weights/);
    expect(error!.message).toMatch(/point this campaign at a different endpoint/);
  });

  it('refuses it however the second caller spelled the address', () => {
    plant('http://127.0.0.1:11434', { pid: 998_003 });
    expect(() => acquireRuntimeLease(root, request({ endpoint: 'http://localhost:11434/' }), { ...QUIET, processIsAlive: () => true }))
      .toThrow(RuntimeLeaseError);
  });

  it('lets campaigns on genuinely separate endpoints run at the same time', () => {
    const first = acquireRuntimeLease(root, request({ endpoint: 'http://127.0.0.1:11434', campaignName: 'alpha' }), QUIET);
    const second = acquireRuntimeLease(root, request({ endpoint: 'http://127.0.0.1:11435', campaignName: 'beta', campaignID: 'campaign:beta' }), QUIET);
    const third = acquireRuntimeLease(root, request({ endpoint: 'http://127.0.0.1:11436', campaignName: 'gamma', campaignID: 'campaign:gamma' }), QUIET);
    expect([first, second, third].every((handle) => !handle.isReleased)).toBe(true);
    expect(leasedEndpoints(root).map((lease) => lease.record?.endpoint).sort()).toEqual([
      'http://127.0.0.1:11434', 'http://127.0.0.1:11435', 'http://127.0.0.1:11436',
    ]);
    first.release(); second.release(); third.release();
  });

  it('lets exactly one of eight real processes take one endpoint', () => {
    fs.mkdirSync(runtimeLeaseDirectory(root), { recursive: true });
    const script = path.join(root, 'race.js');
    fs.writeFileSync(script, `
      const fs = require('node:fs');
      try { fs.closeSync(fs.openSync(process.argv[2], 'wx')); process.stdout.write('won'); }
      catch (error) { process.stdout.write(error.code === 'EEXIST' ? 'refused' : 'other:' + error.code); }
    `, 'utf8');
    const results = Array.from({ length: 8 }, () =>
      execFileSync(process.execPath, [script, runtimeLeasePath(root, ENDPOINT)], { encoding: 'utf8' }));
    expect(results.filter((r) => r === 'won')).toHaveLength(1);
    expect(results.filter((r) => r === 'refused')).toHaveLength(7);
  });
});

describe('recovering an endpoint after a crash', () => {
  it('reclaims a lease whose process is gone, and keeps the crashed campaign as evidence', () => {
    plant(ENDPOINT, { pid: 998_004, campaignName: 'crashed-campaign' });
    const handle = acquireRuntimeLease(root, request(), { ...QUIET, processIsAlive: () => false });
    expect(handle.recovered?.pid).toBe(998_004);
    expect(handle.record.pid).toBe(process.pid);

    const evidence = fs.readdirSync(path.join(runtimeLeaseDirectory(root), 'recovered'));
    expect(evidence).toHaveLength(1);
    const written = JSON.parse(fs.readFileSync(path.join(runtimeLeaseDirectory(root), 'recovered', evidence[0]), 'utf8')) as Record<string, any>;
    expect(written.endpoint).toBe('http://127.0.0.1:11434');
    expect(written.crashedOwner.campaignName).toBe('crashed-campaign');
    expect(written.recoveredBy.campaignName).toBe('alpha');
    expect(written.why).toMatch(/no longer exists/);
    expect(fs.readdirSync(runtimeLeaseDirectory(root)).filter((n) => n.includes('reclaiming'))).toHaveLength(0);
    handle.release();
  });

  it('does NOT reclaim an endpoint whose holder is alive but silent', () => {
    plant(ENDPOINT, { pid: 998_005, heartbeatAt: '2020-01-01T00:00:00Z' });
    const error = (() => {
      try { acquireRuntimeLease(root, request(), { ...QUIET, processIsAlive: () => true }); return undefined; }
      catch (caught) { return caught as RuntimeLeaseError; }
    })();
    expect(error!.code).toBe('ownerUnresponsive');
    expect(error!.message).toMatch(/will not guess/);
    expect(fs.existsSync(runtimeLeasePath(root, ENDPOINT))).toBe(true);
  });

  it('does NOT reclaim an endpoint leased from another machine', () => {
    plant(ENDPOINT, { hostname: 'some-other-machine.local' });
    const error = (() => {
      try { acquireRuntimeLease(root, request(), QUIET); return undefined; }
      catch (caught) { return caught as RuntimeLeaseError; }
    })();
    expect(error!.code).toBe('foreignHost');
    expect(fs.existsSync(runtimeLeasePath(root, ENDPOINT))).toBe(true);
  });

  it('refuses to break a live lease without being told to, and records a forced break', () => {
    plant(ENDPOINT, { pid: 998_006 });
    expect(() => breakRuntimeLease(root, ENDPOINT, 'testing', { ...QUIET, processIsAlive: () => true }))
      .toThrow(/Nothing was released/);
    expect(fs.existsSync(runtimeLeasePath(root, ENDPOINT))).toBe(true);

    breakRuntimeLease(root, ENDPOINT, 'the operator confirmed it is gone', { ...QUIET, processIsAlive: () => true, force: true });
    expect(fs.existsSync(runtimeLeasePath(root, ENDPOINT))).toBe(false);
    const released = fs.readdirSync(path.join(runtimeLeaseDirectory(root), 'recovered')).filter((n) => n.startsWith('released-'));
    expect(released).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(path.join(runtimeLeaseDirectory(root), 'recovered', released[0]), 'utf8')).forced).toBe(true);
  });

  it('says plainly when nothing holds an endpoint', () => {
    expect(inspectRuntimeLease(root, ENDPOINT).held).toBe(false);
    expect(inspectRuntimeLease(root, ENDPOINT).message).toContain('http://127.0.0.1:11434');
  });
});

// MARK: - Through a campaign

const SUITES = ['suite.model-lab.foundation'];

function configuration(overrides: Partial<CampaignConfiguration> = {}): CampaignConfiguration {
  return {
    label: 'leased campaign',
    suiteIDs: SUITES,
    repeatsPerCase: 1,
    candidates: [syntheticCandidate('alpha:1b')],
    hardware: SYNTHETIC_HARDWARE,
    runtimeVersion: 'synthetic-runtime-1.0',
    storeBaseline: SYNTHETIC_STORE_BASELINE,
    residencyDelayMilliseconds: 0,
    ...overrides,
  };
}

/** A deterministic host that nevertheless claims a runtime, so the lease path is exercised. */
class LeasingHost extends SyntheticHost {
  constructor(private readonly endpoint: string) {
    super({}, steppingClock(), Object.fromEntries(configuration().candidates.map((candidate) => [candidate.name, {
      name: candidate.name, modelID: candidate.modelID, runtimeDigest: candidate.runtimeDigest,
      parameterSize: candidate.parameterSize, quantization: candidate.quantization,
    }])));
  }
  async runtimeIdentity() {
    return { endpoint: this.endpoint, modelStoreListingDigest: 'store-digest-aaaa', modelStoreCount: 8 };
  }
}

describe('a campaign takes the runtime before it sends anything', () => {
  it('holds the endpoint for the run and gives it back at the end', async () => {
    const campaignRoot = path.join(root, 'campaigns');
    const directory = path.join(campaignRoot, 'alpha');
    const campaign = Campaign.create(directory, configuration(), new LeasingHost(ENDPOINT));
    expect(inspectRuntimeLease(campaignRoot, ENDPOINT).held).toBe(false);

    const status = await campaign.run({ campaignRootDirectory: campaignRoot });
    expect(status.state).toBe('complete');
    expect(inspectRuntimeLease(campaignRoot, ENDPOINT).held).toBe(false);

    const kinds = campaign.ledger.events().map((event) => String(event.kind));
    expect(kinds).toContain('runtimeLeaseAcquired');
    expect(kinds).toContain('runtimeLeaseReleased');
  });

  it('refuses a different campaign on the same endpoint BEFORE any inference', async () => {
    const campaignRoot = path.join(root, 'campaigns');
    const beta = Campaign.create(path.join(campaignRoot, 'beta'), configuration({ label: 'beta' }), new LeasingHost(ENDPOINT));
    fs.mkdirSync(runtimeLeaseDirectory(campaignRoot), { recursive: true });
    fs.writeFileSync(runtimeLeasePath(campaignRoot, ENDPOINT), JSON.stringify({
      lockFormatVersion: 1, nonce: 'n', pid: 998_007, processType: 'terminal', command: 'cernum run alpha',
      hostname: os.hostname(), campaignID: 'campaign:alpha', campaignName: 'alpha',
      endpoint: normalizeEndpoint(ENDPOINT), acquiredAt: '2026-09-11T09:00:00Z',
      heartbeatAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    }, null, 2), 'utf8');

    await expect(beta.run({ campaignRootDirectory: campaignRoot, lockOptions: { processIsAlive: () => true } }))
      .rejects.toThrow(RuntimeLeaseError);

    // Not one attempt was made, and the campaign's own lock was given back.
    expect(beta.ledger.reconcile().terminal).toBe(0);
    expect(beta.status().owner).toBeUndefined();
    const refusals = beta.ledger.events().filter((event) => event.kind === 'runtimeLeaseRefused');
    expect(refusals).toHaveLength(1);
    expect(refusals[0].heldByCampaign).toBe('alpha');
    expect(refusals[0].endpoint).toBe('http://127.0.0.1:11434');
  });

  it('runs two campaigns against two endpoints concurrently, and both complete', async () => {
    const campaignRoot = path.join(root, 'campaigns');
    const alpha = Campaign.create(path.join(campaignRoot, 'alpha'), configuration(), new LeasingHost('http://127.0.0.1:11434'));
    const beta = Campaign.create(path.join(campaignRoot, 'beta'), configuration(), new LeasingHost('http://127.0.0.1:11435'));
    const [a, b] = await Promise.all([
      alpha.run({ campaignRootDirectory: campaignRoot }),
      beta.run({ campaignRootDirectory: campaignRoot }),
    ]);
    expect(a.state).toBe('complete');
    expect(b.state).toBe('complete');
    expect(a.reconciliation.balances && b.reconciliation.balances).toBe(true);
  });

  it('reclaims an endpoint a crashed campaign left leased, and says so in the trace', async () => {
    const campaignRoot = path.join(root, 'campaigns');
    const campaign = Campaign.create(path.join(campaignRoot, 'alpha'), configuration(), new LeasingHost(ENDPOINT));
    fs.mkdirSync(runtimeLeaseDirectory(campaignRoot), { recursive: true });
    fs.writeFileSync(runtimeLeasePath(campaignRoot, ENDPOINT), JSON.stringify({
      lockFormatVersion: 1, nonce: 'n', pid: 998_008, processType: 'terminal', command: 'cernum run crashed',
      hostname: os.hostname(), campaignID: 'campaign:crashed', campaignName: 'crashed',
      endpoint: normalizeEndpoint(ENDPOINT), acquiredAt: '2026-09-11T09:00:00Z', heartbeatAt: '2026-09-11T09:00:00Z',
    }, null, 2), 'utf8');

    const status = await campaign.run({ campaignRootDirectory: campaignRoot, lockOptions: { processIsAlive: () => false } });
    expect(status.state).toBe('complete');
    const recovered = campaign.ledger.events().filter((event) => event.kind === 'runtimeLeaseRecovered');
    expect(recovered).toHaveLength(1);
    expect(recovered[0].crashedCampaign).toBe('crashed');
    expect(fs.readdirSync(path.join(runtimeLeaseDirectory(campaignRoot), 'recovered')).length).toBeGreaterThan(0);
    expect(inspectRuntimeLease(campaignRoot, ENDPOINT).held).toBe(false);
  });

  it('takes no lease at all for a host that reaches no runtime', async () => {
    const campaignRoot = path.join(root, 'campaigns');
    const host = new SyntheticHost({}, steppingClock(), Object.fromEntries(configuration().candidates.map((c) => [c.name, {
      name: c.name, modelID: c.modelID, runtimeDigest: c.runtimeDigest, parameterSize: c.parameterSize, quantization: c.quantization,
    }])));
    const campaign = Campaign.create(path.join(campaignRoot, 'synthetic'), configuration(), host);
    await campaign.run({ campaignRootDirectory: campaignRoot });
    expect(fs.existsSync(runtimeLeaseDirectory(campaignRoot))).toBe(false);
    expect(campaign.ledger.events().some((event) => event.kind === 'runtimeLeaseAcquired')).toBe(false);
  });
});
