// Pass 8, Decision 3 · the append-only, content-addressed observation store two machines share a
// fleet view through — determinism, atomicity, corruption, idempotent import, and the rule that an
// imported observation never becomes a local one.
//
// Nothing here contacts a provider, a runtime or a network. Every probe is a supplied function.

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  IMPORTED_OBSERVATION_IS_NOT_LOCAL, OBSERVATION_STORE_SCHEMA, ObservationRecord, ObservationStoreError,
  appendObservations, availabilityObservationsFrom, billingObservation, describeObservationStore,
  discoverySnapshotObservation, exportObservations, fleetAvailability, importObservations,
  latestDiscoverySnapshot, machineObservation, machinesInStore, observationBytes, observationStorePath,
  qualificationStalenessObservation, readObservationBundle, readObservationStore, recordLocalObservation,
  routeAvailabilityObservation, sealObservation, sharedBundleName, verifyObservationRecord,
} from '../../src/engine/observation-store';
import {
  DiscoverySnapshot, RouteObservation, diffDiscoverySnapshots, refreshDiscovery,
} from '../../src/engine/discovery-refresh';
import { availabilityOnMachine, readMachineFingerprint } from '../../src/engine/machine-availability';

const NOW = new Date('2026-09-22T12:00:00Z');
const AT = '2026-09-22T12:00:00Z';
const EARLIER = '2026-09-22T09:00:00Z';
/** Two machines, neither of them named. The keys are opaque and that is the whole point. */
const A = 'cmk1:aaaaaaaaaaaaaaaaaaaaaaaa';
const B = 'cmk1:bbbbbbbbbbbbbbbbbbbbbbbb';

