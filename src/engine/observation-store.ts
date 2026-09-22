// Benchmark engine · THE DURABLE RECORD OF WHAT EACH MACHINE OBSERVED, and the only mechanism by
// which one machine learns what another one saw.
//
// WHY A MACHINE NEEDS THIS. Discovery, availability and billing observations are facts about a moment
// ON A MACHINE. Two Macs signed into the same accounts do not have the same routes available: one has
// a CLI installed and signed in, the other does not; one has 30 GiB of weights pulled, the other has
// four. Until this module existed, every one of those facts lived in memory for the length of one
// command, so the answer to "what is available across my machines" could not be asked at all, and the
// answer to "what was available here yesterday" was gone.
//
// WHAT IT IS. An APPEND-ONLY store of immutable, content-addressed observation records, one file per
// record, laid out by the machine that observed it. There is no current-truth file. "What is available
// now" is DERIVED at read time from the records, by the same freshness rules the rest of the engine
// uses, and a derivation is never written back — because a derived file is a second answer that starts
// disagreeing with the records the first time the rules change.
//
// THE FIVE RULES THIS STORE IS BUILT ON.
//
//   IDENTITY IS THE CONTENT. `recordID` is the digest of the record itself, under the canonical
//   encoding the manifests and ledger already use. The same observation, exported and imported any
//   number of times, is one file. That is what makes import IDEMPOTENT without a dedupe table.
//   THE OBSERVER IS ON THE RECORD. Every record carries the `cmk1:` key of the machine that made the
//   observation. An imported record keeps that key. A machine that imports "the OTHER machine has
//   gemma3 installed" learns exactly that, and `availabilityOnMachine` — which filters on machineKey —
//   still says gemma3 has never been observed HERE. The import cannot promote itself.
//   ORIGIN IS NOT PART OF THE RECORD. Whether a record arrived by observation or by import is a fact
//   about THIS store, not about the observation, so it is kept beside the record and outside its
//   digest. That is why the same record has the same identity on both machines.
//   NOTHING IS DELETED, INCLUDING WHAT WENT STALE. A stale observation is the evidence that something
//   was true and stopped being; overwriting it with a newer one would make the store unable to say
//   when. Newest-wins is a READ rule and never a write rule.
//   A FILE THAT DOES NOT VERIFY IS REFUSED, NOT IGNORED. A record whose bytes no longer digest to its
//   own name is reported, by path, with its reason. It is never parsed into the answer and never
//   silently skipped — a store that quietly drops what it cannot read is a store that answers
//   confidently with half its evidence.
//
// TRANSPORT-NEUTRAL BY CONSTRUCTION. An export is one JSON value. Nothing here knows how it travels —
// a shared directory, a USB stick, scp, a file somebody emails themselves. No hostname, no protocol
// and no absolute path outside the caller's own root appears in this file, and a test walks the source
// to hold it to that. A daemon can be built later without the format changing.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { CanonicalValue, canonicalJSON, compareCodePoints, digestObject } from './canonical';
import { DiscoveryDelta, DiscoverySnapshot } from './discovery-refresh';
import { MachineAvailability, MachineFingerprint, RouteAvailabilityObservation, availabilityOnMachine } from './machine-availability';
import { ProviderID } from './provider';

export const OBSERVATION_STORE_SCHEMA = 'cos1';
export const OBSERVATION_BUNDLE_SCHEMA = 'cob1';

/** What an observation can be ABOUT. A closed vocabulary: a reader can enumerate what a store holds. */
export type ObservationKind =
  /** The machine itself: fingerprint, label, when it reported. */
  | 'machine'
  /** A whole discovery refresh, as taken on one machine. */
  | 'discoverySnapshot'
  /** What one refresh CHANGED against the persisted previous one. */
  | 'discoveryDelta'
  /** Whether one provider answered from this machine. */
  | 'providerAvailability'
  /** Whether one route was reachable from this machine. */
  | 'routeAvailability'
  /** A local model present on this machine, with the weights digest that identifies it. */
  | 'localModelAvailability'
  /** A reading of the account's own billing for one route. Never a price list. */
  | 'billingObservation'
  /** That a qualification stopped describing the route that exists, and why. */
  | 'qualificationStaleness';

export const OBSERVATION_KINDS: ObservationKind[] = [
  'machine', 'discoverySnapshot', 'discoveryDelta', 'providerAvailability', 'routeAvailability',
  'localModelAvailability', 'billingObservation', 'qualificationStaleness',
];

/**
 * One immutable observation.
 *
 * EVERY FIELD BUT `recordID` IS INSIDE THE DIGEST. `recordID` is the digest, so it cannot be, and
 * `verifyObservationRecord` recomputes it from the rest to decide whether the file is intact.
 */
