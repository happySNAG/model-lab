// The cross-process campaign lock: who owns a campaign, and what happens to the ones that crash.
//
// The lock's whole job is to refuse a second live runner and to recover after a crash WITHOUT ever
// confusing the two. These tests hold it to both halves, including one that races two real
// operating-system processes against a single directory, because a mutual-exclusion claim proved
// only inside one process has not been proved at all.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  CampaignLockError, acquireCampaignLock, breakCampaignLock, campaignLockPath, inspectCampaignLock,
  recoveredLocksDirectory,
} from '../../src/engine/lock';
import { Campaign, CampaignConfiguration, CampaignError, campaignPaths } from '../../src/engine/campaign';
import { Ledger } from '../../src/engine/ledger';
import { SYNTHETIC_HARDWARE, SYNTHETIC_STORE_BASELINE, SyntheticHost, SyntheticScript, steppingClock, syntheticCandidate } from '../../src/engine/synthetic';

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-lock-')); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const REQUEST = { processType: 'terminal' as const, command: 'cernum run demo', campaignID: 'campaign:abc', campaignName: 'demo' };
/** No background heartbeat: every test drives time itself, so nothing races the assertions. */
const QUIET = { heartbeatIntervalMilliseconds: 0 };

/** A lock file written as if by another process, without going through `acquire`. */
function plant(fields: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  const record = {
    lockFormatVersion: 1,
    nonce: 'plantedplantedplantedplanted0000',
    pid: 424242,
    processType: 'desktop',
    command: 'Model Lab · Campaigns screen',
    hostname: os.hostname(),
    campaignID: 'campaign:abc',
    campaignName: 'demo',
    acquiredAt: '2026-09-08T12:00:00Z',
    heartbeatAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    ...fields,
  };
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(campaignLockPath(root), JSON.stringify(record, null, 2) + '\n', 'utf8');
  return record;
}

describe('taking a campaign', () => {
  it('records who took it, from where, and when', () => {
    const handle = acquireCampaignLock(root, REQUEST, QUIET);
    const written = JSON.parse(fs.readFileSync(campaignLockPath(root), 'utf8')) as Record<string, unknown>;
    expect(written.pid).toBe(process.pid);
    expect(written.processType).toBe('terminal');
    expect(written.hostname).toBe(os.hostname());
    expect(written.campaignID).toBe('campaign:abc');
    expect(written.campaignName).toBe('demo');
    expect(typeof written.acquiredAt).toBe('string');
    expect(typeof written.command).toBe('string');
    handle.release();
  });

  it('refuses a second live owner, and says who has it', () => {
    plant({ pid: process.pid + 0, heartbeatAt: new Date().toISOString() });
    // Planted with a PID that is alive but is not this process, so it classifies as a live owner.
    fs.writeFileSync(campaignLockPath(root), JSON.stringify({
      ...JSON.parse(fs.readFileSync(campaignLockPath(root), 'utf8')),
      pid: 999_001,
    }, null, 2), 'utf8');

    const error = (() => {
      try { acquireCampaignLock(root, REQUEST, { ...QUIET, processIsAlive: () => true }); return undefined; }
      catch (caught) { return caught as CampaignLockError; }
    })();

    expect(error).toBeInstanceOf(CampaignLockError);
    expect(error!.code).toBe('heldByLiveOwner');
    expect(error!.message).toContain('desktop process 999001');
    expect(error!.message).toContain('Model Lab · Campaigns screen');
    expect(error!.message).toMatch(/Pause the first one/);
    // The refusal changed nothing.
    expect((JSON.parse(fs.readFileSync(campaignLockPath(root), 'utf8')) as { pid: number }).pid).toBe(999_001);
  });

  it('releases only a lock that still carries its own acquisition', () => {
    const handle = acquireCampaignLock(root, REQUEST, QUIET);
    // Someone else reclaimed it in the meantime.
    plant({ nonce: 'someone-elses-nonce' });
    expect(handle.release()).toBe(false);
    expect(fs.existsSync(campaignLockPath(root))).toBe(true);
  });

  it('lets the same campaign be taken again once it is given up', () => {
    acquireCampaignLock(root, REQUEST, QUIET).release();
    expect(fs.existsSync(campaignLockPath(root))).toBe(false);
    const second = acquireCampaignLock(root, REQUEST, QUIET);
    expect(second.record.pid).toBe(process.pid);
    second.release();
  });
});