const temporaries: string[] = [];
afterEach(() => { for (const directory of temporaries.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
function temporary(prefix = 'cernum-observations-'): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaries.push(directory);
  return directory;
}

const seen = (routeKey: string, machineKey: string, available: boolean, over: {
  observedAt?: string; runtimeDigest?: string; machineLabel?: string;
} = {}): ObservationRecord => routeAvailabilityObservation({
  routeKey, machineKey, machineLabel: over.machineLabel ?? 'a-machine', observedAt: over.observedAt ?? AT,
  available, reason: available ? 'installed and signed in' : 'not listed by the runtime',
  ...(over.runtimeDigest === undefined ? {} : { runtimeDigest: over.runtimeDigest }),
}, routeKey.startsWith('ollama') ? 'ollama' : 'opencodeCLI', 'a test');

const snapshotOf = (machineKey: string, routes: RouteObservation[], takenAt = AT): DiscoverySnapshot => ({
  schema: 'cds1', machineKey, takenAt, providers: [{ provider: 'ollama', refreshed: true, detail: 'listed' }], routes,
});
const route = (modelID: string, over: Partial<RouteObservation> = {}): RouteObservation => ({
  routeKey: `ollama:${modelID}`, provider: 'ollama', modelID, listed: true, availability: 'installedLocally',
  runtimeDigest: 'sha256:aaa', observedAt: AT, ...over,
});

// 14–17 ─────────────────────────────────────────────────────────────────────────────────────────────
describe('14–17 · a record is named by its own content, written atomically, and refused when it does not verify', () => {
  it('14 · 15 · a snapshot serializes deterministically and digests to the same id every time', () => {
    const one = discoverySnapshotObservation(snapshotOf(A, [route('gemma3:4b')]), 'a-machine', 'a test');
    const two = discoverySnapshotObservation(snapshotOf(A, [route('gemma3:4b')]), 'a-machine', 'a test');
    expect(one.recordID).toBe(two.recordID);
    expect(one.recordID).toMatch(/^[0-9a-f]{64}$/);
    expect(observationBytes(one)).toBe(observationBytes(two));
    expect(verifyObservationRecord(one)).toMatchObject({ intact: true });

    // ANY material difference is a different record. Nothing collapses two observations into one.
    expect(discoverySnapshotObservation(snapshotOf(A, [route('gemma3:4b', { runtimeDigest: 'sha256:bbb' })]), 'a-machine', 'a test').recordID)
      .not.toBe(one.recordID);
    expect(discoverySnapshotObservation(snapshotOf(B, [route('gemma3:4b')]), 'a-machine', 'a test').recordID).not.toBe(one.recordID);
    expect(discoverySnapshotObservation(snapshotOf(A, [route('gemma3:4b')], EARLIER), 'a-machine', 'a test').recordID).not.toBe(one.recordID);

    // The machine key itself is derived from what the machine reports, and is opaque.
    expect(machineObservation(readMachineFingerprint(), A, AT, 'a test').machineKey).toBe(A);
  });

  it('16 · a write is atomic: no partial file is ever left where a reader would find one', () => {
    const root = temporary();
    const record = seen('ollama:gemma3:4b', A, true);
    expect(recordLocalObservation(root, record, AT)).toBe(true);
    const directory = path.join(observationStorePath(root), A.replace(':', '-'));
    // The temporary is named and removed in the same call; only the final file survives it.
    expect(fs.readdirSync(directory)).toEqual([`${record.recordID}.json`]);
    expect(fs.readdirSync(directory).some((name) => name.includes('.tmp-'))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(directory, `${record.recordID}.json`), 'utf8')).record.recordID)
      .toBe(record.recordID);
  });

  it('17 · a file whose bytes moved is REFUSED and reported by path, not silently skipped', () => {
    const root = temporary();
    const good = seen('ollama:gemma3:4b', A, true);
    const alsoGood = seen('ollama:qwen3:8b', A, true);
    appendObservations(root, [good, alsoGood], { origin: 'observedHere', receivedAt: AT });
    const file = path.join(observationStorePath(root), A.replace(':', '-'), `${good.recordID}.json`);
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    stored.record.body.available = false;          // the content no longer digests to its own name
    fs.writeFileSync(file, JSON.stringify(stored, null, 2));

    const contents = readObservationStore(root);
    expect(contents.corrupt).toHaveLength(1);
    expect(contents.corrupt[0]!.filePath).toBe(file);
    expect(contents.corrupt[0]!.reason).toContain('digests to');
    // The tampered record contributes NOTHING to the answer, and the intact one still does.
    expect(contents.observations.map((entry) => entry.record.recordID)).toEqual([alsoGood.recordID]);
    expect(describeObservationStore(contents).join('\n')).toContain('did not verify');

    // Unparseable JSON, and a record moved into another record's name, are both caught too.
    fs.writeFileSync(file, '{ not json');
    expect(readObservationStore(root).corrupt[0]!.reason).toContain('not readable JSON');
    fs.rmSync(file);
    fs.writeFileSync(path.join(observationStorePath(root), A.replace(':', '-'), 'wrong-name.json'),
      JSON.stringify({ record: good, origin: 'observedHere', receivedAt: AT }));
    expect(readObservationStore(root).corrupt[0]!.reason).toContain('but holds');
  });
});