export interface ObservationRecord {
  schema: typeof OBSERVATION_STORE_SCHEMA;
  /** The digest of every other field. The record's identity, its filename, and its integrity check. */
  recordID: string;
  kind: ObservationKind;
  /** The `cmk1:` key of the machine that OBSERVED this. Survives every export and import unchanged. */
  machineKey: string;
  /** The hostname at observation time. A label for people; `machineKey` decides. */
  machineLabel: string;
  /** When the thing was observed. Not when it was written, and not when it was imported. */
  observedAt: string;
  /** What established it, in words a person can check. Never a bare tool name. */
  provenance: string;
  /** The route this is about, where it is about one. */
  routeKey?: string;
  provider?: ProviderID;
  /** When this observation stops being current. Absent means the reader's own window decides. */
  expiresAt?: string;
  /** The kind-specific payload. Canonically encodable, so the digest is stable across runtimes. */
  body: CanonicalValue;
}

/**
 * A record as THIS store holds it.
 *
 * `origin` and the import fields are outside the record and outside its digest, because they describe
 * this copy rather than the observation. That separation is what lets the same observation have the
 * same identity on the machine that made it and the machine that received it.
 */
export interface StoredObservation {
  record: ObservationRecord;
  origin: 'observedHere' | 'imported';
  /** When this store received it. For an `observedHere` record, when it was written. */
  receivedAt: string;
  /** The `cmk1:` key of the machine whose export carried it here. Absent for `observedHere`. */
  importedFromMachine?: string;
}

/** A store file that could not be trusted. Reported by path and reason; never parsed into an answer. */
export interface CorruptObservation {
  filePath: string;
  reason: string;
}

export interface ObservationStoreContents {
  schema: typeof OBSERVATION_STORE_SCHEMA;
  root: string;
  /** Every intact record, in a deterministic order: machine, then observedAt, then recordID. */
  observations: StoredObservation[];
  /** Every file that did not verify. A non-empty list is a finding, not a detail. */
  corrupt: CorruptObservation[];
}

export class ObservationStoreError extends Error {
  constructor(readonly code:
    | 'digestMismatch' | 'unreadable' | 'schemaMismatch' | 'missingField' | 'bundleDigestMismatch'
    | 'notAnObservationBundle',
  message: string) {
    super(message);
    this.name = 'ObservationStoreError';
  }
}

// MARK: - Identity

/** Everything the digest covers: the record without its own name. */
function digestableRecord(record: Omit<ObservationRecord, 'recordID'>): CanonicalValue {
  return {
    schema: record.schema,
    kind: record.kind,
    machineKey: record.machineKey,
    machineLabel: record.machineLabel,
    observedAt: record.observedAt,
    provenance: record.provenance,
    routeKey: record.routeKey,
    provider: record.provider,
    expiresAt: record.expiresAt,
    body: record.body,
  } as CanonicalValue;
}

/**
 * Seal an observation: compute its identity from its content.
 *
 * DETERMINISTIC AND MACHINE-INDEPENDENT. The same fields produce the same `recordID` on any machine
 * and in any runtime that agrees with `canonicalJSON`, which is the property the whole import path
 * depends on. Nothing here reads a clock: `observedAt` is supplied by the caller who did the observing.
 */
export function sealObservation(record: Omit<ObservationRecord, 'recordID' | 'schema'>): ObservationRecord {
  const withSchema: Omit<ObservationRecord, 'recordID'> = { ...record, schema: OBSERVATION_STORE_SCHEMA };
  return { ...withSchema, recordID: digestObject(digestableRecord(withSchema)) };
}

/** Does this record's content still digest to its own name? */
export function verifyObservationRecord(record: ObservationRecord): { intact: boolean; reason: string } {
  if (record.schema !== OBSERVATION_STORE_SCHEMA) {
    return { intact: false, reason: `schema is '${record.schema}', not ${OBSERVATION_STORE_SCHEMA}` };
  }
  for (const field of ['recordID', 'kind', 'machineKey', 'observedAt', 'provenance'] as const) {
    if (typeof record[field] !== 'string' || String(record[field]).trim().length === 0) {
      return { intact: false, reason: `${field} is missing or empty` };
    }
  }
  if (!OBSERVATION_KINDS.includes(record.kind)) {
    return { intact: false, reason: `kind '${record.kind}' is not one this build knows` };
  }
  let recomputed: string;
  try {
    recomputed = digestObject(digestableRecord(record));
  } catch (error) {
    return { intact: false, reason: `the record could not be canonically encoded: ${error instanceof Error ? error.message : String(error)}` };
  }
  return recomputed === record.recordID
    ? { intact: true, reason: 'the content digests to its own recordID' }
    : { intact: false, reason: `content digests to ${recomputed.slice(0, 16)}… but the record is named ${record.recordID.slice(0, 16)}…` };
}

// MARK: - Layout

export function observationStorePath(root: string): string {
  return path.join(root, '.observations');
}

/**
 * A machine key as a directory name.
 *
 * `cmk1:abcd…` contains a colon, which is legal on the filesystems this runs on and awkward on others
 * and in shells. The substitution is total and reversible in the only direction that matters — the
 * record inside still carries the real key, and the directory name is never read back as one.
 */
function machineDirectory(machineKey: string): string {
  return machineKey.replace(/[^A-Za-z0-9._-]/g, '-');
}

