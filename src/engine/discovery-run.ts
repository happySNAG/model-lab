// Benchmark engine · ONE headless discovery run: the entry a scheduler calls.
//
// WHAT THIS ADDS TO `discovery-refresh.ts`. Nothing about discovery. The probes, the snapshot, the diff
// and the decision about what a change means all stay in `refreshDiscovery`; this module is the thin
// wrapper that makes calling it unattended safe:
//
//   OWNERSHIP      two runs never overlap. The campaign lock (`lock.ts`) is taken before the first
//                  probe, in a directory of its own under the root, and a run that finds it held is
//                  REFUSED with the lock's own explanation, written down — never queued, never forced.
//   PERSISTENCE    the snapshot and the change report are appended to the observation store exactly
//                  as `discovery-refresh` appends them, by the same function below.
//   A VERDICT      one summary per run, printable as one line of JSON, saying whether anything moved.
//                  A provider that did not answer is a COUNT in that summary, not an exception: the
//                  engine already turns a failed or throwing probe into `notRefreshed`, and nothing
//                  here undoes that.
//
// IDEMPOTENT BY CONSTRUCTION. A second run over an unchanged world diffs to `noMaterialChange` on every
// route, writes no delta record, and reports `changed: false`. Its snapshot is still recorded, because
// "I looked at 09:00 and nothing had moved" is itself an observation worth keeping.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { CanonicalValue } from './canonical';
import { DiscoveryDelta, DiscoveryProbe, DiscoverySnapshot, refreshDiscovery } from './discovery-refresh';
import { atomicWriteJSON } from './ledger';
import { CampaignLockError, LockOptions, acquireCampaignLock } from './lock';
import { MachineFingerprint } from './machine-availability';
import {
  ObservationRecord, appendObservations, discoveryDeltaObservation, discoverySnapshotObservation, latestDiscoverySnapshot,
  machineObservation, providerAvailabilityObservation, readObservationStore, routeAvailabilityObservation,
} from './observation-store';
import { ProviderID } from './provider';

export const DISCOVERY_RUN_SUMMARY_SCHEMA = 'cdr1' as const;

/** Where a run's lock and its run records live. Separate from any campaign, so it locks only discovery. */
export function discoveryRunDirectory(root: string): string {
  return path.join(root, '.discovery-run');
}

export function discoveryRunRecordsDirectory(root: string): string {
  return path.join(discoveryRunDirectory(root), 'runs');
}

/**
 * The observations one refresh persists: the machine, the snapshot, each provider's answer, each
 * re-observed route's availability, and every delta that stales a qualification.
 *
 * Shared by `discovery-refresh` and `discovery-run`, so the two can never disagree about what a refresh
 * writes down.
 */
export function discoveryRefreshRecords(snapshot: DiscoverySnapshot, deltas: DiscoveryDelta[], machine: {
  fingerprint: MachineFingerprint; key: string;
}, observedAt: string, provenance: string): ObservationRecord[] {
  const label = machine.fingerprint.hostname;
  const records: ObservationRecord[] = [
    machineObservation(machine.fingerprint, machine.key, observedAt, provenance),
    discoverySnapshotObservation(snapshot, label, provenance),
  ];
  for (const provider of snapshot.providers) {
    records.push(providerAvailabilityObservation({
      provider: provider.provider, machineKey: machine.key, machineLabel: label,
      observedAt, answered: provider.refreshed, detail: provider.detail, provenance,
    }));
  }
  for (const route of snapshot.routes) {
    // A ROUTE A FAILED PROBE CARRIED FORWARD IS NOT RE-OBSERVED. Writing an availability record for it
    // would date somebody else's observation to now, which is the one thing a durable store must not do.
    if (snapshot.providers.find((entry) => entry.provider === route.provider)?.refreshed !== true) continue;
    // WHEN THIS OBSERVATION WAS MADE IS NOW, NOT WHEN THE ROUTE WAS LAST SEEN.
    //
    // A route the provider ANSWERED about but did not name is carried into the snapshot as
    // `listed: false` with its last-seen `observedAt` — correct for the snapshot, whose `observedAt`
    // means "last actually seen". It is wrong for an availability observation, which means "when I
    // looked". Dating the not-listed record to the last-seen time produced two records with the SAME
    // instant and opposite verdicts, so which one `availabilityOnMachine` returned was decided by a
    // digest tie-break — and, because the record then digested identically on every later refresh, the
    // disappearance could never be re-observed and the route aged into `stale` rather than
    // `unavailable`. A listed route keeps the provider's own timestamp; a vanished one is dated now.
    const listed = route.listed && route.availability !== 'refused';
    records.push(routeAvailabilityObservation({
      routeKey: route.routeKey, machineKey: machine.key, machineLabel: label,
      observedAt: route.listed ? route.observedAt : observedAt, available: listed,
      reason: route.listed ? `named by this refresh (${route.availability ?? 'listed'})`
        : `${route.provider} answered this refresh and did not name it (last seen ${route.observedAt})`,
      ...(route.runtimeDigest === undefined ? {} : { runtimeDigest: route.runtimeDigest }),
    }, route.provider, provenance));
  }
  for (const delta of deltas) {
    if (!delta.qualificationNowStale) continue;
    records.push(discoveryDeltaObservation(delta, machine.key, label, observedAt, provenance));
  }
  return records;
}