// 18–24 ─────────────────────────────────────────────────────────────────────────────────────────────
describe('18–24 · two machines, one store: import is idempotent and never promotes a remote observation', () => {
  it('18 · importing the same bundle twice writes the records once', () => {
    const source = temporary();
    const target = temporary();
    appendObservations(source, [seen('ollama:gemma3:4b', A, true), seen('opencodeCLI:opencode/big-pickle', A, true)],
      { origin: 'observedHere', receivedAt: AT });
    const { bundle } = exportObservations(source, { exportedFromMachine: A, exportedFromLabel: 'a-machine', exportedAt: AT });
    const file = path.join(temporary(), 'bundle.json');
    fs.writeFileSync(file, JSON.stringify(bundle, null, 2));

    const first = importObservations(target, file, AT);
    expect(first.imported).toHaveLength(2);
    expect(first.duplicates).toHaveLength(0);
    const second = importObservations(target, file, '2026-09-23T00:00:00Z');
    expect(second.imported).toHaveLength(0);
    expect(second.duplicates).toHaveLength(2);
    expect(readObservationStore(target).observations).toHaveLength(2);
    // And a third import changes nothing at all, byte for byte.
    const before = fs.readdirSync(path.join(observationStorePath(target), A.replace(':', '-'))).sort();
    importObservations(target, file, '2026-09-24T00:00:00Z');
    expect(fs.readdirSync(path.join(observationStorePath(target), A.replace(':', '-'))).sort()).toEqual(before);
  });

  it('19 · 20 · observations from two machines coexist, and an imported one keeps its source machine', () => {
    const remote = temporary();
    const here = temporary();
    appendObservations(remote, [seen('ollama:gemma3:4b', B, true, { machineLabel: 'the-other' })],
      { origin: 'observedHere', receivedAt: AT });
    appendObservations(here, [seen('ollama:qwen3:8b', A, true, { machineLabel: 'this-one' })],
      { origin: 'observedHere', receivedAt: AT });
    const { bundle } = exportObservations(remote, { exportedFromMachine: B, exportedFromLabel: 'the-other', exportedAt: AT });
    const file = path.join(temporary(), sharedBundleName(B, AT));
    fs.writeFileSync(file, JSON.stringify(bundle, null, 2));
    importObservations(here, file, AT);

    const contents = readObservationStore(here);
    expect(contents.observations).toHaveLength(2);
    const machines = machinesInStore(contents);
    expect(machines.map((entry) => entry.machineKey)).toEqual([A, B]);
    expect(machines.find((entry) => entry.machineKey === A)!.origin).toBe('observedHere');
    expect(machines.find((entry) => entry.machineKey === B)!.origin).toBe('imported');
    // The record still says WHO observed it, and the store says how it arrived. Both survive.
    const fromB = contents.observations.find((entry) => entry.record.machineKey === B)!;
    expect(fromB.record.machineKey).toBe(B);
    expect(fromB.record.machineLabel).toBe('the-other');
    expect(fromB.origin).toBe('imported');
    expect(fromB.importedFromMachine).toBe(B);
  });

  it('21 · an imported LOCAL-model availability does NOT become local availability here', () => {
    const here = temporary();
    // Everything this store knows about gemma3 was observed on the other machine.
    appendObservations(here, [seen('ollama:gemma3:4b', B, true, { runtimeDigest: 'sha256:aaa', machineLabel: 'the-other' })],
      { origin: 'imported', receivedAt: AT, importedFromMachine: B });
    const contents = readObservationStore(here);
    const observations = availabilityObservationsFrom(contents);

    // Asked about THIS machine, the honest answer is that it has never been observed here.
    expect(availabilityOnMachine(observations, 'ollama:gemma3:4b', A, NOW))
      .toMatchObject({ state: 'neverObserved' });
    expect(availabilityOnMachine(observations, 'ollama:gemma3:4b', A, NOW).reason).toContain('never been observed from this machine');
    // Asked about the machine that DID observe it, the answer is available — on that machine.
    expect(availabilityOnMachine(observations, 'ollama:gemma3:4b', B, NOW)).toMatchObject({ state: 'available' });

    const fleet = fleetAvailability(contents, NOW);
    const row = fleet.find((entry) => entry.routeKey === 'ollama:gemma3:4b')!;
    expect(row.machines.map((entry) => entry.machineKey)).toEqual([B]);
    expect(row.machines[0]!.origin).toBe('imported');
    expect(IMPORTED_OBSERVATION_IS_NOT_LOCAL).toContain('says nothing about whether the route is reachable from this one');
  });

  it('22 · a local qualification stays bound to its machine AND its weights digest', () => {
    const here = temporary();
    appendObservations(here, [
      seen('ollama:gemma3:4b', A, true, { runtimeDigest: 'sha256:aaa' }),
      seen('ollama:gemma3:4b', B, true, { runtimeDigest: 'sha256:bbb' }),
    ], { origin: 'observedHere', receivedAt: AT });
    const observations = availabilityObservationsFrom(readObservationStore(here));
    // The SAME tag on two machines is two different sets of weights, and the store keeps both facts.
    expect(observations.find((entry) => entry.machineKey === A)!.runtimeDigest).toBe('sha256:aaa');
    expect(observations.find((entry) => entry.machineKey === B)!.runtimeDigest).toBe('sha256:bbb');
    expect(availabilityOnMachine(observations, 'ollama:gemma3:4b', A, NOW).latest!.runtimeDigest).toBe('sha256:aaa');
  });

  it('23 · a REMOTE route can be observed available on several machines at once, which is not a conflict', () => {
    const here = temporary();
    appendObservations(here, [
      seen('opencodeCLI:opencode/big-pickle', A, true),
      seen('opencodeCLI:opencode/big-pickle', B, true, { machineLabel: 'the-other' }),
    ], { origin: 'observedHere', receivedAt: AT });
    const fleet = fleetAvailability(readObservationStore(here), NOW);
    const row = fleet.find((entry) => entry.routeKey === 'opencodeCLI:opencode/big-pickle')!;
    expect(row.machines.map((entry) => entry.machineKey)).toEqual([A, B]);
    expect(row.machines.every((entry) => entry.availability.state === 'available')).toBe(true);
  });

  it('24 · a stale observation is PRESERVED, and the newer one does not erase its provenance', () => {
    const here = temporary();
    const old = seen('ollama:gemma3:4b', A, true, { observedAt: '2026-09-01T00:00:00Z' });
    const recent = seen('ollama:gemma3:4b', A, false, { observedAt: AT });
    appendObservations(here, [old, recent], { origin: 'observedHere', receivedAt: AT });

    const contents = readObservationStore(here);
    // BOTH are still on disk. Newest-wins is a read rule; nothing overwrote anything.
    expect(contents.observations).toHaveLength(2);
    expect(contents.observations.map((entry) => entry.record.observedAt)).toEqual(['2026-09-01T00:00:00Z', AT]);
    const observations = availabilityObservationsFrom(contents);
    expect(availabilityOnMachine(observations, 'ollama:gemma3:4b', A, NOW)).toMatchObject({ state: 'unavailable' });
    // The older observation is still readable, and still says what it said.
    expect(contents.observations[0]!.record.body).toMatchObject({ available: true });

    // An observation old enough to age out reports STALE rather than disappearing.
    const onlyOld = temporary();
    appendObservations(onlyOld, [old], { origin: 'observedHere', receivedAt: AT });
    expect(availabilityOnMachine(availabilityObservationsFrom(readObservationStore(onlyOld)), 'ollama:gemma3:4b', A, NOW))
      .toMatchObject({ state: 'stale' });
  });
});