function recordPath(root: string, record: ObservationRecord): string {
  return path.join(observationStorePath(root), machineDirectory(record.machineKey), `${record.recordID}.json`);
}

// MARK: - Writing

/**
 * Write one file, atomically.
 *
 * A temporary beside the destination and a rename, because a rename within one directory is the only
 * write this code can make that a reader either sees entirely or does not see at all. A half-written
 * observation file would digest to nothing and be reported corrupt, which is safe — but a store that
 * accumulates corrupt files every time a laptop sleeps mid-write is a store nobody trusts.
 */
function writeFileAtomically(filePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  try {
    // FLUSHED BEFORE IT IS NAMED. A rename is atomic with respect to READERS, but on APFS and ext4 the
    // rename can reach the disk while the data blocks behind it have not — so a power loss lands a
    // zero-length file at the destination, under a name that promises a digest it does not have. That
    // is the one way a corrupt file survives this path, and one fsync closes it. The directory entry
    // is flushed too, so the rename itself cannot be the thing that is lost.
    const handle = fs.openSync(temporary, 'w');
    try {
      fs.writeFileSync(handle, contents, 'utf8');
      fs.fsyncSync(handle);
    } finally { fs.closeSync(handle); }
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, filePath);
    try {
      const directory = fs.openSync(path.dirname(filePath), 'r');
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    } catch {
      // A platform that will not let a directory be opened for fsync (Windows) loses only the
      // directory-entry guarantee; the file's own contents are already flushed, which is the half
      // that decides whether a reader sees a corrupt record.
    }
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
}

/**
 * Append observations to the store.
 *
 * ALREADY-PRESENT RECORDS ARE LEFT EXACTLY AS THEY ARE, including their `origin`. A record this
 * machine observed and later receives back in somebody's bundle stays `observedHere`: the stronger
 * claim is the true one, and an import must never be able to downgrade a first-hand observation into
 * a second-hand one.
 */
export function appendObservations(root: string, records: ObservationRecord[], options: {
  origin: StoredObservation['origin'];
  receivedAt: string;
  importedFromMachine?: string;
}): { written: ObservationRecord[]; alreadyPresent: ObservationRecord[]; refused: { record: ObservationRecord; reason: string }[] } {
  const written: ObservationRecord[] = [];
  const alreadyPresent: ObservationRecord[] = [];
  const refused: { record: ObservationRecord; reason: string }[] = [];

  for (const record of records) {
    const check = verifyObservationRecord(record);
    if (!check.intact) { refused.push({ record, reason: check.reason }); continue; }
    const filePath = recordPath(root, record);
    if (fs.existsSync(filePath)) { alreadyPresent.push(record); continue; }
    const stored: StoredObservation = {
      record,
      origin: options.origin,
      receivedAt: options.receivedAt,
      ...(options.origin === 'imported' && options.importedFromMachine !== undefined
        ? { importedFromMachine: options.importedFromMachine } : {}),
    };
    writeFileAtomically(filePath, JSON.stringify(stored, null, 2) + '\n');
    written.push(record);
  }
  return { written, alreadyPresent, refused };
}

/** Record something this machine observed itself. The common case. */
export function recordLocalObservation(root: string, record: ObservationRecord, receivedAt: string): boolean {
  return appendObservations(root, [record], { origin: 'observedHere', receivedAt }).written.length === 1;
}

// MARK: - Reading

/**
 * Read the whole store.
 *
 * READ-ONLY IN THE STRICT SENSE: it creates nothing, corrects nothing and does not touch a file it
 * found unreadable. An absent store is an empty store, not an error — a machine that has observed
 * nothing yet has observed nothing, and that is a fine thing to report.
 */
