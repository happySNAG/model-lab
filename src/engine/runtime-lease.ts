// Benchmark engine · the runtime-endpoint lease.
//
// WHAT THE CAMPAIGN LOCK DOES NOT COVER. The campaign lock stops two processes running the SAME
// campaign. It says nothing about two DIFFERENT campaigns pointed at the same Ollama. That is not a
// theoretical gap: two campaigns sharing one runtime take turns loading each other's weights out of
// memory, so every latency either of them records is a measurement of the other campaign. Worse,
// each one's residency proof is a lie the moment the other loads a model — the proof was true when
// it was taken, and false a second later. Nothing in either ledger would show it. Both would finish
// clean, and both would be wrong.
//
// So a canonical campaign takes a lease on the runtime as well as a lock on itself, before any
// inference request is sent.
//
// KEYED BY THE ENDPOINT, NOT BY THE STORE. The exclusion key is the NORMALIZED endpoint and nothing
// else, because that is what is actually being contended: one server, one set of weights in memory,
// one thermal state. `localhost`, `127.0.0.1` and `::1` with or without a trailing slash are all one
// endpoint and all take the same lease. The model-store identity is RECORDED in the lease rather
// than keyed on, deliberately: keying on it would let two campaigns that happen to see different
// store listings both believe they own the same server, which is the exact failure this prevents.
// Recorded, it tells the second caller what the first is measuring against.
//
// GENUINELY SEPARATE ENDPOINTS RUN CONCURRENTLY. Two Ollama servers on two ports are two leases and
// two campaigns, in parallel, with no contention — which is the whole reason this is a lease on the
// runtime rather than a global "one campaign at a time" flag.
//
// Liveness, staleness, unresponsiveness and foreign hosts are decided by the SAME rules as the
// campaign lock, from the same code. A live lease is never broken automatically.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { CanonicalValue } from './canonical';
import { atomicWriteJSON } from './ledger';
import {
  CampaignLockError, CampaignLockHandle, LockInspection, LockOptions, LockProcessType, LockRecord,
  classifyOwner, lockInternals,
} from './lock';
import { normalizeEndpoint } from './execution';
import { sha256Text } from './canonical';

export const LEASE_FORMAT_VERSION = 1;

/** Where leases live: beside the campaigns, because every surface shares that directory already. */
export const LEASE_DIRECTORY_NAME = '.runtime-leases';

export function runtimeLeaseDirectory(campaignRoot: string): string {
  return path.join(campaignRoot, LEASE_DIRECTORY_NAME);
}

/** One file per endpoint. The name is a digest so an endpoint is never a path traversal. */
export function runtimeLeasePath(campaignRoot: string, endpoint: string): string {
  return path.join(runtimeLeaseDirectory(campaignRoot), `${sha256Text(normalizeEndpoint(endpoint)).slice(0, 32)}.lease`);
}

export interface RuntimeLeaseRequest {
  processType: LockProcessType;
  command: string;
  campaignID: string;
  campaignName: string;
  /** As the caller spelled it. Normalized internally; both are recorded. */
  endpoint: string;
  modelStoreListingDigest?: string;
  modelStoreCount?: number;
}

export class RuntimeLeaseError extends CampaignLockError {
  constructor(code: 'heldByLiveOwner' | 'ownerUnresponsive' | 'foreignHost' | 'lostRace',
              message: string, inspection: LockInspection, readonly endpoint: string) {
    super(code, message, inspection);
    this.name = 'RuntimeLeaseError';
  }
}