// 25–28 ─────────────────────────────────────────────────────────────────────────────────────────────
describe('25–28 · discovery snapshots persist, refresh diffs against them, and a failed probe is not a disappearance', () => {
  it('25 · a discovery snapshot round-trips through the store unchanged', () => {
    const root = temporary();
    const snapshot = snapshotOf(A, [route('gemma3:4b'), route('qwen3:8b')]);
    recordLocalObservation(root, discoverySnapshotObservation(snapshot, 'a-machine', 'a test'), AT);
    const read = latestDiscoverySnapshot(readObservationStore(root), A);
    expect(read).toEqual(snapshot);
    // A snapshot taken on the other machine is not this machine's snapshot.
    expect(latestDiscoverySnapshot(readObservationStore(root), B)).toBeUndefined();
  });

  it('26 · a refresh compares against the PERSISTED previous snapshot and reports each delta', async () => {
    const root = temporary();
    const before = snapshotOf(A, [route('gemma3:4b'), route('qwen3:8b')], EARLIER);
    recordLocalObservation(root, discoverySnapshotObservation(before, 'a-machine', 'a test'), EARLIER);

    const previous = latestDiscoverySnapshot(readObservationStore(root), A);
    const { snapshot, deltas } = await refreshDiscovery({
      previous, machineKey: A, now: NOW,
      probes: { ollama: async () => ({ refreshed: true, detail: 'listed',
        // gemma3's weights were re-pulled; qwen3 is gone; a new model appeared.
        routes: [route('gemma3:4b', { runtimeDigest: 'sha256:ccc' }), route('llama4:8b')] }) },
    });
    const kindsFor = (routeKey: string) => deltas.find((entry) => entry.routeKey === routeKey)!.kinds;
    expect(kindsFor('ollama:gemma3:4b')).toContain('runtimeDigestChanged');
    expect(kindsFor('ollama:qwen3:8b')).toContain('disappeared');
    expect(kindsFor('ollama:llama4:8b')).toContain('newlyDiscovered');
    expect(deltas.find((entry) => entry.routeKey === 'ollama:gemma3:4b')!.qualificationNowStale).toBe(true);

    recordLocalObservation(root, discoverySnapshotObservation(snapshot, 'a-machine', 'a test'), AT);
    // The NEWEST snapshot is the one read back, and the earlier one is still on disk.
    expect(latestDiscoverySnapshot(readObservationStore(root), A)!.takenAt).toBe(AT);
    expect(readObservationStore(root).observations.filter((entry) => entry.record.kind === 'discoverySnapshot')).toHaveLength(2);
  });

  it('27 · a probe that FAILED is notRefreshed, never disappeared, and its routes are carried forward', async () => {
    const before = snapshotOf(A, [route('gemma3:4b'), route('qwen3:8b')], EARLIER);
    for (const probe of [
      async () => ({ refreshed: false, detail: 'the runtime did not answer', routes: [] }),
      async () => { throw new Error('connection refused'); },
    ]) {
      const { snapshot, deltas } = await refreshDiscovery({ previous: before, machineKey: A, now: NOW, probes: { ollama: probe } });
      for (const delta of deltas) {
        expect(delta.kinds).toEqual(['notRefreshed']);
        expect(delta.kinds).not.toContain('disappeared');
        expect(delta.qualificationNowStale).toBe(false);
        expect(delta.detail.join(' ')).toContain('did not answer this refresh');
      }
      // Every route the previous snapshot held is still there, still listed, still with its own date.
      expect(snapshot.routes.map((entry) => entry.routeKey).sort()).toEqual(['ollama:gemma3:4b', 'ollama:qwen3:8b']);
      expect(snapshot.routes.every((entry) => entry.listed && entry.observedAt === AT)).toBe(true);
      expect(snapshot.providers[0]).toMatchObject({ provider: 'ollama', refreshed: false });
    }
  });

  it('28 · availability is queried BY MACHINE, and a qualification-staleness consequence persists beside it', () => {
    const root = temporary();
    appendObservations(root, [
      seen('ollama:gemma3:4b', A, true),
      seen('ollama:gemma3:4b', B, false, { machineLabel: 'the-other' }),
      qualificationStalenessObservation({ routeKey: 'ollama:gemma3:4b', provider: 'ollama', machineKey: A,
        machineLabel: 'a-machine', observedAt: AT, reasons: ['staleRuntimeDigestChanged'],
        detail: ['qualified under sha256:aaa; the runtime now reports sha256:ccc'], provenance: 'a test' }),
      billingObservation({ routeKey: 'opencodeCLI:opencode/big-pickle', provider: 'opencodeCLI', machineKey: A,
        machineLabel: 'a-machine', observedAt: AT, accountBasis: 'the configured credential',
        observedBillingRecord: 'account usage page, September statement', confirmedBy: 'the owner',
        zeroMarginalCost: true, provenance: 'a test' }),
    ], { origin: 'observedHere', receivedAt: AT });

    const contents = readObservationStore(root);
    const observations = availabilityObservationsFrom(contents);
    expect(availabilityOnMachine(observations, 'ollama:gemma3:4b', A, NOW).state).toBe('available');
    expect(availabilityOnMachine(observations, 'ollama:gemma3:4b', B, NOW).state).toBe('unavailable');
    // A billing observation is not an availability observation and never leaks into one.
    expect(observations.map((entry) => entry.routeKey)).not.toContain('opencodeCLI:opencode/big-pickle');
    const staleness = contents.observations.find((entry) => entry.record.kind === 'qualificationStaleness')!;
    expect(staleness.record.body).toMatchObject({ reasons: ['staleRuntimeDigestChanged'] });
  });
});