export function readObservationStore(root: string): ObservationStoreContents {
  const storeRoot = observationStorePath(root);
  const observations: StoredObservation[] = [];
  const corrupt: CorruptObservation[] = [];
  if (!fs.existsSync(storeRoot)) {
    return { schema: OBSERVATION_STORE_SCHEMA, root: storeRoot, observations, corrupt };
  }

  const directories = fs.readdirSync(storeRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  for (const directory of directories) {
    // A MACHINE DIRECTORY THAT CANNOT BE LISTED IS A FINDING, NOT A CRASH. Same rule as a file.
    let files: string[];
    try {
      files = fs.readdirSync(path.join(storeRoot, directory)).filter((name) => name.endsWith('.json')).sort();
    } catch (error) {
      corrupt.push({ filePath: path.join(storeRoot, directory),
        reason: `the directory could not be listed: ${error instanceof Error ? error.message : String(error)}` });
      continue;
    }
    for (const name of files) {
      const filePath = path.join(storeRoot, directory, name);
      // EVERY STEP FROM BYTES TO RECORD IS INSIDE THE GUARD, not only the parse.
      //
      // `JSON.parse` succeeds on `null`, on `5` and on `"x"`, and a file holding any of them used to
      // reach `parsed.record` — where `null` threw a TypeError that escaped this function and took
      // down every command that reads the store. A store whose whole purpose is to REPORT what it
      // cannot trust must not be brought down by the first thing it cannot trust, so the guard covers
      // the read, the parse and the shape check together.
      let parsed: Partial<StoredObservation> | undefined;
      try {
        const bytes = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
        if (bytes === null || typeof bytes !== 'object' || Array.isArray(bytes)) {
          corrupt.push({ filePath, reason: `the file holds ${bytes === null ? 'null' : Array.isArray(bytes) ? 'an array' : typeof bytes}, `
            + 'not a stored observation' });
          continue;
        }
        parsed = bytes as Partial<StoredObservation>;
      } catch (error) {
        corrupt.push({ filePath, reason: `the file is not readable JSON: ${error instanceof Error ? error.message : String(error)}` });
        continue;
      }
      const candidate: unknown = parsed.record;
      if (candidate === null || candidate === undefined || typeof candidate !== 'object' || Array.isArray(candidate)) {
        corrupt.push({ filePath, reason: 'the file carries no usable `record` (it holds '
          + `${candidate === null ? 'null' : candidate === undefined ? 'nothing' : Array.isArray(candidate) ? 'an array' : typeof candidate})` });
        continue;
      }
      const record = candidate as ObservationRecord;
      const check = verifyObservationRecord(record);
      if (!check.intact) { corrupt.push({ filePath, reason: check.reason }); continue; }
      // THE FILENAME IS PART OF THE CHECK. A record whose bytes are intact but which was moved into
      // another record's name is still a store that would answer the wrong thing when asked by id.
      if (name !== `${record.recordID}.json`) {
        corrupt.push({ filePath, reason: `the file is named ${name} but holds ${record.recordID}.json` });
        continue;
      }
      observations.push({
        record,
        origin: parsed.origin === 'imported' ? 'imported' : 'observedHere',
        receivedAt: typeof parsed.receivedAt === 'string' ? parsed.receivedAt : '',
        ...(typeof parsed.importedFromMachine === 'string' ? { importedFromMachine: parsed.importedFromMachine } : {}),
      });
    }
  }
  observations.sort(compareStored);
  return { schema: OBSERVATION_STORE_SCHEMA, root: storeRoot, observations, corrupt };
}

/**
 * The one ordering this store sorts by, everywhere.
 *
 * NOT `localeCompare`. That is locale- and ICU-dependent, and these are machine keys, instants and
 * digests — values with a byte order, not a human collation. `compareCodePoints` is the comparator
 * the canonical encoder already uses, so the store's order is the same order in every runtime and on
 * every machine, which is what makes two stores comparable at all.
 */
function compareStored(a: StoredObservation, b: StoredObservation): number {
  return compareCodePoints(a.record.machineKey, b.record.machineKey)
    || compareInstants(a.record.observedAt, b.record.observedAt)
    || compareCodePoints(a.record.recordID, b.record.recordID);
}

/**
 * Two ISO-8601 instants, compared as instants.
 *
 * The store holds both second-truncated (`…T00:00:00Z`) and millisecond (`…T00:00:00.500Z`) spellings,
 * and lexicographic order happens to agree with chronological order for both today. It stops agreeing
 * the moment an offset spelling (`…+01:00`) appears, so the parse decides and the text is only the
 * tie-break that keeps an unparseable value in a deterministic place.
 */
function compareInstants(a: string, b: string): number {
  const at = Date.parse(a);
  const bt = Date.parse(b);
  if (!Number.isNaN(at) && !Number.isNaN(bt) && at !== bt) return at < bt ? -1 : 1;
  return compareCodePoints(a, b);
}

/** Every machine this store holds observations from, with how many and whether they were made here. */
export function machinesInStore(contents: ObservationStoreContents): {
  machineKey: string; machineLabel: string; origin: StoredObservation['origin']; observationCount: number;
  earliestObservedAt: string; latestObservedAt: string;
}[] {
  const keys = [...new Set(contents.observations.map((entry) => entry.record.machineKey))].sort();
  return keys.map((machineKey) => {
    const mine = contents.observations.filter((entry) => entry.record.machineKey === machineKey);
    const latest = mine[mine.length - 1];
    return {
      machineKey,
      machineLabel: latest?.record.machineLabel ?? machineKey,
      // A machine is "observed here" only if EVERY record from it was. One imported record makes the
      // machine a remote one whose observations this store received, which is the honest summary.
      origin: mine.every((entry) => entry.origin === 'observedHere') ? 'observedHere' : 'imported',
      observationCount: mine.length,
      earliestObservedAt: mine[0]?.record.observedAt ?? '',
      latestObservedAt: latest?.record.observedAt ?? '',
    };
  });
}

// MARK: - The kinds, as constructors

export function machineObservation(fingerprint: MachineFingerprint, machineKey: string, observedAt: string,
                                   provenance: string): ObservationRecord {
  return sealObservation({
    kind: 'machine', machineKey, machineLabel: fingerprint.hostname, observedAt, provenance,
    body: { ...fingerprint } as unknown as CanonicalValue,
  });
}

export function discoverySnapshotObservation(snapshot: DiscoverySnapshot, machineLabel: string,
                                             provenance: string): ObservationRecord {
  return sealObservation({
    kind: 'discoverySnapshot', machineKey: snapshot.machineKey, machineLabel, observedAt: snapshot.takenAt,
    provenance, body: snapshot as unknown as CanonicalValue,
  });
}

export function discoveryDeltaObservation(delta: DiscoveryDelta, machineKey: string, machineLabel: string,
                                          observedAt: string, provenance: string): ObservationRecord {
  return sealObservation({
    kind: 'discoveryDelta', machineKey, machineLabel, observedAt, provenance, routeKey: delta.routeKey,
    body: delta as unknown as CanonicalValue,
  });
}

export function routeAvailabilityObservation(observation: RouteAvailabilityObservation, provider: ProviderID,
                                             provenance: string): ObservationRecord {
  return sealObservation({
    kind: observation.runtimeDigest === undefined ? 'routeAvailability' : 'localModelAvailability',
    machineKey: observation.machineKey, machineLabel: observation.machineLabel, observedAt: observation.observedAt,
    provenance, routeKey: observation.routeKey, provider,
    body: {
      available: observation.available, reason: observation.reason,
      runtimeDigest: observation.runtimeDigest,
    } as CanonicalValue,
  });
}

export function providerAvailabilityObservation(options: {
  provider: ProviderID; machineKey: string; machineLabel: string; observedAt: string;
  answered: boolean; detail: string; provenance: string;
}): ObservationRecord {
  return sealObservation({
    kind: 'providerAvailability', machineKey: options.machineKey, machineLabel: options.machineLabel,
    observedAt: options.observedAt, provenance: options.provenance, provider: options.provider,
    body: { answered: options.answered, detail: options.detail } as CanonicalValue,
  });
}

/**
 * A reading of the account's OWN billing for one route.
 *
 * WHAT THIS IS NOT. It is not a price. A published $0 list price is a statement of intent by a
 * provider, and recording one here under the name of an observation would put the exact confusion
 * `cost-eligibility.ts` refuses into a durable store, where it would outlive the person who made the
 * mistake. `observedBillingRecord` names what was READ — an invoice, a usage export, a dashboard page
 * and the day it was read — and `cost-eligibility.ts` validates the confirmation this record carries.
 */
export function billingObservation(options: {
  routeKey: string; provider: ProviderID; machineKey: string; machineLabel: string;
  observedAt: string; accountBasis: string; observedBillingRecord: string; confirmedBy: string;
  zeroMarginalCost: boolean; expiresAt?: string; provenance: string;
}): ObservationRecord {
  return sealObservation({
    kind: 'billingObservation', machineKey: options.machineKey, machineLabel: options.machineLabel,
    observedAt: options.observedAt, provenance: options.provenance, routeKey: options.routeKey,
    provider: options.provider, ...(options.expiresAt === undefined ? {} : { expiresAt: options.expiresAt }),
    body: {
      accountBasis: options.accountBasis, observedBillingRecord: options.observedBillingRecord,
      confirmedBy: options.confirmedBy, zeroMarginalCost: options.zeroMarginalCost,
    } as CanonicalValue,
  });
}

export function qualificationStalenessObservation(options: {
  routeKey: string; provider: ProviderID; machineKey: string; machineLabel: string; observedAt: string;
  reasons: string[]; detail: string[]; provenance: string;
}): ObservationRecord {
  return sealObservation({
    kind: 'qualificationStaleness', machineKey: options.machineKey, machineLabel: options.machineLabel,
    observedAt: options.observedAt, provenance: options.provenance, routeKey: options.routeKey,
    provider: options.provider,
    // SORTED AS PAIRS OR NOT AT ALL. `qualificationStaleness` builds `reasons` and `detail` in
    // lockstep — detail[i] explains reasons[i] — so sorting one alone silently re-attributes every
    // sentence to the wrong reason, durably, in a record nobody re-derives. They are sorted together,
    // which keeps the determinism the digest needs and the pairing the record is for.
    body: (() => {
      const paired = options.reasons.map((reason, index) => ({ reason, detail: options.detail[index] ?? '' }))
        .sort((a, b) => (a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0));
      return { reasons: paired.map((entry) => entry.reason), detail: paired.map((entry) => entry.detail) };
    })() as CanonicalValue,
  });
}

// MARK: - Derived views

/**
 * The availability observations in this store, as the engine's own type.
 *
 * `origin` is deliberately NOT carried into `RouteAvailabilityObservation`, because that type feeds
 * `availabilityOnMachine`, which filters on `machineKey` and must not start making decisions about
 * where a record came from. Where a caller needs the origin — a status view, an export — it reads it
 * from `fleetAvailability` below, which keeps the two side by side.
 */
export function availabilityObservationsFrom(contents: ObservationStoreContents): RouteAvailabilityObservation[] {
  return contents.observations
    .filter((entry) => entry.record.kind === 'routeAvailability' || entry.record.kind === 'localModelAvailability')
    .map((entry) => {
      const body = entry.record.body as { available?: boolean; reason?: string; runtimeDigest?: string };
      return {
        routeKey: entry.record.routeKey ?? '',
        machineKey: entry.record.machineKey,
        machineLabel: entry.record.machineLabel,
        observedAt: entry.record.observedAt,
        available: body.available === true,
        reason: typeof body.reason === 'string' ? body.reason : '',
        ...(typeof body.runtimeDigest === 'string' ? { runtimeDigest: body.runtimeDigest } : {}),
      };
    });
}

/** The newest discovery snapshot taken ON one machine. Snapshots are never merged across machines. */
export function latestDiscoverySnapshot(contents: ObservationStoreContents, machineKey: string): DiscoverySnapshot | undefined {
  const snapshots = contents.observations
    .filter((entry) => entry.record.kind === 'discoverySnapshot' && entry.record.machineKey === machineKey)
    .sort((a, b) => compareInstants(a.record.observedAt, b.record.observedAt));
  const latest = snapshots[snapshots.length - 1];
  return latest === undefined ? undefined : latest.record.body as unknown as DiscoverySnapshot;
}

/**
 * Every route's availability, per machine, with where the knowledge came from.
 *
 * THE `observedHere` / `imported` DISTINCTION IS THE POINT OF THIS VIEW. A machine reading it sees
 * that ANOTHER machine reported `ollama:gemma3:4b` available at time T — and sees, in the same row, that
 * the observation was IMPORTED and was made on a machine that is not this one. Nothing in this
 * function can produce a row claiming a route is available *here* on the strength of a record made
 * elsewhere, because the machine key that groups the rows is the one the observer wrote.
 */
export function fleetAvailability(contents: ObservationStoreContents, now: Date, maxAge?: number): {
  routeKey: string;
  machines: {
    machineKey: string; machineLabel: string; origin: StoredObservation['origin'];
    availability: MachineAvailability; importedFromMachine?: string;
  }[];
}[] {
  const observations = availabilityObservationsFrom(contents);
  const routeKeys = [...new Set(observations.map((entry) => entry.routeKey))].sort();
  return routeKeys.map((routeKey) => {
    const machineKeys = [...new Set(observations.filter((entry) => entry.routeKey === routeKey)
      .map((entry) => entry.machineKey))].sort();
    return {
      routeKey,
      machines: machineKeys.map((machineKey) => {
        const availability = availabilityOnMachine(observations, routeKey, machineKey, now, maxAge);
        const stored = contents.observations
          .filter((entry) => entry.record.routeKey === routeKey && entry.record.machineKey === machineKey
            && (entry.record.kind === 'routeAvailability' || entry.record.kind === 'localModelAvailability'))
          .sort((a, b) => compareInstants(a.record.observedAt, b.record.observedAt));
        const latest = stored[stored.length - 1];
        return {
          machineKey,
          machineLabel: availability.latest?.machineLabel ?? machineKey,
          origin: latest?.origin ?? 'observedHere',
          availability,
          ...(latest?.importedFromMachine === undefined ? {} : { importedFromMachine: latest.importedFromMachine }),
        };
      }),
    };
  });
}

/** The sentence a surface prints beside an imported row, so nobody reads it as a local fact. */
export const IMPORTED_OBSERVATION_IS_NOT_LOCAL =
  'This was observed on ANOTHER machine and imported here. It says that route was reachable from THAT machine at that '
  + 'time. It says nothing about whether the route is reachable from this one, and this machine will not treat it as if '
  + 'it did: availability is always answered from observations taken on the machine being asked about.';

// MARK: - Export and import

export interface ObservationBundle {
  schema: typeof OBSERVATION_BUNDLE_SCHEMA;
  /** The store schema the records inside are written under. */
  recordSchema: typeof OBSERVATION_STORE_SCHEMA;
  exportedAt: string;
  /** The machine that produced the bundle. NOT necessarily the machine that made every record in it. */
  exportedFromMachine: string;
  exportedFromLabel: string;
  records: ObservationRecord[];
  /**
   * The digest of WHAT THIS BUNDLE HOLDS — the records alone, sorted by their own identity.
   *
   * TWO DIGESTS, BECAUSE THEY ANSWER TWO DIFFERENT QUESTIONS, and one value cannot answer both.
   * This one answers "do we hold the same thing?", so it must NOT move when the same set is
   * exported again a minute later, from the other machine, or by a different person.
   */
  contentDigest: string;
  /**
   * The digest of everything above, INCLUDING who exported it and when. A bundle whose bytes moved
   * is refused on import.
   *
   * This one answers "did these bytes arrive as they left?", so it must move when anything at all
   * moves — which is exactly why it cannot double as the comparability digest.
   */
  bundleDigest: string;
}

/**
 * What a bundle's CONTENT digest is taken over: the records, and the schema they are written under.
 *
 * `exportedAt`, `exportedFromMachine` and `exportedFromLabel` are deliberately excluded. They
 * describe the ACT of exporting, not the thing exported, and folding them in is what made the
 * documented comparability guarantee unachievable: `exportedAt` is a wall clock, so two exports of
 * an identical set could never agree, and "two machines can tell whether they hold the same thing"
 * was false for every bundle this engine had ever written.
 */
function digestableContent(records: ObservationRecord[]): CanonicalValue {
  return {
    recordSchema: OBSERVATION_STORE_SCHEMA,
    records: records as unknown as CanonicalValue,
  } as CanonicalValue;
}

function digestableBundle(bundle: Omit<ObservationBundle, 'bundleDigest'>): CanonicalValue {
  return {
    schema: bundle.schema, recordSchema: bundle.recordSchema, exportedAt: bundle.exportedAt,
    exportedFromMachine: bundle.exportedFromMachine, exportedFromLabel: bundle.exportedFromLabel,
    contentDigest: bundle.contentDigest,
    records: bundle.records as unknown as CanonicalValue,
  } as CanonicalValue;
}

/**
 * Export observations as one transport-neutral value.
 *
 * WHAT IT DOES NOT CARRY. `origin` is left behind on purpose: it is this store's opinion of how it got
 * a record, and it would be a lie on the other side. The receiving store decides its own origin, and
 * the record's `machineKey` — which travels — is what actually says who observed it.
 *
 * SORTED BY RECORD IDENTITY, so exporting the same set twice produces the same `contentDigest`.
 * A bundle is comparable on THAT value, and two machines can tell whether they hold the same thing.
 *
 * THE WHOLE BYTES ARE NOT STABLE, AND SAYING SO IS THE POINT. `exportedAt` moves on every export, so
 * `bundleDigest` — which seals it, on purpose — moves too. Comparability and integrity are separate
 * questions and this returns a separate answer to each. Comparing `bundleDigest` between two
 * machines answers neither: it reports that two exports happened at two times, which was never in
 * doubt.
 */
export function exportObservations(root: string, options: {
  exportedFromMachine: string; exportedFromLabel: string; exportedAt: string;
  /** Only records observed on these machines. Absent means every machine the store holds. */
  machineKeys?: string[];
  /** Only records observed at or after this instant. */
  since?: string;
  kinds?: ObservationKind[];
}): { bundle: ObservationBundle; corrupt: CorruptObservation[] } {
  const contents = readObservationStore(root);
  const records = contents.observations
    .map((entry) => entry.record)
    .filter((record) => options.machineKeys === undefined || options.machineKeys.includes(record.machineKey))
    .filter((record) => options.since === undefined || record.observedAt >= options.since)
    .filter((record) => options.kinds === undefined || options.kinds.includes(record.kind))
    .sort((a, b) => compareCodePoints(a.recordID, b.recordID));
  const withoutDigest: Omit<ObservationBundle, 'bundleDigest'> = {
    schema: OBSERVATION_BUNDLE_SCHEMA, recordSchema: OBSERVATION_STORE_SCHEMA,
    exportedAt: options.exportedAt, exportedFromMachine: options.exportedFromMachine,
    exportedFromLabel: options.exportedFromLabel,
    contentDigest: digestObject(digestableContent(records)),
    records,
  };
  return {
    bundle: { ...withoutDigest, bundleDigest: digestObject(digestableBundle(withoutDigest)) },
    corrupt: contents.corrupt,
  };
}

export function writeObservationBundle(filePath: string, bundle: ObservationBundle): void {
  writeFileAtomically(filePath, JSON.stringify(bundle, null, 2) + '\n');
}

/**
 * Read a bundle and prove it is what it says it is, before a single record is considered.
 *
 * THROWS RATHER THAN RETURNING A PARTIAL BUNDLE. A bundle is the one place an outside byte stream
 * enters this store, and "import what parsed" is how half a fleet view gets built out of a truncated
 * file somebody copied while it was still being written.
 */
export function readObservationBundle(filePath: string): ObservationBundle {
  let parsed: Partial<ObservationBundle>;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<ObservationBundle>;
  } catch (error) {
    throw new ObservationStoreError('unreadable',
      `${filePath}: the bundle is not readable JSON (${error instanceof Error ? error.message : String(error)}). Nothing was imported.`);
  }
  if (parsed.schema !== OBSERVATION_BUNDLE_SCHEMA) {
    throw new ObservationStoreError('notAnObservationBundle',
      `${filePath}: this is not a Cernum observation bundle — its schema is '${String(parsed.schema)}', not ${OBSERVATION_BUNDLE_SCHEMA}. `
      + 'Nothing was imported.');
  }
  if (parsed.recordSchema !== OBSERVATION_STORE_SCHEMA) {
    throw new ObservationStoreError('schemaMismatch',
      `${filePath}: the bundle carries ${String(parsed.recordSchema)} records and this build reads ${OBSERVATION_STORE_SCHEMA}. `
      + 'Nothing was imported; a later build that understands both can migrate it.');
  }
  const records = Array.isArray(parsed.records) ? parsed.records : [];
  // RECOMPUTED FROM THE RECORDS, NEVER READ OFF THE FILE. A content digest a bundle asserts about
  // itself is worth nothing; this one is derived from the bytes that arrived. It then goes INTO the
  // bundle digest below, so a file whose `contentDigest` was edited to match some other machine's
  // fails the integrity check rather than passing a comparison it was doctored to pass.
  const withoutDigest: Omit<ObservationBundle, 'bundleDigest'> = {
    schema: OBSERVATION_BUNDLE_SCHEMA, recordSchema: OBSERVATION_STORE_SCHEMA,
    exportedAt: String(parsed.exportedAt ?? ''), exportedFromMachine: String(parsed.exportedFromMachine ?? ''),
    exportedFromLabel: String(parsed.exportedFromLabel ?? ''),
    contentDigest: digestObject(digestableContent(records)),
    records,
  };
  let recomputed: string;
  try {
    recomputed = digestObject(digestableBundle(withoutDigest));
  } catch (error) {
    throw new ObservationStoreError('bundleDigestMismatch',
      `${filePath}: the bundle could not be canonically encoded, so its digest cannot be checked `
      + `(${error instanceof Error ? error.message : String(error)}). Nothing was imported.`);
  }
  if (recomputed !== parsed.bundleDigest) {
    throw new ObservationStoreError('bundleDigestMismatch',
      `${filePath}: the bundle digests to ${recomputed.slice(0, 16)}… and calls itself ${String(parsed.bundleDigest).slice(0, 16)}…. `
      + 'Its bytes changed after it was written — a truncated copy, an edit, or a transfer that did not complete. Nothing was '
      + 'imported; re-export it from the machine that made it.');
  }
  return { ...withoutDigest, bundleDigest: recomputed };
}

