// Cernum · a ROUTE-SCOPED discovery refresh: `refreshDiscovery({ routeScope })` and
// `discovery-refresh <provider> --route <routeKey>`.
//
// What is pinned here is that a scope changes WHICH routes a refresh re-observes and never what an
// observation says. A scoped route is recorded from the provider's own probe answer exactly as an
// unscoped refresh would record it; every route outside the scope was not looked at, so it is carried
// forward untouched and reported `notRefreshed`, never `disappeared`. Without a scope nothing differs.
//
// NOTHING HERE CONTACTS A PROVIDER. Every engine probe is an injected fake. The subprocess tests are
// refused before any probe is built, and their fake CLIs record any invocation so that an accidental one
// would fail the assertion that there were none.

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acceptedOptions, commandSpec } from '../../src/cli/command-spec';
import {
  DiscoveryProbe, DiscoverySnapshot, RouteObservation, refreshDiscovery, routeFreshness,
} from '../../src/engine/discovery-refresh';
import { discoveryRefreshRecords } from '../../src/engine/discovery-run';
import { MachineFingerprint } from '../../src/engine/machine-availability';
import {
  appendObservations, latestDiscoverySnapshot, observationStorePath, readObservationStore,
} from '../../src/engine/observation-store';
import { availabilityFromStore } from '../../src/engine/routing-contract';

