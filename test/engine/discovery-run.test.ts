// Cernum · `discovery-run`, the one-shot discovery entry a scheduler calls.
//
// What is pinned here is what makes calling `refreshDiscovery` UNATTENDED safe: two runs never overlap
// and a refused one says why; the snapshot and change report land where `discovery-refresh` puts them;
// a provider that fails is a line in the summary rather than a crash; a run over an unchanged world
// says nothing changed; and `--json` is one line.
//
// NOTHING HERE CONTACTS A PROVIDER. Every probe is an injected fake. The one subprocess test is refused
// at the lock before any probe is built into a request, and its fake CLIs record any invocation so that
// an accidental one would fail the assertion that there were none.

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { COMMAND_SPECS, acceptedOptions, commandSpec } from '../../src/cli/command-spec';
import { DiscoveryProbe, RouteObservation } from '../../src/engine/discovery-refresh';
import {
  DISCOVERY_RUN_SUMMARY_SCHEMA, discoveryRunDirectory, discoveryRunRecordsDirectory, runDiscoveryOnce,
} from '../../src/engine/discovery-run';
import { acquireCampaignLock, campaignLockPath } from '../../src/engine/lock';
import { MachineFingerprint } from '../../src/engine/machine-availability';
import { latestDiscoverySnapshot, readObservationStore } from '../../src/engine/observation-store';
import { PROVIDER_IDS, ProviderID } from '../../src/engine/provider';
import { overrideProviderAllowlist } from '../../src/engine/provider-allowlist';

