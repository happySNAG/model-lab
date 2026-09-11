// Benchmark engine · the cross-process campaign lock.
//
// WHAT THIS IS FOR. A campaign directory is the shared object between the desktop application and
// the terminal command. That sharing is the point — a run started in one is observable in the
// other — but it means two runners can be pointed at the same ledger, and the ledger's own defence
// (one terminal result per slot, ever) is a last line rather than a first one. It refuses the
// duplicate AFTER both processes have paid for the inference, and it cannot stop two runners from
// interleaving guard verdicts, residency unloads and checkpoint rewrites. So ownership is taken
// before the first request, in the filesystem, where both processes can see it.
//
// THE INVARIANT: at most one live owner per campaign, across processes and across surfaces.
//
// ATOMICITY. Acquisition is `open(…, 'wx')` — create-exclusively — which is a single atomic
// syscall on POSIX and on Windows. There is no read-then-write window for two starters to race in.
// Recovery of a crashed owner's lock is gated the same way: the stale file is `rename`d to a
// unique path first, and only the process whose rename succeeded may create the new lock. The
// loser gets ENOENT and is refused, which is the correct outcome.
//
// A LIVE LOCK IS NEVER BROKEN AUTOMATICALLY. Liveness is decided from three facts: the hostname,
// whether the recorded PID still exists, and how old the owner's heartbeat is. Only one combination
// — this host, PID gone — is recovered without a person. A PID that still exists but has stopped
// beating could be a hung runner or an unrelated process that inherited the number; neither is
// something a benchmark should resolve by guessing, so both are refused with the exact command that
// resolves them.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { CanonicalValue } from './canonical';
import { atomicWriteJSON } from './ledger';

export const LOCK_FORMAT_VERSION = 1;

/** How long an owner may go without writing a heartbeat before it stops counting as responsive. */
export const DEFAULT_STALE_AFTER_MILLISECONDS = 90_000;
/** How often a live owner refreshes its heartbeat. Comfortably inside the staleness window. */
export const DEFAULT_HEARTBEAT_INTERVAL_MILLISECONDS = 15_000;

/** Which surface holds the campaign. Recorded so a refusal can say where to look for the owner. */
export type LockProcessType = 'desktop' | 'terminal';

export interface LockRecord {
  lockFormatVersion: number;
  /** Unique to one acquisition. Release only removes a file that still carries the same nonce. */
  nonce: string;
  pid: number;
  processType: LockProcessType;
  /** The exact invocation, so a person can recognise the owner in their own terminal history. */
  command: string;
  hostname: string;
  campaignID: string;
  campaignName: string;
  acquiredAt: string;
  heartbeatAt: string;
  /** Runtime leases only: the normalized benchmark endpoint this ownership covers. */
  endpoint?: string;
  /** Runtime leases only: the endpoint exactly as the caller spelled it. */
  endpointAsGiven?: string;
  /** Runtime leases only: what the endpoint's model store looked like when the lease was taken. */
  modelStoreListingDigest?: string;
  modelStoreCount?: number;
  [key: string]: CanonicalValue | undefined;
}

/**
 * What the lock file on disk means right now.
 *
 * `stale` is the ONLY state that is recovered without a person: this host, and the recorded process
 * no longer exists.
 */
export type LockOwnerState =
  /** The owner is on this host, its process exists, and its heartbeat is current. */
  | 'live'
  /** The owner is this very process. */
  | 'selfHeld'
  /** This host, and the recorded process is gone. A crash. Recoverable. */
  | 'stale'
  /** This host, the process exists, but the heartbeat has stopped. Hung, or a reused PID. */
  | 'unresponsive'
  /** Another machine wrote it. Liveness is unknowable from here. */
  | 'foreignHost';

export interface LockInspection {
  held: boolean;
  record?: LockRecord;
  state?: LockOwnerState;
  heartbeatAgeMilliseconds?: number;
  /** Plain-language explanation, suitable for printing to a person as-is. */
  message: string;
  /** True when `acquire` would take ownership by recovering this file. */
  recoverable: boolean;
}

export class CampaignLockError extends Error {
  constructor(readonly code: 'heldByLiveOwner' | 'ownerUnresponsive' | 'foreignHost' | 'lostRace',
              message: string, readonly inspection: LockInspection) {
    super(message);
    this.name = 'CampaignLockError';
  }
}