function describe(record: LockRecord, state: string, ageMilliseconds: number, endpoint: string): string {
  const who = `${record.processType} process ${record.pid} on ${record.hostname}`;
  const seconds = Math.round(ageMilliseconds / 1000);
  const store = record.modelStoreCount !== undefined
    ? ` It sees ${record.modelStoreCount} model(s) installed there (${(record.modelStoreListingDigest ?? '').slice(0, 12)}).`
    : '';
  switch (state) {
    case 'live':
      return `the benchmark endpoint ${endpoint} is already held by campaign '${record.campaignName}', running in the ${who} `
        + `(${record.command}), which last reported ${seconds}s ago.${store} `
        + 'Two campaigns sharing one runtime take turns evicting each other\'s weights, so every latency either of them '
        + 'records measures the other campaign — and each one\'s residency proof stops being true the moment the other '
        + 'loads a model. The second is refused. Wait for it to finish, or point this campaign at a different endpoint.';
    case 'selfHeld':
      return `the benchmark endpoint ${endpoint} is already held by this process, for campaign '${record.campaignName}'.`;
    case 'stale':
      return `the benchmark endpoint ${endpoint} was left leased by campaign '${record.campaignName}' in the ${who} `
        + `(${record.command}), which no longer exists — it crashed or was killed. The lease is recoverable and will be reclaimed.`;
    case 'unresponsive':
      return `the benchmark endpoint ${endpoint} is leased by campaign '${record.campaignName}' in the ${who}, whose process `
        + `still exists but has not reported for ${seconds}s. That is either a hung runner or an unrelated process that was `
        + 'given the same process number, and this engine will not guess which. Stop that process if it is the runner, then '
        + 'release the lease explicitly.';
    default:
      return `the benchmark endpoint ${endpoint} is leased by campaign '${record.campaignName}' in the ${who}, and whether that `
        + 'machine is still running it cannot be seen from here. Confirm the other machine has stopped, then release the lease explicitly.';
  }
}

/** Read the lease for one endpoint and say what it means. Never writes. */
export function inspectRuntimeLease(campaignRoot: string, endpoint: string, options: LockOptions = {}): LockInspection {
  const file = runtimeLeasePath(campaignRoot, endpoint);
  const normalized = normalizeEndpoint(endpoint);
  if (!fs.existsSync(file)) return { held: false, message: `no campaign holds ${normalized}`, recoverable: false };
  const record = lockInternals.readRecord(file);
  if (!record) {
    return {
      held: true,
      message: `a lease file for ${normalized} exists but does not decode; it was written by an interrupted acquisition and can be reclaimed`,
      recoverable: true,
    };
  }
  const { state, ageMilliseconds } = classifyOwner(record, options);
  return {
    held: true,
    record,
    state,
    heartbeatAgeMilliseconds: ageMilliseconds,
    message: describe(record, state, ageMilliseconds, normalized),
    recoverable: state === 'stale',
  };
}

/**
 * Take the runtime for one campaign, or explain precisely why it cannot be taken.
 *
 * Same atomicity as the campaign lock: one create-exclusive syscall, and a rename-first gate before
 * any crashed owner's lease is reclaimed, so exactly one of two simultaneous recoverers wins.
 */