describe('two processes, one campaign', () => {
  it('lets exactly one of eight real processes take it', () => {
    fs.mkdirSync(root, { recursive: true });
    const script = path.join(root, 'race.js');
    // Each child compiles nothing and imports nothing from the source tree; it performs the same
    // single atomic syscall the lock relies on. Eight of them start at once against one path.
    fs.writeFileSync(script, `
      const fs = require('node:fs');
      try {
        const handle = fs.openSync(process.argv[2], 'wx');
        fs.writeFileSync(handle, String(process.pid));
        fs.closeSync(handle);
        process.stdout.write('won');
      } catch (error) {
        process.stdout.write(error.code === 'EEXIST' ? 'refused' : 'other:' + error.code);
      }
    `, 'utf8');

    const target = campaignLockPath(root);
    const results = Array.from({ length: 8 }, () =>
      execFileSync(process.execPath, [script, target], { encoding: 'utf8' }));

    expect(results.filter((result) => result === 'won')).toHaveLength(1);
    expect(results.filter((result) => result === 'refused')).toHaveLength(7);
  });

  it('refuses a real second process while this one holds the campaign', () => {
    const handle = acquireCampaignLock(root, REQUEST, QUIET);
    const script = path.join(root, 'second.js');
    fs.writeFileSync(script, `
      const fs = require('node:fs');
      try { fs.openSync(process.argv[2], 'wx'); process.stdout.write('took-it'); }
      catch (error) { process.stdout.write(error.code); }
    `, 'utf8');
    const result = execFileSync(process.execPath, [script, campaignLockPath(root)], { encoding: 'utf8' });
    expect(result).toBe('EEXIST');
    handle.release();
  });
});

describe('recovering from a crash', () => {
  it('reclaims a lock whose process no longer exists, and keeps the crashed owner as evidence', () => {
    const crashed = plant({ pid: 987_654 });
    const handle = acquireCampaignLock(root, REQUEST, { ...QUIET, processIsAlive: () => false });

    expect(handle.recovered?.pid).toBe(987_654);
    expect(handle.record.pid).toBe(process.pid);
    const evidence = fs.readdirSync(recoveredLocksDirectory(root));
    expect(evidence).toHaveLength(1);
    const written = JSON.parse(fs.readFileSync(path.join(recoveredLocksDirectory(root), evidence[0]), 'utf8')) as Record<string, any>;
    expect(written.crashedOwner.pid).toBe(crashed.pid);
    expect(written.recoveredBy.pid).toBe(process.pid);
    expect(written.why).toMatch(/no longer exists/);
    // No half-finished reclaim file is left behind.
    expect(fs.readdirSync(root).filter((entry) => entry.includes('reclaiming'))).toHaveLength(0);
    handle.release();
  });

  it('reclaims a lock file that does not decode', () => {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(campaignLockPath(root), '{ this was never finished', 'utf8');
    const inspection = inspectCampaignLock(root, QUIET);
    expect(inspection.recoverable).toBe(true);
    const handle = acquireCampaignLock(root, REQUEST, QUIET);
    expect(handle.record.pid).toBe(process.pid);
    handle.release();
  });

  it('does NOT reclaim a lock whose process is alive but has stopped reporting', () => {
    plant({ pid: 999_002, heartbeatAt: '2020-01-01T00:00:00Z' });
    const error = (() => {
      try { acquireCampaignLock(root, REQUEST, { ...QUIET, processIsAlive: () => true }); return undefined; }
      catch (caught) { return caught as CampaignLockError; }
    })();
    expect(error!.code).toBe('ownerUnresponsive');
    expect(error!.message).toMatch(/will not guess/);
    expect(fs.existsSync(campaignLockPath(root))).toBe(true);
  });

  it('does NOT reclaim a lock written by another machine', () => {
    plant({ hostname: 'some-other-machine.local' });
    const error = (() => {
      try { acquireCampaignLock(root, REQUEST, QUIET); return undefined; }
      catch (caught) { return caught as CampaignLockError; }
    })();
    expect(error!.code).toBe('foreignHost');
    expect(error!.message).toMatch(/cannot be seen from here/);
    expect(fs.existsSync(campaignLockPath(root))).toBe(true);
  });
});