export interface ImportOutcome {
  /** Records this store did not have, now written. */
  imported: ObservationRecord[];
  /** Records it already held, by recordID. Their existing origin and receivedAt are untouched. */
  duplicates: ObservationRecord[];
  /** Records whose own digest did not check out. Named, with the reason, and not written. */
  refused: { record: ObservationRecord; reason: string }[];
  /** Machines this bundle carried observations from. */
  machines: string[];
  bundle: ObservationBundle;
}

/**
 * Import a bundle into this store.
 *
 * IDEMPOTENT BY IDENTITY, NOT BY BOOKKEEPING. Importing the same bundle a hundred times writes the
 * files once, because a record's name IS its content. Nothing is versioned, merged or reconciled:
 * two observations of the same route at the same instant with different content are two different
 * records and both are kept, which is the only representation that can later show that two machines
 * disagreed rather than quietly picking one of them.
 *
 * A RECORD OBSERVED ON THE IMPORTING MACHINE IS STILL IMPORTED, and still carries its original
 * `machineKey` — but if this store already holds it, the existing copy and its `observedHere` origin
 * win. Receiving your own observation back from somebody else does not make it second-hand.
 */
export function importObservations(root: string, filePath: string, receivedAt: string): ImportOutcome {
  const bundle = readObservationBundle(filePath);
  const result = appendObservations(root, bundle.records, {
    origin: 'imported', receivedAt, importedFromMachine: bundle.exportedFromMachine,
  });
  return {
    imported: result.written,
    duplicates: result.alreadyPresent,
    refused: result.refused,
    machines: [...new Set(bundle.records.map((record) => record.machineKey))].sort(),
    bundle,
  };
}