// The bundle, as a transport-neutral value ──────────────────────────────────────────────────────────
describe('a bundle is one value, sealed, and refused whole when its bytes moved', () => {
  it('seals the whole bundle and produces the same bytes for the same set', () => {
    const root = temporary();
    appendObservations(root, [seen('ollama:gemma3:4b', A, true), seen('ollama:qwen3:8b', A, true)],
      { origin: 'observedHere', receivedAt: AT });
    const one = exportObservations(root, { exportedFromMachine: A, exportedFromLabel: 'a-machine', exportedAt: AT });
    const two = exportObservations(root, { exportedFromMachine: A, exportedFromLabel: 'a-machine', exportedAt: AT });
    expect(one.bundle.bundleDigest).toBe(two.bundle.bundleDigest);
    expect(JSON.stringify(one.bundle)).toBe(JSON.stringify(two.bundle));
    expect(one.bundle.schema).toBe('cob1');
    expect(one.bundle.recordSchema).toBe(OBSERVATION_STORE_SCHEMA);
    // `origin` is deliberately NOT carried: it is this store's opinion, and a lie on the other side.
    expect(JSON.stringify(one.bundle)).not.toContain('observedHere');
  });

  it('refuses a truncated, edited or foreign bundle WHOLE, importing nothing from it', () => {
    const root = temporary();
    const target = temporary();
    appendObservations(root, [seen('ollama:gemma3:4b', A, true)], { origin: 'observedHere', receivedAt: AT });
    const { bundle } = exportObservations(root, { exportedFromMachine: A, exportedFromLabel: 'a-machine', exportedAt: AT });
    const directory = temporary();

    const edited = path.join(directory, 'edited.json');
    fs.writeFileSync(edited, JSON.stringify({ ...bundle, exportedFromMachine: B }, null, 2));
    expect(() => readObservationBundle(edited)).toThrow(ObservationStoreError);
    expect(() => importObservations(target, edited, AT)).toThrow(/bytes changed after it was written/);

    const truncated = path.join(directory, 'truncated.json');
    fs.writeFileSync(truncated, JSON.stringify(bundle).slice(0, 80));
    expect(() => readObservationBundle(truncated)).toThrow(/not readable JSON/);

    const foreign = path.join(directory, 'foreign.json');
    fs.writeFileSync(foreign, JSON.stringify({ schema: 'something-else', records: [] }));
    expect(() => readObservationBundle(foreign)).toThrow(/not a Cernum observation bundle/);

    // NOTHING was imported by any of the three.
    expect(readObservationStore(target).observations).toHaveLength(0);
  });

  it('keeps a first-hand observation first-hand when somebody sends it back', () => {
    const mine = temporary();
    const record = seen('ollama:gemma3:4b', A, true);
    appendObservations(mine, [record], { origin: 'observedHere', receivedAt: AT });
    const { bundle } = exportObservations(mine, { exportedFromMachine: A, exportedFromLabel: 'a-machine', exportedAt: AT });
    const file = path.join(temporary(), 'round-trip.json');
    fs.writeFileSync(file, JSON.stringify(bundle, null, 2));

    const outcome = importObservations(mine, file, '2026-09-23T00:00:00Z');
    expect(outcome.duplicates).toHaveLength(1);
    // The existing copy — and its first-hand origin — is untouched. An import cannot downgrade it.
    expect(readObservationStore(mine).observations[0]!.origin).toBe('observedHere');
  });

  it('exports a subset by machine, by time and by kind without changing any record\'s identity', () => {
    const root = temporary();
    const old = seen('ollama:gemma3:4b', A, true, { observedAt: '2026-09-01T00:00:00Z' });
    const recent = seen('ollama:qwen3:8b', A, true);
    const other = seen('ollama:llama4:8b', B, true, { machineLabel: 'the-other' });
    appendObservations(root, [old, recent, other], { origin: 'observedHere', receivedAt: AT });

    expect(exportObservations(root, { exportedFromMachine: A, exportedFromLabel: 'a', exportedAt: AT, machineKeys: [A] })
      .bundle.records.map((entry) => entry.recordID).sort()).toEqual([old.recordID, recent.recordID].sort());
    expect(exportObservations(root, { exportedFromMachine: A, exportedFromLabel: 'a', exportedAt: AT, since: EARLIER })
      .bundle.records.map((entry) => entry.recordID).sort()).toEqual([recent.recordID, other.recordID].sort());
    expect(exportObservations(root, { exportedFromMachine: A, exportedFromLabel: 'a', exportedAt: AT, kinds: ['discoverySnapshot'] })
      .bundle.records).toHaveLength(0);
    // A record's identity is its content, so a subset export does not renumber anything.
    expect(exportObservations(root, { exportedFromMachine: A, exportedFromLabel: 'a', exportedAt: AT, machineKeys: [A] })
      .bundle.records.every((entry) => verifyObservationRecord(entry).intact)).toBe(true);
  });

  it('reports an absent store as empty rather than as an error, and creates nothing by reading', () => {
    const root = temporary();
    const contents = readObservationStore(root);
    expect(contents.observations).toHaveLength(0);
    expect(contents.corrupt).toHaveLength(0);
    expect(fs.existsSync(observationStorePath(root))).toBe(false);
    expect(describeObservationStore(contents)).toEqual(['This machine has recorded no observations yet.']);
  });
});