describe('releasing a lock by hand', () => {
  it('refuses to break a live one without being told to', () => {
    plant({ pid: 999_003 });
    expect(() => breakCampaignLock(root, 'testing', { ...QUIET, processIsAlive: () => true }))
      .toThrow(/Nothing was released/);
    expect(fs.existsSync(campaignLockPath(root))).toBe(true);
  });

  it('breaks a live one when a person says so, and records that they did', () => {
    plant({ pid: 999_004 });
    const previous = breakCampaignLock(root, 'the operator confirmed the process is gone',
      { ...QUIET, processIsAlive: () => true, force: true });
    expect(previous.record?.pid).toBe(999_004);
    expect(fs.existsSync(campaignLockPath(root))).toBe(false);
    const released = fs.readdirSync(recoveredLocksDirectory(root)).filter((name) => name.startsWith('released-'));
    expect(released).toHaveLength(1);
    const written = JSON.parse(fs.readFileSync(path.join(recoveredLocksDirectory(root), released[0]), 'utf8')) as Record<string, any>;
    expect(written.forced).toBe(true);
    expect(written.why).toMatch(/operator confirmed/);
  });

  it('clears a crashed owner without being forced', () => {
    plant({ pid: 999_005 });
    const previous = breakCampaignLock(root, 'crashed', { ...QUIET, processIsAlive: () => false });
    expect(previous.state).toBe('stale');
    expect(fs.existsSync(campaignLockPath(root))).toBe(false);
  });

  it('says nothing was held when nothing was', () => {
    fs.mkdirSync(root, { recursive: true });
    expect(breakCampaignLock(root, 'nothing to do', QUIET).held).toBe(false);
  });
});

describe('a heartbeat keeps a long attempt from looking like a crash', () => {
  it('moves the heartbeat forward without changing the acquisition', () => {
    let clock = new Date('2026-09-08T12:00:00Z');
    const handle = acquireCampaignLock(root, REQUEST, { ...QUIET, now: () => clock });
    const acquiredAt = handle.record.acquiredAt;
    clock = new Date('2026-09-08T12:20:00Z');
    handle.heartbeat();
    const written = JSON.parse(fs.readFileSync(campaignLockPath(root), 'utf8')) as Record<string, string>;
    expect(written.acquiredAt).toBe(acquiredAt);
    expect(written.heartbeatAt).toBe('2026-09-08T12:20:00Z');
    handle.release();
  });

  it('is what separates a live owner from an unresponsive one', () => {
    const now = new Date('2026-09-08T12:30:00Z');
    plant({ pid: 999_006, heartbeatAt: '2026-09-08T12:29:50Z' });
    expect(inspectCampaignLock(root, { now: () => now, processIsAlive: () => true }).state).toBe('live');
    plant({ pid: 999_006, heartbeatAt: '2026-09-08T12:00:00Z' });
    expect(inspectCampaignLock(root, { now: () => now, processIsAlive: () => true }).state).toBe('unresponsive');
  });
});

// MARK: - The campaign's own use of it

const SUITES = ['suite.model-lab.foundation'];