const temporaries: string[] = [];
afterEach(() => { for (const directory of temporaries.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
function temporary(prefix = 'cernum-discovery-run-'): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaries.push(directory);
  return directory;
}

const FINGERPRINT: MachineFingerprint = {
  hostname: 'fixture-mac', platform: 'darwin', architecture: 'arm64', cpuModel: 'fixture-cpu', cpuCount: 8,
  totalMemoryBytes: 16 * 1024 ** 3,
};
const MACHINE = { fingerprint: FINGERPRINT, key: 'cmk1:fixture' };
const FIRST = new Date('2026-10-17T09:00:00Z');
const SECOND = new Date('2026-10-17T10:00:00Z');
const QUIET = { heartbeatIntervalMilliseconds: 0 };
const COMMAND = 'cernum discovery-run (test)';

const local = (modelID: string, runtimeDigest = 'sha256:aaa'): RouteObservation => ({
  routeKey: `ollama:${modelID}`, provider: 'ollama', modelID, listed: true, availability: 'installedLocally',
  runtimeDigest, observedAt: '2026-10-17T08:00:00Z',
});
const hosted = (modelID: string): RouteObservation => ({
  routeKey: `opencodeCLI:${modelID}`, provider: 'opencodeCLI', modelID, listed: true, availability: 'unproven',
  observedAt: '2026-10-17T08:00:00Z',
});

/** A fake probe that answers with fixed routes and counts how often it was asked. */
function answering(routes: RouteObservation[]): DiscoveryProbe & { calls: number } {
  const probe = (async () => { probe.calls += 1; return { refreshed: true, detail: `listed ${routes.length}`, routes }; }) as
    DiscoveryProbe & { calls: number };
  probe.calls = 0;
  return probe;
}

// These tests pin the run wrapper, not the allowlist, and use opencodeCLI as a stand-in hosted
// provider; an override naming every declared provider keeps them about that. The default (cpa1) is
// pinned in provider-allowlist.test.ts.
const EVERY_PROVIDER = overrideProviderAllowlist(PROVIDER_IDS);

function run(root: string, probes: Partial<Record<ProviderID, DiscoveryProbe>>, now = FIRST) {
  return runDiscoveryOnce({ root, probes, machine: MACHINE, now, command: COMMAND, lockOptions: QUIET, allowlist: EVERY_PROVIDER });
}

describe('(1) two runs cannot overlap: the campaign lock is taken first', () => {
  it('refuses cleanly, with the lock\'s own reason recorded, and probes nothing while the lock is held', async () => {
    const root = temporary();
    const holder = acquireCampaignLock(discoveryRunDirectory(root), {
      processType: 'terminal', command: 'cernum discovery-run (the other run)', campaignID: 'discovery-run', campaignName: 'discovery-run',
    }, QUIET);
    const probe = answering([local('gemma3:4b')]);
    try {
      const outcome = await run(root, { ollama: probe });

      expect(outcome.summary.status).toBe('refusedLockHeld');
      expect(outcome.summary.reason).toMatch(/already held|already running/);
      expect(outcome.snapshot).toBeUndefined();
      expect(probe.calls).toBe(0);
      // Recorded, not just returned.
      expect(JSON.parse(fs.readFileSync(outcome.recordPath, 'utf8'))).toMatchObject({ status: 'refusedLockHeld' });
      expect(path.dirname(outcome.recordPath)).toBe(discoveryRunRecordsDirectory(root));
      // Nothing was written to the store, and the other run's lock is untouched.
      expect(readObservationStore(root).observations).toEqual([]);
      expect(JSON.parse(fs.readFileSync(campaignLockPath(discoveryRunDirectory(root)), 'utf8')).nonce).toBe(holder.record.nonce);
    } finally {
      holder.release();
    }
  });

  it('holds the lock while it runs and releases it afterwards, so the next run can take it', async () => {
    const root = temporary();
    const lockFile = campaignLockPath(discoveryRunDirectory(root));
    let heldDuringProbe = false;
    const probe: DiscoveryProbe = async () => {
      heldDuringProbe = fs.existsSync(lockFile);
      return { refreshed: true, detail: 'listed 1', routes: [local('gemma3:4b')] };
    };
    const outcome = await run(root, { ollama: probe });

    expect(outcome.summary.status).toBe('completed');
    expect(heldDuringProbe).toBe(true);
    expect(fs.existsSync(lockFile)).toBe(false);
    expect((await run(root, { ollama: probe }, SECOND)).summary.status).toBe('completed');
  });

  it('releases the lock even when persisting the result fails', async () => {
    const root = temporary();
    // A FILE where the observation store's directory must go, so the append throws.
    fs.writeFileSync(path.join(root, '.observations'), 'not a directory');
    await expect(run(root, { ollama: answering([local('gemma3:4b')]) })).rejects.toThrow();
    expect(fs.existsSync(campaignLockPath(discoveryRunDirectory(root)))).toBe(false);
  });
});

describe('(2) it runs refreshDiscovery once and saves where discovery-refresh saves', () => {
  it('asks each provider once and appends the snapshot and the change report to the observation store', async () => {
    const root = temporary();
    const ollama = answering([local('gemma3:4b')]);
    const first = await run(root, { ollama });
    expect(ollama.calls).toBe(1);
    expect(first.summary).toMatchObject({ status: 'completed', changed: true, routes: 1, providersAnswered: ['ollama'] });
    expect(first.summary.changes).toEqual([{ routeKey: 'ollama:gemma3:4b', kinds: ['newlyDiscovered'] }]);

    const stored = readObservationStore(root);
    expect(latestDiscoverySnapshot(stored, MACHINE.key)).toEqual(first.snapshot);
    expect(stored.observations.every((entry) => entry.origin === 'observedHere')).toBe(true);

    // A material change on the next run is saved as a delta record, as `discovery-refresh` saves it.
    const reweighted = answering([local('gemma3:4b', 'sha256:bbb')]);
    const second = await run(root, { ollama: reweighted }, SECOND);
    expect(second.summary.changes).toEqual([{ routeKey: 'ollama:gemma3:4b', kinds: ['runtimeDigestChanged'] }]);
    expect(second.summary.qualificationsNowStale).toBe(1);
    const deltas = readObservationStore(root).observations.filter((entry) => entry.record.kind === 'discoveryDelta');
    expect(deltas.map((entry) => entry.record.routeKey)).toEqual(['ollama:gemma3:4b']);
    expect(latestDiscoverySnapshot(readObservationStore(root), MACHINE.key)!.takenAt).toBe('2026-10-17T10:00:00Z');
  });
});

describe('(3) an unavailable or failing provider is recorded data, never a crash', () => {
  it('records a provider that threw and one that did not answer, and still completes the others', async () => {
    const root = temporary();
    const ollama = answering([local('gemma3:4b')]);
    const outcome = await run(root, {
      ollama,
      claudeCLI: async () => { throw new Error('spawn claude ENOENT'); },
      opencodeCLI: async () => ({ refreshed: false, detail: 'notInstalled: opencode is not on PATH', routes: [] }),
    });

    expect(outcome.summary.status).toBe('completed');
    expect(outcome.summary.providersAnswered).toEqual(['ollama']);
    expect(outcome.summary.providersNotAnswered).toEqual([
      { provider: 'claudeCLI', detail: 'the probe threw: spawn claude ENOENT' },
      { provider: 'opencodeCLI', detail: 'notInstalled: opencode is not on PATH' },
    ]);
    expect(outcome.snapshot!.routes.map((route) => route.routeKey)).toEqual(['ollama:gemma3:4b']);
    const providerRecords = readObservationStore(root).observations.filter((entry) => entry.record.kind === 'providerAvailability');
    expect(providerRecords.map((entry) => entry.record.provider).sort()).toEqual(['claudeCLI', 'ollama', 'opencodeCLI']);
  });

  it('never reads a failed provider as its models disappearing', async () => {
    const root = temporary();
    await run(root, { opencodeCLI: answering([hosted('glm-5')]) });
    const outcome = await run(root, { opencodeCLI: async () => { throw new Error('timed out'); } }, SECOND);

    expect(outcome.summary.status).toBe('completed');
    expect(outcome.summary.changed).toBe(false);
    expect(outcome.deltas!.map((delta) => delta.kinds)).toEqual([['notRefreshed']]);
    expect(outcome.snapshot!.routes).toEqual([hosted('glm-5')]);
  });
});

describe('(4) idempotent: a second run over an unchanged world records no change', () => {
  it('reports changed: false, writes no delta record, and keeps the snapshot it took', async () => {
    const root = temporary();
    const probes = { ollama: answering([local('gemma3:4b')]), opencodeCLI: answering([hosted('glm-5')]) };
    expect((await run(root, probes)).summary.changed).toBe(true);
    const deltasBefore = readObservationStore(root).observations.filter((entry) => entry.record.kind === 'discoveryDelta').length;

    const again = await run(root, probes, SECOND);
    expect(again.summary).toMatchObject({ status: 'completed', changed: false, changes: [], qualificationsNowStale: 0 });
    expect(again.deltas!.every((delta) => delta.kinds.length === 1 && delta.kinds[0] === 'noMaterialChange')).toBe(true);
    const after = readObservationStore(root).observations;
    expect(after.filter((entry) => entry.record.kind === 'discoveryDelta').length).toBe(deltasBefore);
    expect(latestDiscoverySnapshot(readObservationStore(root), MACHINE.key)!.routes).toEqual(again.snapshot!.routes);
  });
});

describe('(5) --json prints a one-line summary', () => {
  it('is registered beside discovery-refresh with --json, and its summary serialises to one line', async () => {
    const names = COMMAND_SPECS.map((spec) => spec.name);
    expect(names.indexOf('discovery-run')).toBe(names.indexOf('discovery-refresh') + 1);
    const spec = commandSpec('discovery-run')!;
    expect(spec.effect).toBe('invokesLocalTool');
    expect(acceptedOptions(spec).map((option) => option.name)).toContain('json');

    const root = temporary();
    const { summary } = await run(root, { ollama: answering([local('gemma3:4b')]) });
    const line = JSON.stringify(summary);
    expect(line).not.toContain('\n');
    expect(JSON.parse(line)).toMatchObject({
      schema: DISCOVERY_RUN_SUMMARY_SCHEMA, command: 'discovery-run', status: 'completed', machineKey: MACHINE.key, changed: true,
    });
  });

  it('prints exactly one JSON line from the real command, and exits 4 when another run holds the lock', () => {
    const root = temporary();
    const fakeBin = temporary('cernum-discovery-run-bin-');
    for (const name of ['claude', 'codex', 'opencode']) {
      fs.writeFileSync(path.join(fakeBin, name),
        `#!/bin/sh\necho "$@" >> ${JSON.stringify(path.join(fakeBin, `${name}.invocations`))}\nexit 1\n`, { mode: 0o755 });
    }
    // Held by THIS process, which the subprocess sees as a live owner on this host.
    const holder = acquireCampaignLock(discoveryRunDirectory(root), {
      processType: 'terminal', command: 'the test', campaignID: 'discovery-run', campaignName: 'discovery-run',
    }, QUIET);
    try {
      const result = spawnSync('npx', ['tsx', 'src/cli/cernum.ts', 'discovery-run', '--json', '--root', root,
        // A closed port, so even a probe that ran by mistake could reach no runtime.
        '--endpoint', 'http://127.0.0.1:9'], {
        cwd: path.resolve(__dirname, '..', '..'), encoding: 'utf8',
        env: { ...process.env, PATH: `${fakeBin}:${path.dirname(process.execPath)}:/usr/bin:/bin` },
      });
      expect(result.status, result.stderr).toBe(4);
      const lines = result.stdout.split('\n').filter((line) => line.length > 0);
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0])).toMatchObject({ command: 'discovery-run', status: 'refusedLockHeld' });
      for (const name of ['claude', 'codex', 'opencode']) expect(fs.existsSync(path.join(fakeBin, `${name}.invocations`))).toBe(false);
    } finally {
      holder.release();
    }
  }, 120_000);
});
