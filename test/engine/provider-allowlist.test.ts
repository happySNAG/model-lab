// Cernum · the versioned provider allowlist discovery consults before it contacts anything.
//
// What is pinned here: the default (cpa1) names exactly claudeCLI, anthropicAPI, codexCLI, openaiAPI
// and ollama, and not opencodeCLI; a provider not on the list is never probed and is recorded as
// refused with a reason naming the list's version; every snapshot carries that version; and an
// explicit override, passed in code, replaces the default.
//
// NOTHING HERE CONTACTS A PROVIDER. Every probe is an injected fake that counts its calls.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DiscoveryProbe, DiscoverySnapshot, RouteObservation, refreshDiscovery } from '../../src/engine/discovery-refresh';
import { runDiscoveryOnce } from '../../src/engine/discovery-run';
import { MachineFingerprint } from '../../src/engine/machine-availability';
import { latestDiscoverySnapshot, readObservationStore } from '../../src/engine/observation-store';
import { PROVIDER_IDS, ProviderID } from '../../src/engine/provider';
import {
  DEFAULT_PROVIDER_ALLOWLIST, PROVIDER_ALLOWLIST_VERSION, isProviderAllowed, overrideProviderAllowlist,
} from '../../src/engine/provider-allowlist';

const temporaries: string[] = [];
afterEach(() => { for (const directory of temporaries.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
function temporary(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cernum-provider-allowlist-'));
  temporaries.push(directory);
  return directory;
}

const FINGERPRINT: MachineFingerprint = {
  hostname: 'fixture-mac', platform: 'darwin', architecture: 'arm64', cpuModel: 'fixture-cpu', cpuCount: 8,
  totalMemoryBytes: 16 * 1024 ** 3,
};
const MACHINE = { fingerprint: FINGERPRINT, key: 'cmk1:fixture' };
const NOW = new Date('2026-10-17T09:00:00Z');
const LATER = new Date('2026-10-17T10:00:00Z');
const QUIET = { heartbeatIntervalMilliseconds: 0 };

const route = (provider: ProviderID, modelID: string): RouteObservation => ({
  routeKey: `${provider}:${modelID}`, provider, modelID, listed: true,
  availability: provider === 'ollama' ? 'installedLocally' : 'unproven', observedAt: '2026-10-17T08:00:00Z',
});

/** A fake probe that answers with one route and counts how often it was asked. */
function answering(provider: ProviderID, modelID = 'm'): DiscoveryProbe & { calls: number } {
  const probe = (async () => {
    probe.calls += 1;
    return { refreshed: true, detail: 'listed 1', routes: [route(provider, modelID)] };
  }) as DiscoveryProbe & { calls: number };
  probe.calls = 0;
  return probe;
}

/** One counting fake per declared provider: what the CLI hands the engine, since it builds them all. */
function everyProbe(): Record<ProviderID, DiscoveryProbe & { calls: number }> {
  return Object.fromEntries(PROVIDER_IDS.map((provider) => [provider, answering(provider)])) as
    Record<ProviderID, DiscoveryProbe & { calls: number }>;
}

describe('the default allowlist, cpa1', () => {
  it('names exactly claudeCLI, anthropicAPI, codexCLI, openaiAPI and ollama', () => {
    expect(PROVIDER_ALLOWLIST_VERSION).toBe('cpa1');
    expect(DEFAULT_PROVIDER_ALLOWLIST.version).toBe('cpa1');
    expect(DEFAULT_PROVIDER_ALLOWLIST.source).toBe('default');
    expect([...DEFAULT_PROVIDER_ALLOWLIST.providers].sort())
      .toEqual(['anthropicAPI', 'claudeCLI', 'codexCLI', 'ollama', 'openaiAPI']);
  });

  it('excludes opencodeCLI, and opencodeCLI is the only declared provider it excludes', () => {
    expect(isProviderAllowed(DEFAULT_PROVIDER_ALLOWLIST, 'opencodeCLI')).toBe(false);
    expect(PROVIDER_IDS.filter((provider) => !isProviderAllowed(DEFAULT_PROVIDER_ALLOWLIST, provider))).toEqual(['opencodeCLI']);
  });

  it('cannot be altered at run time', () => {
    expect(Object.isFrozen(DEFAULT_PROVIDER_ALLOWLIST)).toBe(true);
    expect(Object.isFrozen(DEFAULT_PROVIDER_ALLOWLIST.providers)).toBe(true);
  });
});

describe('discovery-refresh consults it: a provider not on the list is not contacted, and the refusal is recorded', () => {
  it('probes every allowlisted provider once and never calls the opencodeCLI probe', async () => {
    const probes = everyProbe();
    const { snapshot } = await refreshDiscovery({ probes, machineKey: MACHINE.key, now: NOW });

    expect(probes.opencodeCLI.calls).toBe(0);
    for (const provider of DEFAULT_PROVIDER_ALLOWLIST.providers) expect(probes[provider].calls).toBe(1);
    expect(snapshot.routes.map((entry) => entry.provider)).not.toContain('opencodeCLI');
    expect(snapshot.routes.map((entry) => entry.provider).sort()).toEqual([...DEFAULT_PROVIDER_ALLOWLIST.providers].sort());
  });

  it('records opencodeCLI as refused, with a reason naming the allowlist version', async () => {
    const { snapshot } = await refreshDiscovery({ probes: everyProbe(), machineKey: MACHINE.key, now: NOW });
    const refused = snapshot.providers.find((entry) => entry.provider === 'opencodeCLI')!;

    expect(refused).toBeDefined();
    expect(refused.refreshed).toBe(false);
    expect(refused.refusedByAllowlist).toBe('cpa1');
    expect(refused.detail).toMatch(/^refused: /);
    expect(refused.detail).toContain('provider allowlist cpa1');
    expect(refused.detail).toContain('not contacted');
    // Only the refused provider carries a refusal.
    expect(snapshot.providers.filter((entry) => entry.refusedByAllowlist !== undefined).map((entry) => entry.provider))
      .toEqual(['opencodeCLI']);
  });

  it('carries a refused provider\'s earlier routes forward untouched, as not refreshed, never as disappeared', async () => {
    const previous: DiscoverySnapshot = {
      schema: 'cds1', machineKey: MACHINE.key, takenAt: '2026-10-16T09:00:00Z',
      providers: [{ provider: 'opencodeCLI', refreshed: true, detail: 'listed 1' }],
      routes: [route('opencodeCLI', 'opencode/big-pickle')],
    };
    const probe = answering('opencodeCLI', 'opencode/other');
    const { snapshot, deltas } = await refreshDiscovery({ previous, probes: { opencodeCLI: probe }, machineKey: MACHINE.key, now: NOW });

    expect(probe.calls).toBe(0);
    expect(snapshot.routes).toEqual(previous.routes);
    expect(deltas).toHaveLength(1);
    expect(deltas[0].kinds).toEqual(['notRefreshed']);
    expect(deltas[0].qualificationNowStale).toBe(false);
    expect(deltas[0].detail.join(' ')).toContain('provider allowlist cpa1');
  });
});

describe('the allowlist version is recorded on every snapshot', () => {
  it('stamps cpa1 by default, including on a refresh that probed nothing', async () => {
    expect((await refreshDiscovery({ probes: everyProbe(), machineKey: MACHINE.key, now: NOW })).snapshot.providerAllowlist).toBe('cpa1');
    expect((await refreshDiscovery({ probes: {}, machineKey: MACHINE.key, now: NOW })).snapshot.providerAllowlist).toBe('cpa1');
  });

  it('stamps the override\'s own version when one is passed', async () => {
    const allowlist = overrideProviderAllowlist(['ollama']);
    const { snapshot } = await refreshDiscovery({ probes: everyProbe(), machineKey: MACHINE.key, now: NOW, allowlist });
    expect(snapshot.providerAllowlist).toBe(allowlist.version);
    expect(snapshot.providerAllowlist).not.toBe('cpa1');
  });

  it('discovery-run persists the stamped snapshot and reports refusals apart from providers that did not answer', async () => {
    const root = temporary();
    const probes = everyProbe();
    probes.claudeCLI = Object.assign(async () => ({ refreshed: false, detail: 'notInstalled: claude is not on PATH', routes: [] }),
      { calls: 0 });
    const outcome = await runDiscoveryOnce({ root, probes, machine: MACHINE, now: NOW, command: 'test', lockOptions: QUIET });

    expect(probes.opencodeCLI.calls).toBe(0);
    expect(outcome.summary.status).toBe('completed');
    expect(outcome.summary.providerAllowlist).toBe('cpa1');
    expect(outcome.summary.providersRefused).toEqual([
      { provider: 'opencodeCLI', reason: expect.stringContaining('provider allowlist cpa1') },
    ]);
    expect(outcome.summary.providersNotAnswered).toEqual([{ provider: 'claudeCLI', detail: 'notInstalled: claude is not on PATH' }]);
    expect(outcome.summary.providersAnswered).not.toContain('opencodeCLI');

    const stored = readObservationStore(root);
    const snapshot = latestDiscoverySnapshot(stored, MACHINE.key)!;
    expect(snapshot.providerAllowlist).toBe('cpa1');
    expect(snapshot.providers.find((entry) => entry.provider === 'opencodeCLI')?.refusedByAllowlist).toBe('cpa1');
    // Nothing was asked of the refused provider, so no answer of its is written down.
    const availability = stored.observations.filter((entry) => entry.record.kind === 'providerAvailability');
    expect(availability.map((entry) => entry.record.provider)).not.toContain('opencodeCLI');
    expect(stored.observations.some((entry) => entry.record.routeKey?.startsWith('opencodeCLI:'))).toBe(false);

    // A second run is stamped too.
    const again = await runDiscoveryOnce({ root, probes, machine: MACHINE, now: LATER, command: 'test', lockOptions: QUIET });
    expect(again.snapshot!.providerAllowlist).toBe('cpa1');
    expect(probes.opencodeCLI.calls).toBe(0);
  });
});

describe('an explicit override, passed programmatically, replaces the default', () => {
  it('can allow opencodeCLI, which is then probed and not refused', async () => {
    const allowlist = overrideProviderAllowlist([...DEFAULT_PROVIDER_ALLOWLIST.providers, 'opencodeCLI']);
    const probes = everyProbe();
    const { snapshot } = await refreshDiscovery({ probes, machineKey: MACHINE.key, now: NOW, allowlist });

    expect(allowlist.source).toBe('override');
    expect(probes.opencodeCLI.calls).toBe(1);
    expect(snapshot.providers.every((entry) => entry.refreshed && entry.refusedByAllowlist === undefined)).toBe(true);
    expect(snapshot.routes.map((entry) => entry.routeKey)).toContain('opencodeCLI:m');
  });

  it('can narrow the list, refusing a provider the default allows, with the override\'s version in the reason', async () => {
    const allowlist = overrideProviderAllowlist(['ollama', 'claudeCLI', 'ollama']);
    expect(allowlist.providers).toEqual(['claudeCLI', 'ollama']);
    expect(allowlist.version).toBe('cpa1-override[claudeCLI,ollama]');

    const probes = everyProbe();
    const outcome = await runDiscoveryOnce({
      root: temporary(), probes, machine: MACHINE, now: NOW, command: 'test', lockOptions: QUIET, allowlist,
    });
    expect(probes.ollama.calls).toBe(1);
    expect(probes.claudeCLI.calls).toBe(1);
    for (const provider of ['anthropicAPI', 'codexCLI', 'openaiAPI', 'opencodeCLI'] as ProviderID[]) {
      expect(probes[provider].calls).toBe(0);
    }
    expect(outcome.summary.providerAllowlist).toBe(allowlist.version);
    expect(outcome.summary.providersRefused!.map((entry) => entry.provider)).toEqual(['anthropicAPI', 'codexCLI', 'openaiAPI', 'opencodeCLI']);
    for (const entry of outcome.summary.providersRefused!) expect(entry.reason).toContain(allowlist.version);
  });

  it('refuses to build an override naming a provider that is not declared', () => {
    expect(() => overrideProviderAllowlist(['ollama', 'mysteryCLI' as ProviderID])).toThrow(/mysteryCLI.*not a declared provider/);
  });
});