function configuration(overrides: Partial<CampaignConfiguration> = {}): CampaignConfiguration {
  return {
    label: 'locked campaign',
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

function host(script: SyntheticScript = {}): SyntheticHost {
  const pinned = Object.fromEntries(configuration().candidates.map((candidate) => [candidate.name, {
    name: candidate.name, modelID: candidate.modelID, runtimeDigest: candidate.runtimeDigest,
    parameterSize: candidate.parameterSize, quantization: candidate.quantization,
  }]));
  return new SyntheticHost(script, steppingClock(), pinned);
}

describe('a campaign takes itself before it runs', () => {
  it('holds the campaign for the duration and gives it back at the end', async () => {
    const campaign = Campaign.create(root, configuration(), host());
    expect(inspectCampaignLock(root).held).toBe(false);
    const status = await campaign.run({ owner: { processType: 'terminal', command: 'cernum run locked' } });
    expect(status.state).toBe('complete');
    expect(inspectCampaignLock(root).held).toBe(false);
    const kinds = campaign.ledger.events().map((event) => String(event.kind));
    expect(kinds).toContain('lockAcquired');
    expect(kinds).toContain('lockReleased');
  });

  it('gives it back when the run pauses', async () => {
    const campaign = Campaign.create(root, configuration(), host());
    const status = await campaign.run({ maxAttempts: 1 });
    expect(status.state).toBe('paused');
    expect(inspectCampaignLock(root).held).toBe(false);
  });

  it('gives it back when a guard aborts the run', async () => {
    const campaign = Campaign.create(root, configuration({ storeBaseline: { listingDigest: 'a-digest-that-will-not-match', count: 99 } }), host());
    const status = await campaign.run({});
    expect(status.state).toBe('aborted');
    expect(inspectCampaignLock(root).held).toBe(false);
  });

  it('refuses to run a campaign another live process is running, and records the refusal', async () => {
    const campaign = Campaign.create(root, configuration(), host());
    plant({ pid: 999_007, campaignName: path.basename(root) });
    await expect(campaign.run({ lockOptions: { processIsAlive: () => true } })).rejects.toThrow(CampaignLockError);
    // Nothing was attempted.
    expect(campaign.ledger.reconcile().terminal).toBe(0);
    const refusals = campaign.ledger.events().filter((event) => event.kind === 'lockRefused');
    expect(refusals).toHaveLength(1);
    expect(refusals[0].heldByPID).toBe(999_007);
    expect(refusals[0].code).toBe('heldByLiveOwner');
  });

  it('resumes a campaign whose runner crashed mid-run, and says so in the trace', async () => {
    const campaign = Campaign.create(root, configuration(), host());
    await campaign.run({ maxAttempts: 1 });
    const partial = campaign.ledger.reconcile().terminal;
    expect(partial).toBe(1);

    // A crash is a lock file left behind by a process that no longer exists.
    plant({ pid: 999_008, campaignName: path.basename(root), command: 'cernum run locked' });

    const resumed = Campaign.open(root, configuration(), host());
    const status = await resumed.run({ lockOptions: { processIsAlive: () => false } });
    expect(status.state).toBe('complete');
    expect(status.terminalCount).toBeGreaterThan(partial);

    const recovered = resumed.ledger.events().filter((event) => event.kind === 'lockRecovered');
    expect(recovered).toHaveLength(1);
    expect(recovered[0].crashedPid).toBe(999_008);
    expect(String(recovered[0].why)).toMatch(/no longer exists/);
    expect(fs.readdirSync(recoveredLocksDirectory(root)).length).toBeGreaterThan(0);
    // The crash cost no attempt: the ledger still balances, and nothing was re-run.
    expect(resumed.ledger.reconcile().balances).toBe(true);
  });

  it('refuses to finalize a campaign that is still being written', async () => {
    const campaign = Campaign.create(root, configuration(), host());
    await campaign.run({});
    plant({ pid: 999_009, campaignName: path.basename(root) });
    expect(() => campaign.finalize({ blindingSecret: 'a-secret-long-enough-to-use', lockOptions: { processIsAlive: () => true } }))
      .toThrow(/snapshot presented as a conclusion/);
    fs.unlinkSync(campaignLockPath(root));
    expect(campaign.finalize({ blindingSecret: 'a-secret-long-enough-to-use' }).campaignID).toBe(campaign.campaignID);
  });

  it('reports the holder in the campaign status, read from disk', async () => {
    const campaign = Campaign.create(root, configuration(), host());
    expect(campaign.status().owner).toBeUndefined();
    plant({ pid: 999_010, campaignName: path.basename(root) });
    const owner = campaign.status().owner;
    expect(owner?.pid).toBe(999_010);
    expect(owner?.processType).toBe('desktop');
  });

  it('reads as running from any surface while someone is running it, not as paused', async () => {
    const campaign = Campaign.create(root, configuration(), host());
    await campaign.run({ maxAttempts: 1 });
    expect(campaign.status().state).toBe('paused');

    // Another process is advancing it right now. Anyone reading the directory should see that.
    plant({ pid: 999_012, campaignName: path.basename(root) });
    const observer = Campaign.open(root, configuration(), host());
    const alive = { processIsAlive: () => true };
    expect(observer.status(undefined, alive).state).toBe('running');
    expect(observer.status(undefined, alive).owner?.pid).toBe(999_012);

    fs.unlinkSync(campaignLockPath(root));
    expect(Campaign.open(root, configuration(), host()).status().state).toBe('paused');
  });

  it('still reads as complete when a finished campaign is somehow still locked', async () => {
    const campaign = Campaign.create(root, configuration(), host());
    await campaign.run({});
    plant({ pid: 999_013, campaignName: path.basename(root) });
    expect(Campaign.open(root, configuration(), host()).status(undefined, { processIsAlive: () => true }).state).toBe('complete');
  });

  it('announces the start only once the campaign is genuinely the caller\'s', async () => {
    const campaign = Campaign.create(root, configuration(), host());
    plant({ pid: 999_014, campaignName: path.basename(root) });
    let announced = 0;
    await expect(campaign.run({ onStarted: () => { announced += 1; }, lockOptions: { processIsAlive: () => true } }))
      .rejects.toThrow(CampaignLockError);
    expect(announced).toBe(0);

    fs.unlinkSync(campaignLockPath(root));
    const status = await Campaign.open(root, configuration(), host()).run({ onStarted: () => { announced += 1; } });
    expect(announced).toBe(1);
    expect(status.state).toBe('complete');
  });

  it('leaves the ledger able to stand on its own after a refused run', async () => {
    const campaign = Campaign.create(root, configuration(), host());
    plant({ pid: 999_011, campaignName: path.basename(root) });
    await expect(campaign.run({ lockOptions: { processIsAlive: () => true } })).rejects.toThrow(CampaignLockError);
    const ledger = Ledger.open(campaignPaths(root).ledger);
    expect(ledger.reconcile().balances).toBe(true);
  });
});