// 35 ────────────────────────────────────────────────────────────────────────────────────────────────
describe('35 · the store references evidence identities and never becomes a second benchmark ledger', () => {
  it('holds no campaign row, no score and no ledger, and leaves an evidence root untouched', () => {
    const root = temporary();
    // A pre-existing "historical evidence root" beside the store, with bytes we can check afterwards.
    const evidence = path.join(root, 'campaign-2026-09', 'results.jsonl');
    fs.mkdirSync(path.dirname(evidence), { recursive: true });
    const original = '{"candidate":"haiku","status":"pass"}\n';
    fs.writeFileSync(evidence, original);

    appendObservations(root, [
      seen('ollama:gemma3:4b', A, true),
      discoverySnapshotObservation(snapshotOf(A, [route('gemma3:4b')]), 'a-machine', 'a test'),
      qualificationStalenessObservation({ routeKey: 'ollama:gemma3:4b', provider: 'ollama', machineKey: A,
        machineLabel: 'a', observedAt: AT, reasons: ['staleRuntimeDigestChanged'], detail: ['digest moved'],
        provenance: 'a test' }),
    ], { origin: 'observedHere', receivedAt: AT });

    // THE EVIDENCE ROOT IS BYTE-IDENTICAL. Nothing copied it, merged it or re-derived a row in it.
    expect(fs.readFileSync(evidence, 'utf8')).toBe(original);
    const contents = readObservationStore(root);
    const serialized = JSON.stringify(contents);
    for (const forbidden of ['results.jsonl', 'candidate', 'status', 'score', 'passRate']) {
      expect(serialized).not.toContain(forbidden);
    }
    // Every record is an OBSERVATION kind. There is no row kind and no score kind to be one.
    expect([...new Set(contents.observations.map((entry) => entry.record.kind))].sort())
      .toEqual(['discoverySnapshot', 'qualificationStaleness', 'routeAvailability']);
  });

  it('is transport-neutral: no protocol, service or absolute host path appears in its source', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../src/engine/observation-store.ts'), 'utf8');
    for (const forbidden of [/\bsmb:/i, /\bssh:\/\//i, /\bicloud\b/i, /\bdropbox\b/i, /\bgoogle drive\b/i,
      /\brsync\b/i, /https?:\/\//i, /\/Users\//, /\/Volumes\//]) {
      expect(source).not.toMatch(forbidden);
    }
    // A shared directory is a path the OPERATOR supplies; the store only names the file inside it.
    expect(sharedBundleName(A, AT)).toBe(`observations-${A.replace(':', '-')}-20260922T120000Z.json`);
    expect(sharedBundleName(A, AT)).not.toContain('/');
  });

  it('refuses to seal a record it cannot canonically encode, rather than digesting something else', () => {
    // A lone surrogate has no agreed encoding across the two runtimes the canonical form serves.
    expect(() => sealObservation({ kind: 'routeAvailability', machineKey: A, machineLabel: 'a', observedAt: AT,
      provenance: 'a test', body: { reason: '\ud800' } })).toThrow();
    // A well-formed record with an unknown kind is refused on the way back in, not on the way out.
    const record = seen('ollama:gemma3:4b', A, true);
    expect(verifyObservationRecord({ ...record, kind: 'somethingElse' as never }).intact).toBe(false);
    expect(verifyObservationRecord({ ...record, schema: 'cos99' as never }).reason).toContain('schema is');
    expect(verifyObservationRecord({ ...record, provenance: '   ' }).reason).toContain('provenance is missing');
  });

  // REGRESSIONS FOUND BY REVIEW OF THIS PASS. Each one was a real defect in the first cut.
  it('reports a file holding null, a scalar or a null record as CORRUPT instead of throwing', () => {
    const root = temporary();
    const good = seen('ollama:gemma3:4b', A, true);
    appendObservations(root, [good], { origin: 'observedHere', receivedAt: AT });
    const directory = path.join(observationStorePath(root), A.replace(':', '-'));

    // Each of these used to escape `readObservationStore` as a TypeError and take down every command
    // that reads the store — the exact inversion of "a file that does not verify is REFUSED, not
    // ignored". A store that cannot be read is a finding; it is not an excuse to crash.
    for (const [name, bytes] of [['a.json', 'null'], ['b.json', '5'], ['c.json', '"x"'], ['d.json', '[]'],
      ['e.json', '{"record":null}'], ['f.json', '{"record":[]}'], ['g.json', '{"record":7}']] as [string, string][]) {
      fs.writeFileSync(path.join(directory, name), bytes);
    }
    const contents = readObservationStore(root);
    expect(contents.corrupt).toHaveLength(7);
    expect(contents.corrupt.map((entry) => entry.reason).join(' ')).toContain('null');
    // And the one good record is still read, which is the other half of the rule.
    expect(contents.observations.map((entry) => entry.record.recordID)).toEqual([good.recordID]);
  });

  it('orders observations by instant, not by the locale\'s idea of string order', () => {
    const root = temporary();
    // Second-truncated and millisecond spellings of the same minute, out of order on disk.
    const later = seen('ollama:gemma3:4b', A, false, { observedAt: '2026-09-22T12:00:00.500Z' });
    const earlier = seen('ollama:gemma3:4b', A, true, { observedAt: '2026-09-22T12:00:00Z' });
    appendObservations(root, [later, earlier], { origin: 'observedHere', receivedAt: AT });
    const contents = readObservationStore(root);
    expect(contents.observations.map((entry) => entry.record.observedAt))
      .toEqual(['2026-09-22T12:00:00Z', '2026-09-22T12:00:00.500Z']);
    // The newest observation decides, and it is the one 500 ms later.
    expect(availabilityOnMachine(availabilityObservationsFrom(contents), 'ollama:gemma3:4b', A, NOW).state)
      .toBe('unavailable');
  });

  it('keeps a staleness reason paired with the sentence that explains it, however they sort', () => {
    // `qualificationStaleness` returns parallel arrays. Sorting the reasons alone used to re-attribute
    // every sentence to the wrong reason, durably, in a record nobody re-derives.
    const record = qualificationStalenessObservation({
      routeKey: 'ollama:gemma3:4b', provider: 'ollama', machineKey: A, machineLabel: 'a', observedAt: AT,
      reasons: ['staleRuntimeDigestChanged', 'staleRouteChanged', 'staleEvidenceExpired'],
      detail: ['the weights digest moved', 'the driver moved', 'the evidence expired'],
      provenance: 'a test',
    });
    const body = record.body as { reasons: string[]; detail: string[] };
    expect(body.reasons).toEqual(['staleEvidenceExpired', 'staleRouteChanged', 'staleRuntimeDigestChanged']);
    expect(body.detail).toEqual(['the evidence expired', 'the driver moved', 'the weights digest moved']);
    for (const [index, reason] of body.reasons.entries()) {
      // Each sentence still explains its own reason, which is the only thing the pairing is for.
      expect(body.detail[index]).toContain(reason === 'staleEvidenceExpired' ? 'expired'
        : reason === 'staleRouteChanged' ? 'driver' : 'digest');
    }
  });

  it('diffs two snapshots order-independently and calls an unmoved route no material change', () => {
    const before = snapshotOf(A, [route('gemma3:4b'), route('qwen3:8b')], EARLIER);
    const after = snapshotOf(A, [route('qwen3:8b'), route('gemma3:4b')]);
    const deltas = diffDiscoverySnapshots(before, after);
    expect(deltas.map((entry) => entry.routeKey)).toEqual(['ollama:gemma3:4b', 'ollama:qwen3:8b']);
    expect(deltas.every((entry) => entry.kinds.length === 1 && entry.kinds[0] === 'noMaterialChange')).toBe(true);
    expect(deltas.every((entry) => entry.qualificationNowStale === false)).toBe(true);
  });
});