export function acquireRuntimeLease(campaignRoot: string, request: RuntimeLeaseRequest, options: LockOptions = {}): CampaignLockHandle {
  const settings = lockInternals.resolve(options);
  const directory = runtimeLeaseDirectory(campaignRoot);
  const file = runtimeLeasePath(campaignRoot, request.endpoint);
  const normalized = normalizeEndpoint(request.endpoint);
  fs.mkdirSync(directory, { recursive: true });

  const record: LockRecord = {
    lockFormatVersion: LEASE_FORMAT_VERSION,
    nonce: lockInternals.newNonce(),
    pid: process.pid,
    processType: request.processType,
    command: request.command,
    hostname: settings.hostname,
    campaignID: request.campaignID,
    campaignName: request.campaignName,
    endpoint: normalized,
    endpointAsGiven: request.endpoint,
    modelStoreListingDigest: request.modelStoreListingDigest,
    modelStoreCount: request.modelStoreCount,
    acquiredAt: lockInternals.iso(settings.now()),
    heartbeatAt: lockInternals.iso(settings.now()),
  };

  try {
    lockInternals.write(file, record);
    return new CampaignLockHandle(file, record, settings);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }

  const inspection = inspectRuntimeLease(campaignRoot, request.endpoint, options);
  if (!inspection.recoverable) {
    const state = inspection.state ?? 'live';
    const code = state === 'foreignHost' ? 'foreignHost' : state === 'unresponsive' ? 'ownerUnresponsive' : 'heldByLiveOwner';
    throw new RuntimeLeaseError(code, inspection.message, inspection, normalized);
  }

  const reclaimed = `${file}.reclaiming-${record.nonce}`;
  try {
    fs.renameSync(file, reclaimed);
  } catch {
    const after = inspectRuntimeLease(campaignRoot, request.endpoint, options);
    throw new RuntimeLeaseError('lostRace', `another campaign reclaimed ${normalized} first. ${after.message}`, after, normalized);
  }

  try {
    lockInternals.write(file, record);
  } catch (error) {
    try { fs.renameSync(reclaimed, file); } catch { /* the reclaim file remains as the record */ }
    throw error;
  }

  const crashed = inspection.record;
  const evidence = path.join(directory, 'recovered');
  fs.mkdirSync(evidence, { recursive: true });
  const stamp = lockInternals.iso(settings.now()).replace(/:/g, '');
  atomicWriteJSON(path.join(evidence, `recovered-${stamp}-${record.nonce.slice(0, 8)}.json`), {
    recoveredAt: lockInternals.iso(settings.now()),
    endpoint: normalized,
    recoveredBy: { pid: record.pid, processType: record.processType, command: record.command, campaignName: record.campaignName },
    crashedOwner: (crashed ?? null) as unknown as CanonicalValue,
    why: crashed
      ? `campaign '${crashed.campaignName}' in process ${crashed.pid} on ${crashed.hostname} held ${normalized} and no longer exists; its lease was reclaimed`
      : 'the previous lease file did not decode and was reclaimed',
  });
  try { fs.unlinkSync(reclaimed); } catch { /* already gone */ }

  return new CampaignLockHandle(file, record, settings, crashed);
}

/** Release a lease this process does not own — the explicit human action, as for a campaign lock. */
export function breakRuntimeLease(campaignRoot: string, endpoint: string, why: string,
                                  options: LockOptions & { force?: boolean } = {}): LockInspection {
  const inspection = inspectRuntimeLease(campaignRoot, endpoint, options);
  if (!inspection.held) return inspection;
  const normalized = normalizeEndpoint(endpoint);
  if (!inspection.recoverable && options.force !== true) {
    const state = inspection.state ?? 'live';
    const code = state === 'foreignHost' ? 'foreignHost' : state === 'unresponsive' ? 'ownerUnresponsive' : 'heldByLiveOwner';
    throw new RuntimeLeaseError(code, `${inspection.message} Nothing was released. Pass --force once you have confirmed it.`, inspection, normalized);
  }
  const settings = lockInternals.resolve(options);
  const evidence = path.join(runtimeLeaseDirectory(campaignRoot), 'recovered');
  fs.mkdirSync(evidence, { recursive: true });
  atomicWriteJSON(path.join(evidence, `released-${lockInternals.iso(settings.now()).replace(/:/g, '')}.json`), {
    releasedAt: lockInternals.iso(settings.now()),
    endpoint: normalized,
    releasedBy: { pid: process.pid, hostname: settings.hostname },
    forced: options.force === true,
    why,
    previousOwner: (inspection.record ?? null) as unknown as CanonicalValue,
    previousState: inspection.state ?? 'undecodable',
  });
  try { fs.unlinkSync(runtimeLeasePath(campaignRoot, endpoint)); } catch { /* already gone */ }
  return inspection;
}

/** Every endpoint currently leased under this campaign root. For a status view. */
export function leasedEndpoints(campaignRoot: string, options: LockOptions = {}): LockInspection[] {
  const directory = runtimeLeaseDirectory(campaignRoot);
  if (!fs.existsSync(directory)) return [];
  const out: LockInspection[] = [];
  for (const name of fs.readdirSync(directory).sort()) {
    if (!name.endsWith('.lease')) continue;
    const record = lockInternals.readRecord(path.join(directory, name));
    if (!record?.endpoint) continue;
    out.push(inspectRuntimeLease(campaignRoot, record.endpoint, options));
  }
  return out;
}