const temporaries: string[] = [];
afterEach(() => { for (const directory of temporaries.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
function temporary(prefix = 'cernum-discovery-route-'): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaries.push(directory);
  return directory;
}

const FINGERPRINT: MachineFingerprint = {
  hostname: 'fixture-mac', platform: 'darwin', architecture: 'arm64', cpuModel: 'fixture-cpu', cpuCount: 8,
  totalMemoryBytes: 16 * 1024 ** 3,
};
const MACHINE = { fingerprint: FINGERPRINT, key: 'cmk1:fixture' };
const T0 = new Date('2026-10-28T09:00:00Z');
const T1 = new Date('2026-10-28T10:00:00Z');
const AT = (when: Date) => when.toISOString().replace(/\.\d{3}Z$/, 'Z');
const A = 'claudeCLI:fixture-model-a';
const B = 'claudeCLI:fixture-model-b';

const claude = (routeKey: string, observedAt: string, extra: Partial<RouteObservation> = {}): RouteObservation => ({
  routeKey, provider: 'claudeCLI', modelID: routeKey.slice('claudeCLI:'.length), listed: true, availability: 'unproven',
  runtimeVersion: '2.1.0', observedAt, ...extra,
});

/** The fixture previous snapshot: claudeCLI routes A and B, both observed at T0. */
function previousSnapshot(): DiscoverySnapshot {
  return {
    schema: 'cds1', machineKey: MACHINE.key, takenAt: AT(T0), providerAllowlist: 'cpa1',
    providers: [{ provider: 'claudeCLI', refreshed: true, detail: 'available: fixture listing' }],
    routes: [claude(A, AT(T0)), claude(B, AT(T0), { contextWindowTokens: 200_000 })],
  };
}

/** A fake probe that answers with fixed routes and counts how often it was asked. */
function answering(routes: RouteObservation[]): DiscoveryProbe & { calls: number } {
  const probe = (async () => { probe.calls += 1; return { refreshed: true, detail: `listed ${routes.length}`, routes }; }) as
    DiscoveryProbe & { calls: number };
  probe.calls = 0;
  return probe;
}

describe('(1) a scoped refresh re-observes the scoped route and leaves every other route untouched', () => {
  it('records A at T1 and carries B forward exactly as it was, with a notRefreshed delta naming the scope', async () => {
    const previous = previousSnapshot();
    const before = structuredClone(previous.routes.find((route) => route.routeKey === B)!);
    // The provider's real answer names BOTH routes at T1; the scope decides that only A is taken from it.
    const probe = answering([claude(A, AT(T1)), claude(B, AT(T1), { contextWindowTokens: 1_000_000 })]);
    const { snapshot, deltas } = await refreshDiscovery({
      previous, probes: { claudeCLI: probe }, machineKey: MACHINE.key, now: T1, routeScope: { claudeCLI: [A] },
    });

    expect(probe.calls).toBe(1);
    expect(snapshot.providers).toEqual([{
      provider: 'claudeCLI', refreshed: true, detail: 'listed 2', routeScope: [A],
    }]);
    expect(snapshot.routes.find((route) => route.routeKey === A)).toEqual(claude(A, AT(T1)));
    // UNTOUCHED: the same listed flag, observedAt T0 and every other field as before.
    expect(snapshot.routes.find((route) => route.routeKey === B)).toEqual(before);

    const deltaB = deltas.find((delta) => delta.routeKey === B)!;
    expect(deltaB.kinds).toEqual(['notRefreshed']);
    expect(deltaB.qualificationNowStale).toBe(false);
    expect(deltaB.after).toEqual(before);
    expect(deltaB.detail.join(' ')).toContain(`scoped to route ${A}`);
    expect(deltaB.kinds).not.toContain('disappeared');
    expect(deltaB.kinds).not.toContain('returned');
    expect(deltaB.kinds).not.toContain('contextChanged');
    expect(deltas.find((delta) => delta.routeKey === A)!.kinds).toEqual(['noMaterialChange']);

    // B is neither unavailable nor gone in the snapshot's own freshness reading.
    expect(routeFreshness(snapshot, B, T1).state).toBe('currentlyDiscovered');
  });

  it('records a scoped route the probe did not name exactly as an unscoped refresh would: disappeared', async () => {
    // The provider answered and named only B.
    const scoped = await refreshDiscovery({
      previous: previousSnapshot(), probes: { claudeCLI: answering([claude(B, AT(T1))]) }, machineKey: MACHINE.key, now: T1,
      routeScope: { claudeCLI: [A] },
    });
    const unscoped = await refreshDiscovery({
      previous: previousSnapshot(), probes: { claudeCLI: answering([claude(B, AT(T1))]) }, machineKey: MACHINE.key, now: T1,
    });

    const routeA = (result: typeof scoped) => result.snapshot.routes.find((route) => route.routeKey === A);
    const deltaA = (result: typeof scoped) => result.deltas.find((delta) => delta.routeKey === A);
    expect(routeA(scoped)).toEqual({ ...claude(A, AT(T0)), listed: false });
    expect(routeA(scoped)).toEqual(routeA(unscoped));
    expect(deltaA(scoped)).toEqual(deltaA(unscoped));
    expect(deltaA(scoped)!.kinds).toEqual(['disappeared']);
    // And B, outside the scope, is still not looked at even though the probe named it.
    expect(scoped.snapshot.routes.find((route) => route.routeKey === B)).toEqual(previousSnapshot().routes[1]);
    expect(scoped.deltas.find((delta) => delta.routeKey === B)!.kinds).toEqual(['notRefreshed']);
  });

  it('a scoped provider that did not answer carries everything forward, as an unscoped one would', async () => {
    const failing: DiscoveryProbe = async () => { throw new Error('spawn claude ENOENT'); };
    const { snapshot, deltas } = await refreshDiscovery({
      previous: previousSnapshot(), probes: { claudeCLI: failing }, machineKey: MACHINE.key, now: T1, routeScope: { claudeCLI: [A] },
    });
    expect(snapshot.routes).toEqual(previousSnapshot().routes);
    expect(deltas.map((delta) => delta.kinds)).toEqual([['notRefreshed'], ['notRefreshed']]);
  });

  it('does not record a route the probe named outside the scope that was not already known', async () => {
    const C = 'claudeCLI:fixture-model-c';
    const { snapshot, deltas } = await refreshDiscovery({
      previous: previousSnapshot(), probes: { claudeCLI: answering([claude(A, AT(T1)), claude(B, AT(T1)), claude(C, AT(T1))]) },
      machineKey: MACHINE.key, now: T1, routeScope: { claudeCLI: [A] },
    });
    expect(snapshot.routes.map((route) => route.routeKey)).toEqual([A, B]);
    expect(deltas.map((delta) => delta.routeKey)).toEqual([A, B]);
  });
});

describe('(2) without a route scope every result is unchanged', () => {
  it('an unscoped refresh carries no scope, reads a route it did not name as disappeared, and equals an empty scope', async () => {
    const probe = () => answering([claude(A, AT(T1))]);
    const unscoped = await refreshDiscovery({ previous: previousSnapshot(), probes: { claudeCLI: probe() }, machineKey: MACHINE.key, now: T1 });
    const empty = await refreshDiscovery({
      previous: previousSnapshot(), probes: { claudeCLI: probe() }, machineKey: MACHINE.key, now: T1, routeScope: {},
    });

    expect(JSON.stringify(unscoped)).not.toContain('routeScope');
    expect(JSON.stringify(empty)).toBe(JSON.stringify(unscoped));
    expect(unscoped.snapshot.providers).toEqual([{ provider: 'claudeCLI', refreshed: true, detail: 'listed 1' }]);
    expect(unscoped.snapshot.routes.find((route) => route.routeKey === B)).toEqual({ ...previousSnapshot().routes[1], listed: false });
    expect(unscoped.deltas.find((delta) => delta.routeKey === B)!.kinds).toEqual(['disappeared']);
  });
});

describe('(3) a scope that cannot be used is refused before anything is probed', () => {
  it.each([
    ['a provider this refresh does not probe', { codexCLI: ['codexCLI:fixture'] }],
    ['an empty list', { claudeCLI: [] }],
    ['a key of another provider', { claudeCLI: ['codexCLI:fixture'] }],
    ['a key with no modelID', { claudeCLI: ['claudeCLI:'] }],
  ])('refuses %s', async (_label, routeScope) => {
    const probe = answering([claude(A, AT(T1))]);
    await expect(refreshDiscovery({
      previous: previousSnapshot(), probes: { claudeCLI: probe }, machineKey: MACHINE.key, now: T1, routeScope,
    })).rejects.toThrow(/route scope was refused, and nothing was probed/);
    expect(probe.calls).toBe(0);
  });
});

describe('(4) what a scoped refresh persists, and what the candidate answer then reads', () => {
  it('persists only the scoped route\'s new observation plus the snapshot; availability shows A at T1 and B at T0', async () => {
    const root = temporary();
    const persist = (result: { snapshot: DiscoverySnapshot; deltas: Parameters<typeof discoveryRefreshRecords>[1] }, when: Date) =>
      appendObservations(root, discoveryRefreshRecords(result.snapshot, result.deltas, MACHINE, AT(when), 'cernum discovery-refresh (test)'),
        { origin: 'observedHere', receivedAt: AT(when) });

    // T0: the daily unscoped refresh observes both routes.
    const first = await refreshDiscovery({
      probes: { claudeCLI: answering([claude(A, AT(T0)), claude(B, AT(T0))]) }, machineKey: MACHINE.key, now: T0,
    });
    persist(first, T0);
    const heldBefore = readObservationStore(root).observations.length;

    // T1: scoped to A. The provider answers about both; only A is taken.
    const second = await refreshDiscovery({
      previous: latestDiscoverySnapshot(readObservationStore(root), MACHINE.key),
      probes: { claudeCLI: answering([claude(A, AT(T1)), claude(B, AT(T1))]) }, machineKey: MACHINE.key, now: T1,
      routeScope: { claudeCLI: [A] },
    });
    persist(second, T1);

    const added = readObservationStore(root).observations.slice(heldBefore).map((entry) => entry.record);
    const routeRecords = added.filter((record) => record.kind === 'routeAvailability');
    expect(routeRecords.map((record) => [record.routeKey, record.observedAt])).toEqual([[A, AT(T1)]]);
    expect(added.some((record) => record.kind === 'discoverySnapshot')).toBe(true);
    expect(added.some((record) => record.kind === 'discoveryDelta')).toBe(false);
    expect(latestDiscoverySnapshot(readObservationStore(root), MACHINE.key)).toEqual(second.snapshot);

    // The candidate answer's availability (availabilityFromStore is what `candidates` reads it from).
    const contents = readObservationStore(root);
    const asked = new Date(T1.getTime() + 60_000);
    const availabilityA = availabilityFromStore(contents, A, MACHINE.key, asked);
    const availabilityB = availabilityFromStore(contents, B, MACHINE.key, asked);
    expect(availabilityA).toMatchObject({ state: 'available', observedAt: AT(T1) });
    expect(availabilityB).toMatchObject({ state: 'available', observedAt: AT(T0) });
    // No route is marked unavailable, gone or stale because of the scope.
    expect(routeFreshness(second.snapshot, B, asked).state).toBe('currentlyDiscovered');
    expect(second.deltas.every((delta) => !delta.qualificationNowStale)).toBe(true);
  });
});

describe('(5) `discovery-refresh --route`', () => {
  it('is declared on discovery-refresh as a repeatable value option, and not on discovery-run', () => {
    const route = acceptedOptions(commandSpec('discovery-refresh')!).find((option) => option.name === 'route');
    expect(route).toMatchObject({ takesValue: true, repeatable: true });
    expect(acceptedOptions(commandSpec('discovery-run')!).map((option) => option.name)).not.toContain('route');
  });

  it('exits 2 and probes or persists nothing when a key does not belong to a named provider', () => {
    const root = temporary();
    const fakeBin = temporary('cernum-discovery-route-bin-');
    for (const name of ['claude', 'codex', 'opencode']) {
      fs.writeFileSync(path.join(fakeBin, name),
        `#!/bin/sh\necho "$@" >> ${JSON.stringify(path.join(fakeBin, `${name}.invocations`))}\nexit 1\n`, { mode: 0o755 });
    }
    const refused = [
      // A key of a provider that was not named. Given FIRST, so a parser keeping only the last value would let it through.
      ['claudeCLI', '--route', 'codexCLI:fixture', '--route', A],
      // No provider named at all.
      ['--route', A],
      // A provider prefix with no modelID, and a key with no provider prefix.
      ['claudeCLI', '--route', 'claudeCLI:'],
      ['claudeCLI', '--route', 'fixture-model-a'],
      // A --route given no value.
      ['claudeCLI', '--route'],
    ];
    for (const args of refused) {
      const result = spawnSync('npx', ['tsx', 'src/cli/cernum.ts', 'discovery-refresh', ...args, '--root', root,
        // A closed port, so even a probe that ran by mistake could reach no runtime.
        '--endpoint', 'http://127.0.0.1:9'], {
        cwd: path.resolve(__dirname, '..', '..'), encoding: 'utf8',
        env: { ...process.env, PATH: `${fakeBin}:${path.dirname(process.execPath)}:/usr/bin:/bin` },
      });
      expect(result.status, `${args.join(' ')}: ${result.stderr}`).toBe(2);
      expect(result.stderr).toMatch(/Nothing was probed or persisted|nothing was run/);
    }
    for (const name of ['claude', 'codex', 'opencode']) expect(fs.existsSync(path.join(fakeBin, `${name}.invocations`))).toBe(false);
    expect(fs.existsSync(observationStorePath(root))).toBe(false);
  }, 180_000);
});