/**
 * A shared directory two machines both reach, if the operator has one.
 *
 * NOT A TRANSPORT AND NOT A PROTOCOL. It is a path the operator supplies, and this function only says
 * what a bundle from a given machine is called inside it, so two machines writing into the same folder
 * do not overwrite each other. Nothing here mounts anything, knows any service, or assumes the
 * directory exists on more than one machine at once; a bundle written here is the same bundle written
 * anywhere else.
 */
export function sharedBundleName(machineKey: string, exportedAt: string): string {
  return `observations-${machineDirectory(machineKey)}-${exportedAt.replace(/[^0-9A-Za-z]/g, '')}.json`;
}

/** What a store holds, as one line per machine, for a terminal or a report. */
export function describeObservationStore(contents: ObservationStoreContents): string[] {
  if (contents.observations.length === 0 && contents.corrupt.length === 0) {
    return ['This machine has recorded no observations yet.'];
  }
  const lines = machinesInStore(contents).map((machine) => {
    const origin = machine.origin === 'observedHere' ? 'observed here' : 'imported';
    return `  ${machine.machineKey}  ${machine.machineLabel.padEnd(20)} ${String(machine.observationCount).padStart(5)} `
      + `observation(s), ${origin}, ${machine.earliestObservedAt} … ${machine.latestObservedAt}`;
  });
  if (contents.corrupt.length > 0) {
    lines.push('', `${contents.corrupt.length} file(s) did not verify and were NOT read:`);
    for (const entry of contents.corrupt) lines.push(`  ${entry.filePath}: ${entry.reason}`);
  }
  return lines;
}

/** The canonical bytes of one record, for a caller that wants to compare two stores without parsing. */
export function observationBytes(record: ObservationRecord): string {
  return canonicalJSON(digestableRecord(record));
}