export interface LockOptions {
  now?: () => Date;
  hostname?: string;
  /** Injectable so a test can describe a process that is gone without killing one. */
  processIsAlive?: (pid: number) => boolean;
  staleAfterMilliseconds?: number;
  /** Zero disables the background heartbeat; a test drives `heartbeat()` by hand instead. */
  heartbeatIntervalMilliseconds?: number;
}

export interface LockRequest {
  processType: LockProcessType;
  command: string;
  campaignID: string;
  campaignName: string;
}

export function campaignLockPath(root: string): string {
  return path.join(root, 'campaign.lock');
}

/** Where a recovered lock is kept. A crash that was cleaned up leaves evidence that it happened. */
export function recoveredLocksDirectory(root: string): string {
  return path.join(root, 'locks');
}

function iso(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Signal 0 asks the OS whether a PID exists without touching the process. */
function defaultProcessIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists and belongs to someone else — which is still "it exists".
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Shared with the runtime lease, so both kinds of ownership decide liveness by the same rules. */
export const lockInternals = {
  iso: (date: Date) => iso(date),
  resolve: (options: LockOptions = {}) => resolve(options),
  readRecord: (file: string) => readRecord(file),
  write: (file: string, record: LockRecord) => write(file, record),
  newNonce: () => randomBytes(16).toString('hex'),
};

function readRecord(file: string): LockRecord | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as LockRecord;
    if (typeof parsed?.nonce !== 'string' || typeof parsed?.pid !== 'number') return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

interface Resolved {
  now: () => Date;
  hostname: string;
  processIsAlive: (pid: number) => boolean;
  staleAfterMilliseconds: number;
  heartbeatIntervalMilliseconds: number;
}

function resolve(options: LockOptions = {}): Resolved {
  return {
    now: options.now ?? (() => new Date()),
    hostname: options.hostname ?? os.hostname(),
    processIsAlive: options.processIsAlive ?? defaultProcessIsAlive,
    staleAfterMilliseconds: options.staleAfterMilliseconds ?? DEFAULT_STALE_AFTER_MILLISECONDS,
    heartbeatIntervalMilliseconds: options.heartbeatIntervalMilliseconds ?? DEFAULT_HEARTBEAT_INTERVAL_MILLISECONDS,
  };
}

export function classifyOwner(record: LockRecord, options: LockOptions = {}): { state: LockOwnerState; ageMilliseconds: number } {
  return classify(record, resolve(options));
}

function classify(record: LockRecord, settings: Resolved): { state: LockOwnerState; ageMilliseconds: number } {
  const age = settings.now().getTime() - Date.parse(record.heartbeatAt);
  const ageMilliseconds = Number.isFinite(age) ? age : Number.MAX_SAFE_INTEGER;
  if (record.hostname !== settings.hostname) return { state: 'foreignHost', ageMilliseconds };
  if (record.pid === process.pid) return { state: 'selfHeld', ageMilliseconds };
  if (!settings.processIsAlive(record.pid)) return { state: 'stale', ageMilliseconds };
  if (ageMilliseconds > settings.staleAfterMilliseconds) return { state: 'unresponsive', ageMilliseconds };
  return { state: 'live', ageMilliseconds };
}

function describe(record: LockRecord, state: LockOwnerState, ageMilliseconds: number): string {
  const who = `${record.processType} process ${record.pid} on ${record.hostname}`;
  const seconds = Math.round(ageMilliseconds / 1000);
  switch (state) {
    case 'live':
      return `${record.campaignName} is already running in the ${who} (${record.command}), which last reported ${seconds}s ago. `
        + 'Two runners against one ledger would interleave guard verdicts and residency unloads, so the second is refused. '
        + 'Pause the first one and try again.';
    case 'selfHeld':
      return `${record.campaignName} is already held by this process (${record.command}).`;
    case 'stale':
      return `${record.campaignName} was left locked by the ${who} (${record.command}), which no longer exists — it crashed or was killed. `
        + 'The lock is recoverable and will be reclaimed.';
    case 'unresponsive':
      return `${record.campaignName} is locked by the ${who} (${record.command}), whose process still exists but has not reported for ${seconds}s. `
        + 'That is either a hung runner or an unrelated process that was given the same process number, and this engine will not guess which. '
        + 'Stop that process if it is the runner, then release the lock explicitly.';
    case 'foreignHost':
      return `${record.campaignName} is locked by the ${who} (${record.command}), and whether that machine is still running it cannot be seen from here. `
        + 'A shared campaign directory is only safe with one runner; confirm the other machine has stopped, then release the lock explicitly.';
  }
}

/** Read the lock file and say what it means. Never writes; safe to call from a status view. */
export function inspectCampaignLock(root: string, options: LockOptions = {}): LockInspection {
  const settings = resolve(options);
  const file = campaignLockPath(root);
  if (!fs.existsSync(file)) return { held: false, message: 'no process holds this campaign', recoverable: false };
  const record = readRecord(file);
  if (!record) {
    return {
      held: true,
      message: 'a lock file exists but does not decode; it was written by an interrupted acquisition and can be reclaimed',
      recoverable: true,
    };
  }
  const { state, ageMilliseconds } = classify(record, settings);
  return {
    held: true,
    record,
    state,
    heartbeatAgeMilliseconds: ageMilliseconds,
    message: describe(record, state, ageMilliseconds),
    recoverable: state === 'stale',
  };
}

/** Ownership of one campaign, for as long as this object is not released. */
/**
 * Ownership of one thing, for as long as this object is not released.
 *
 * Named for the campaign lock because that is what it was written for, and reused unchanged by the
 * runtime-endpoint lease: heartbeat, nonce-checked release and the unref'd timer are the same
 * problem in both cases, and two copies of them would eventually disagree about one.
 */
export class CampaignLockHandle {
  private released = false;
  private timer?: NodeJS.Timeout;

  constructor(
    readonly file: string,
    private mutableRecord: LockRecord,
    private readonly settings: Resolved,
    /** The crashed owner this acquisition reclaimed, when it reclaimed one. */
    readonly recovered?: LockRecord,
  ) {
    if (settings.heartbeatIntervalMilliseconds > 0) {
      this.timer = setInterval(() => this.heartbeat(), settings.heartbeatIntervalMilliseconds);
      // A held lock must never be the reason a process refuses to exit.
      this.timer.unref?.();
    }
  }

  get record(): LockRecord {
    return this.mutableRecord;
  }

  /**
   * Refresh the heartbeat, so a long-running attempt is not mistaken for a crash.
   *
   * Written by rename, so a reader always sees a complete record and the path is never momentarily
   * absent — an absent path is exactly what another starter's `open(…, 'wx')` is watching for.
   */
  heartbeat(): void {
    if (this.released) return;
    const current = readRecord(this.file);
    // Someone reclaimed it. Do not fight for it, and do not overwrite whatever they wrote.
    if (!current || current.nonce !== this.mutableRecord.nonce) return;
    this.mutableRecord = { ...this.mutableRecord, heartbeatAt: iso(this.settings.now()) };
    try {
      atomicWriteJSON(this.file, this.mutableRecord as unknown as CanonicalValue);
    } catch {
      // A failed heartbeat is not a reason to stop a campaign; the next one may well succeed, and
      // the worst case is that this owner is later classified as unresponsive rather than live.
    }
  }

  /** Give the campaign up. Removes only a lock file that still carries this acquisition's nonce. */
  release(): boolean {
    if (this.released) return false;
    this.released = true;
    if (this.timer) clearInterval(this.timer);
    const current = readRecord(this.file);
    if (!current || current.nonce !== this.mutableRecord.nonce) return false;
    try {
      fs.unlinkSync(this.file);
      return true;
    } catch {
      return false;
    }
  }

  get isReleased(): boolean {
    return this.released;
  }
}

function write(file: string, record: LockRecord): void {
  // 'wx' is create-exclusive: one atomic syscall that fails if the path already exists. This is the
  // whole mutual exclusion; everything else in this module is about explaining a refusal.
  const handle = fs.openSync(file, 'wx');
  try {
    fs.writeFileSync(handle, JSON.stringify(record, null, 2) + '\n', 'utf8');
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
}

/**
 * Take ownership of one campaign, or explain precisely why it cannot be taken.
 *
 * Throws `CampaignLockError` rather than returning a failure, because every caller of this must
 * stop; a caller that could ignore the answer would be the bug this exists to prevent.
 */
export function acquireCampaignLock(root: string, request: LockRequest, options: LockOptions = {}): CampaignLockHandle {
  const settings = resolve(options);
  const file = campaignLockPath(root);
  fs.mkdirSync(root, { recursive: true });

  const record: LockRecord = {
    lockFormatVersion: LOCK_FORMAT_VERSION,
    nonce: randomBytes(16).toString('hex'),
    pid: process.pid,
    processType: request.processType,
    command: request.command,
    hostname: settings.hostname,
    campaignID: request.campaignID,
    campaignName: request.campaignName,
    acquiredAt: iso(settings.now()),
    heartbeatAt: iso(settings.now()),
  };

  try {
    write(file, record);
    return new CampaignLockHandle(file, record, settings);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }

  const inspection = inspectCampaignLock(root, options);
  if (!inspection.recoverable) {
    const state = inspection.state ?? 'live';
    const code = state === 'foreignHost' ? 'foreignHost' : state === 'unresponsive' ? 'ownerUnresponsive' : 'heldByLiveOwner';
    throw new CampaignLockError(code, inspection.message, inspection);
  }

  // Recovering a crash. Renaming first is the gate: exactly one process can rename a given path
  // away, so exactly one process reaches the exclusive create below.
  const reclaimed = path.join(root, `campaign.lock.reclaiming-${record.nonce}`);
  try {
    fs.renameSync(file, reclaimed);
  } catch {
    // Another process reclaimed it while this one was deciding. It now holds the campaign.
    const after = inspectCampaignLock(root, options);
    throw new CampaignLockError('lostRace',
      `another process reclaimed ${request.campaignName} first. ${after.message}`, after);
  }

  try {
    write(file, record);
  } catch (error) {
    // The new lock could not be created; put the evidence back rather than leaving the campaign
    // unlocked with a crashed owner nobody will ever see.
    try { fs.renameSync(reclaimed, file); } catch { /* the reclaim file remains as the record */ }
    throw error;
  }

  const crashed = inspection.record;
  fs.mkdirSync(recoveredLocksDirectory(root), { recursive: true });
  const stamp = iso(settings.now()).replace(/[:]/g, '');
  atomicWriteJSON(path.join(recoveredLocksDirectory(root), `recovered-${stamp}-${record.nonce.slice(0, 8)}.json`), {
    recoveredAt: iso(settings.now()),
    recoveredBy: { pid: record.pid, processType: record.processType, command: record.command, hostname: record.hostname },
    crashedOwner: (crashed ?? null) as unknown as CanonicalValue,
    why: crashed
      ? `process ${crashed.pid} on ${crashed.hostname} held this campaign and no longer exists; its lock was reclaimed`
      : 'the previous lock file did not decode and was reclaimed',
  });
  try { fs.unlinkSync(reclaimed); } catch { /* already gone */ }

  return new CampaignLockHandle(file, record, settings, crashed);
}

/**
 * Release a lock this process does not own — the explicit human action for a hung or foreign owner.
 *
 * `force` is required for anything that is not already recoverable, and exists so that breaking a
 * lock is always something a person decided rather than something a program concluded.
 */
export function breakCampaignLock(root: string, why: string, options: LockOptions & { force?: boolean } = {}): LockInspection {
  const inspection = inspectCampaignLock(root, options);
  if (!inspection.held) return inspection;
  if (inspection.state === 'live' && options.force !== true) {
    throw new CampaignLockError('heldByLiveOwner',
      `${inspection.message} Nothing was released. If that process is genuinely gone, pass --force.`, inspection);
  }
  if (!inspection.recoverable && inspection.state !== 'live' && options.force !== true) {
    throw new CampaignLockError(inspection.state === 'foreignHost' ? 'foreignHost' : 'ownerUnresponsive',
      `${inspection.message} Nothing was released. Pass --force once you have confirmed it.`, inspection);
  }
  const settings = resolve(options);
  fs.mkdirSync(recoveredLocksDirectory(root), { recursive: true });
  const stamp = iso(settings.now()).replace(/[:]/g, '');
  atomicWriteJSON(path.join(recoveredLocksDirectory(root), `released-${stamp}.json`), {
    releasedAt: iso(settings.now()),
    releasedBy: { pid: process.pid, hostname: settings.hostname },
    forced: options.force === true,
    why,
    previousOwner: (inspection.record ?? null) as unknown as CanonicalValue,
    previousState: inspection.state ?? 'undecodable',
  });
  try { fs.unlinkSync(campaignLockPath(root)); } catch { /* already gone */ }
  return inspection;
}