/** A delta that reports movement. `notRefreshed` is counted separately: silence is not a change. */
export function isDiscoveryChange(delta: DiscoveryDelta): boolean {
  return delta.kinds.some((kind) => kind !== 'noMaterialChange' && kind !== 'notRefreshed');
}

export interface DiscoveryRunSummary {
  schema: typeof DISCOVERY_RUN_SUMMARY_SCHEMA;
  command: 'discovery-run';
  status: 'completed' | 'refusedLockHeld';
  machineKey: string;
  at: string;
  /** Why the run did nothing. Present only when it was refused. */
  reason?: string;
  providersAnswered?: ProviderID[];
  /** Each provider that did not answer, with what it said. Recorded, never thrown. */
  providersNotAnswered?: { provider: ProviderID; detail: string }[];
  routes?: number;
  /** True when any route moved. False on a run that found the world as the last one left it. */
  changed?: boolean;
  changes?: { routeKey: string; kinds: string[] }[];
  qualificationsNowStale?: number;
  observationsWritten?: number;
  observationsAlreadyHeld?: number;
}

export interface DiscoveryRunOutcome {
  summary: DiscoveryRunSummary;
  snapshot?: DiscoverySnapshot;
  deltas?: DiscoveryDelta[];
  /** Where this run's summary was written. */
  recordPath: string;
}

function iso(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function recordRun(root: string, summary: DiscoveryRunSummary, nonce: string): string {
  const directory = discoveryRunRecordsDirectory(root);
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${summary.at.replace(/[:]/g, '')}-${summary.status}-${nonce}.json`);
  atomicWriteJSON(file, summary as unknown as CanonicalValue);
  return file;
}

/**
 * Run discovery once, headless, and say what moved.
 *
 * Refuses — returns `refusedLockHeld` with the lock's own explanation, and records that it did — when
 * another run holds the lock. Any other failure to take the lock, or to write the store, is a real
 * fault and is thrown. A provider's failure is not one: it is in `providersNotAnswered`.
 */
export async function runDiscoveryOnce(options: {
  root: string;
  probes: Partial<Record<ProviderID, DiscoveryProbe>>;
  machine: { fingerprint: MachineFingerprint; key: string };
  now: Date;
  /** The invocation, recorded on the lock so a refused run can name who holds it. */
  command: string;
  lockOptions?: LockOptions;
}): Promise<DiscoveryRunOutcome> {
  const at = iso(options.now);
  const nonce = Math.random().toString(36).slice(2, 10);
  const base = { schema: DISCOVERY_RUN_SUMMARY_SCHEMA, command: 'discovery-run' as const, machineKey: options.machine.key, at };

  let lock;
  try {
    lock = acquireCampaignLock(discoveryRunDirectory(options.root), {
      processType: 'terminal', command: options.command, campaignID: 'discovery-run', campaignName: 'discovery-run',
    }, options.lockOptions);
  } catch (error) {
    if (!(error instanceof CampaignLockError)) throw error;
    const summary: DiscoveryRunSummary = { ...base, status: 'refusedLockHeld', reason: error.message };
    return { summary, recordPath: recordRun(options.root, summary, nonce) };
  }

  try {
    const previous = latestDiscoverySnapshot(readObservationStore(options.root), options.machine.key);
    const { snapshot, deltas } = await refreshDiscovery({
      previous, probes: options.probes, machineKey: options.machine.key, now: options.now,
    });
    const appended = appendObservations(options.root,
      discoveryRefreshRecords(snapshot, deltas, options.machine, at, options.command),
      { origin: 'observedHere', receivedAt: at });
    const changes = deltas.filter(isDiscoveryChange);
    const summary: DiscoveryRunSummary = {
      ...base,
      status: 'completed',
      providersAnswered: snapshot.providers.filter((entry) => entry.refreshed).map((entry) => entry.provider),
      providersNotAnswered: snapshot.providers.filter((entry) => !entry.refreshed)
        .map((entry) => ({ provider: entry.provider, detail: entry.detail })),
      routes: snapshot.routes.length,
      changed: changes.length > 0,
      changes: changes.map((delta) => ({ routeKey: delta.routeKey, kinds: delta.kinds })),
      qualificationsNowStale: deltas.filter((delta) => delta.qualificationNowStale).length,
      observationsWritten: appended.written.length,
      observationsAlreadyHeld: appended.alreadyPresent.length,
    };
    return { summary, snapshot, deltas, recordPath: recordRun(options.root, summary, nonce) };
  } finally {
    lock.release();
  }
}
