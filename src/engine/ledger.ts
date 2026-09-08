// Benchmark engine · the durable attempt ledger. Power-loss safe, resume safe,
// single-terminal-result-per-slot. A faithful port of the proven `ledger_v2.py`.
//
// WHAT THIS IS FOR. A long local campaign runs for hours or days. It will be interrupted: by a lid
// close, a kernel panic, a full disk, or someone pressing Ctrl-C. The question is never "will it
// stop" but "what is true afterwards".
//
// THE INVARIANT: exactly one terminal result per slot, ever.
//
//   * The PLAN is written once, atomically, BEFORE any inference. It never changes.
//   * A terminal result is appended to `results.jsonl` and fsynced BEFORE the runner moves on.
//   * A slot that already has a terminal result is never attempted again, on any resume.
//   * `checkpoint.json` is rewritten atomically after every attempt. It is a fast index and a
//     progress view, NEVER the source of truth — `results.jsonl` is.
//
// WHY BOTH FILES. A checkpoint alone loses the last attempt if the crash lands between the write
// and the rename. An append-only log alone is slow to summarise and easy to mis-scan. Using the
// log as truth and the checkpoint as a cache means a disagreement between them is DETECTABLE:
// `load()` rebuilds from the log and REPORTS the drift rather than silently correcting it.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { CanonicalValue, canonicalJSON, sha256Text } from './canonical';

export const LEDGER_FORMAT_VERSION = 2;

/**
 * The statuses a slot may end in — the proven harness's set, unchanged and unextended.
 * `fixtures/parity/engine/ledger-plan-vectors.json` pins it, so adding a status here without
 * adding it there fails the parity test rather than silently widening what counts as terminal.
 * Anything not in this set is refused: the ledger never records an outcome it cannot name.
 */
export const TERMINAL_STATUSES = [
  'behavioralFailure', 'compilationFailure', 'envelopeFailure', 'fail', 'partial', 'pass',
  'patchFailure', 'requiresHumanReview', 'runtimeError', 'safetyAbort', 'scopeFailure',
  'timeout', 'unsupported',
] as const;
export type TerminalSlotStatus = (typeof TERMINAL_STATUSES)[number];

export function isTerminalStatus(value: unknown): value is TerminalSlotStatus {
  return typeof value === 'string' && (TERMINAL_STATUSES as readonly string[]).includes(value);
}

export class LedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerError';
  }
}

export interface PlanSlot {
  slotIndex: number;
  slotKey: string;
  candidate: string;
  modelID: string;
  suite: string;
  block: string;
  pass: number;
  caseID: string;
  caseDigest: string;
  comparabilityKey: string;
  scoringMode: string;
  maxOutputTokens: number;
  inputBudgetTokens: number;
  status: 'planned';
}

export interface SlotResult {
  slotKey: string;
  status: TerminalSlotStatus;
  seq: number;
  recordedAt: string;
  [key: string]: CanonicalValue | undefined;
}

export interface LedgerAnomaly {
  kind: 'repairedTornWrite' | 'unknownSlot' | 'duplicateTerminalResult' | 'unreadableCheckpoint' | 'checkpointDrift';
  detail?: CanonicalValue;
  slotKey?: string;
  kept?: string;
  discarded?: string;
  checkpointSaid?: number | null;
  logSays?: number;
  why?: string;
  error?: string;
}

export interface Checkpoint {
  updatedAt: string;
  slotCount: number;
  terminalCount: number;
  remaining: number;
  byStatus: Record<string, number>;
  lastSlotKey: string | null;
  candidatesComplete: string[];
  [key: string]: CanonicalValue | undefined;
}

export interface AbortRecord {
  abortedAt: string;
  reason: string;
  stage: string;
  measurements: CanonicalValue;
  blockedSlotCount: number;
  blockedSlotKeys: string[];
  terminalAtAbort: number;
  note: string;
  supersededAt?: string;
  supersededBecause?: string;
}

export interface Reconciliation {
  slotCount: number;
  terminal: number;
  blocked: number;
  unaccounted: number;
  duplicateTerminalResults: number;
  overlapBlockedAndTerminal: number;
  byStatus: Record<string, number>;
  balances: boolean;
  complete: boolean;
  anomalies: LedgerAnomaly[];
}

/** The catalogue shape the planner needs. Deliberately structural: the engine plans from data, not from a class. */
export interface PlannableCase {
  caseID: string;
  caseDigest: string;
  comparabilityKey: string;
  scoringMode: string;
  maxOutputTokens: number;
  inputBudgetTokens: number;
  executionOrdinal: number;
}
export interface PlannableSuite { slug: string; block: string; executionOrdinal: number; cases: PlannableCase[] }
export interface PlannableCatalog { catalogDigest: string; caseCount: number; repeatsPerCase: number; suites: PlannableSuite[] }
export interface PlannableCandidate { name: string; modelID: string }

/** `candidate|suite|pass|caseID` — the slot's identity, and the message the blinding token is derived from. */
export function slotKey(candidate: string, suite: string, passNumber: number, caseID: string): string {
  return `${candidate}|${suite}|${passNumber}|${caseID}`;
}

/**
 * Every planned attempt, in execution order, declared before the first request.
 *
 * Order is candidate-major: one model is loaded, run to completion across all suites and passes,
 * then unloaded and verified at zero residency before the next is touched. That is the order the
 * residency guard requires, and it is why a partial campaign always has a contiguous prefix of
 * finished candidates.
 */
export function buildPlan(catalog: PlannableCatalog, candidates: PlannableCandidate[]): PlanSlot[] {
  const slots: PlanSlot[] = [];
  const suites = [...catalog.suites].sort((a, b) => a.executionOrdinal - b.executionOrdinal);
  for (const candidate of candidates) {
    for (const suite of suites) {
      for (let pass = 1; pass <= catalog.repeatsPerCase; pass++) {
        for (const benchmarkCase of [...suite.cases].sort((a, b) => a.executionOrdinal - b.executionOrdinal)) {
          slots.push({
            slotIndex: slots.length,
            slotKey: slotKey(candidate.name, suite.slug, pass, benchmarkCase.caseID),
            candidate: candidate.name,
            modelID: candidate.modelID,
            suite: suite.slug,
            block: suite.block,
            pass,
            caseID: benchmarkCase.caseID,
            caseDigest: benchmarkCase.caseDigest,
            comparabilityKey: benchmarkCase.comparabilityKey,
            scoringMode: benchmarkCase.scoringMode,
            maxOutputTokens: benchmarkCase.maxOutputTokens,
            inputBudgetTokens: benchmarkCase.inputBudgetTokens,
            status: 'planned',
          });
        }
      }
    }
  }
  return slots;
}

/** fsync the directory so a rename is durable, not merely visible. Best effort: not every platform allows it. */
function fsyncDirectory(directory: string): void {
  let handle: number | undefined;
  try {
    handle = fs.openSync(directory, 'r');
    fs.fsyncSync(handle);
  } catch {
    // Windows refuses to open a directory for fsync. The rename is still atomic there.
  } finally {
    if (handle !== undefined) try { fs.closeSync(handle); } catch { /* already gone */ }
  }
}

/** Write, fsync, rename, fsync the directory. A reader never observes a half-written file. */
export function atomicWriteJSON(filePath: string, value: CanonicalValue): void {
  const temporary = `${filePath}.tmp`;
  const handle = fs.openSync(temporary, 'w');
  try {
    fs.writeFileSync(handle, JSON.stringify(value, null, 2) + '\n', 'utf8');
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  fs.renameSync(temporary, filePath);
  fsyncDirectory(path.dirname(filePath));
}

function nowISO(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export class Ledger {
  readonly planPath: string;
  readonly metaPath: string;
  readonly resultsPath: string;
  readonly checkpointPath: string;
  readonly abortPath: string;
  readonly eventsPath: string;
  readonly abortsDirectory: string;

  plan: PlanSlot[] = [];
  results = new Map<string, SlotResult>();
  anomalies: LedgerAnomaly[] = [];
  private bySlotKey = new Map<string, PlanSlot>();

  constructor(readonly root: string, private readonly clock: () => string = nowISO) {
    this.planPath = path.join(root, 'plan.json');
    this.metaPath = path.join(root, 'meta.json');
    this.resultsPath = path.join(root, 'results.jsonl');
    this.checkpointPath = path.join(root, 'checkpoint.json');
    this.abortPath = path.join(root, 'abort.json');
    this.eventsPath = path.join(root, 'events.jsonl');
    this.abortsDirectory = path.join(root, 'aborts');
  }

  // ---------------------------------------------------------------------- creation

  static create(root: string, catalog: PlannableCatalog, candidates: PlannableCandidate[],
                meta: Record<string, CanonicalValue> = {}, clock: () => string = nowISO): Ledger {
    fs.mkdirSync(root, { recursive: true });
    const ledger = new Ledger(root, clock);
    fs.mkdirSync(ledger.abortsDirectory, { recursive: true });
    if (fs.existsSync(ledger.planPath)) {
      throw new LedgerError(`a plan already exists at ${ledger.planPath}; open it instead of recreating it — rewriting a plan mid-campaign would change the denominator`);
    }
    const plan = buildPlan(catalog, candidates);
    atomicWriteJSON(ledger.planPath, {
      ledgerFormatVersion: LEDGER_FORMAT_VERSION,
      catalogDigest: catalog.catalogDigest,
      caseCount: catalog.caseCount,
      repeatsPerCase: catalog.repeatsPerCase,
      candidateCount: candidates.length,
      slotCount: plan.length,
      planDigest: sha256Text(canonicalJSON(plan.map((slot) => slot.slotKey))),
      slots: plan as unknown as CanonicalValue,
    });
    atomicWriteJSON(ledger.metaPath, { ...meta, createdAt: clock(), ledgerFormatVersion: LEDGER_FORMAT_VERSION });
    // Touch the append-only files so a crash before the first attempt still finds a well-formed,
    // empty ledger rather than a missing one.
    for (const file of [ledger.resultsPath, ledger.eventsPath]) if (!fs.existsSync(file)) fs.closeSync(fs.openSync(file, 'a'));
    fsyncDirectory(root);
    return ledger.load();
  }

  static open(root: string, clock: () => string = nowISO): Ledger {
    return new Ledger(root, clock).load();
  }

  static exists(root: string): boolean {
    return fs.existsSync(path.join(root, 'plan.json'));
  }

  // ---------------------------------------------------------------------- loading

  load(): this {
    if (!fs.existsSync(this.planPath)) throw new LedgerError(`no plan.json at ${this.root}`);
    const planFile = JSON.parse(fs.readFileSync(this.planPath, 'utf8')) as { slots: PlanSlot[] };
    this.plan = planFile.slots;
    this.bySlotKey = new Map(this.plan.map((slot) => [slot.slotKey, slot]));
    this.results = new Map();
    this.anomalies = [];
    const repaired = this.readResults();
    if (repaired) this.anomalies.push({ kind: 'repairedTornWrite', detail: repaired });
    this.verifyCheckpoint();
    return this;
  }

  /** Parse results.jsonl; truncate a torn final line; first record per slot wins. */
  private readResults(): CanonicalValue | undefined {
    if (!fs.existsSync(this.resultsPath)) return undefined;
    const raw = fs.readFileSync(this.resultsPath);
    const lines = raw.toString('utf8').split('\n');
    let goodBytes = 0;
    let repaired: CanonicalValue | undefined;
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      const byteLength = Buffer.byteLength(line, 'utf8') + 1;
      if (line.trim().length === 0) { goodBytes += byteLength; continue; }
      let record: SlotResult;
      try {
        record = JSON.parse(line) as SlotResult;
      } catch {
        const restIsBlank = lines.slice(index + 1).every((rest) => rest.trim().length === 0);
        if (index === lines.length - 1 || restIsBlank) {
          repaired = {
            truncatedBytes: raw.length - goodBytes,
            at: goodBytes,
            why: 'the final record was not fully written before the interruption; it was never fsynced, so the attempt never became terminal and will be re-run',
          };
          break;
        }
        throw new LedgerError(`results.jsonl line ${index + 1} is corrupt and is not the last line; refusing to guess`);
      }
      const key = record.slotKey;
      if (!this.bySlotKey.has(key)) {
        this.anomalies.push({ kind: 'unknownSlot', slotKey: key });
        goodBytes += byteLength;
        continue;
      }
      const existing = this.results.get(key);
      if (existing) this.anomalies.push({ kind: 'duplicateTerminalResult', slotKey: key, kept: existing.status, discarded: record.status });
      else this.results.set(key, record);
      goodBytes += byteLength;
    }
    if (repaired !== undefined) {
      const handle = fs.openSync(this.resultsPath, 'r+');
      try {
        fs.ftruncateSync(handle, goodBytes);
        fs.fsyncSync(handle);
      } finally {
        fs.closeSync(handle);
      }
      fsyncDirectory(this.root);
    }
    return repaired;
  }

  /**
   * The checkpoint is a cache. If it disagrees with the log, the log wins and the disagreement is
   * RECORDED rather than silently corrected — a silent correction hides the one fact worth knowing.
   */
  private verifyCheckpoint(): void {
    if (!fs.existsSync(this.checkpointPath)) return;
    let checkpoint: Checkpoint;
    try {
      checkpoint = JSON.parse(fs.readFileSync(this.checkpointPath, 'utf8')) as Checkpoint;
    } catch (error) {
      this.anomalies.push({ kind: 'unreadableCheckpoint', error: error instanceof Error ? error.message : String(error) });
      return;
    }
    if (checkpoint.terminalCount !== this.results.size) {
      this.anomalies.push({
        kind: 'checkpointDrift',
        checkpointSaid: checkpoint.terminalCount ?? null,
        logSays: this.results.size,
        why: 'the interruption landed between the result append and the checkpoint rewrite; the log is authoritative',
      });
    }
  }

  // ---------------------------------------------------------------------- writing

  /** Append one terminal result, fsynced before the caller is allowed to move on. */
  appendResult(record: { slotKey: string; status: string } & Record<string, CanonicalValue | undefined>): SlotResult {
    if (!isTerminalStatus(record.status)) {
      throw new LedgerError(`${JSON.stringify(record.status)} is not a terminal status; the ledger refuses to record an outcome it cannot name`);
    }
    const key = record.slotKey;
    if (!this.bySlotKey.has(key)) throw new LedgerError(`slot ${JSON.stringify(key)} is not in the plan`);
    const existing = this.results.get(key);
    if (existing) {
      throw new LedgerError(`slot ${JSON.stringify(key)} already has a terminal result (${existing.status}); a terminal attempt is never re-run`);
    }
    const stored: SlotResult = { recordedAt: this.clock(), ...record, status: record.status as TerminalSlotStatus, seq: this.results.size };
    const handle = fs.openSync(this.resultsPath, 'a');
    try {
      fs.writeFileSync(handle, canonicalJSON(stored as unknown as CanonicalValue) + '\n', 'utf8');
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
    this.results.set(key, stored);
    return stored;
  }

  /** Append one line to the operational trace. Guards, unloads, pauses and resumes all land here. */
  event(kind: string, fields: Record<string, CanonicalValue | undefined> = {}): void {
    const record = { ...fields, kind, at: this.clock() };
    const handle = fs.openSync(this.eventsPath, 'a');
    try {
      fs.writeFileSync(handle, canonicalJSON(record as CanonicalValue) + '\n', 'utf8');
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
  }

  events(): Record<string, CanonicalValue>[] {
    if (!fs.existsSync(this.eventsPath)) return [];
    return fs.readFileSync(this.eventsPath, 'utf8').split('\n').filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, CanonicalValue>);
  }

  writeCheckpoint(extra: Record<string, CanonicalValue> = {}): Checkpoint {
    const byStatus: Record<string, number> = {};
    let last: SlotResult | undefined;
    for (const result of this.results.values()) {
      byStatus[result.status] = (byStatus[result.status] ?? 0) + 1;
      if (!last || result.seq > last.seq) last = result;
    }
    const checkpoint: Checkpoint = {
      updatedAt: this.clock(),
      slotCount: this.plan.length,
      terminalCount: this.results.size,
      remaining: this.plan.length - this.results.size,
      byStatus,
      lastSlotKey: last ? last.slotKey : null,
      candidatesComplete: [...this.completedCandidates()].sort(),
      ...extra,
    };
    atomicWriteJSON(this.checkpointPath, checkpoint as unknown as CanonicalValue);
    return checkpoint;
  }

  readCheckpoint(): Checkpoint | undefined {
    if (!fs.existsSync(this.checkpointPath)) return undefined;
    try { return JSON.parse(fs.readFileSync(this.checkpointPath, 'utf8')) as Checkpoint; } catch { return undefined; }
  }

  // ---------------------------------------------------------------------- abort

  recordAbort(reason: string, measurements: CanonicalValue, stage: string, blockedKeys: string[]): AbortRecord {
    const record: AbortRecord = {
      abortedAt: this.clock(),
      reason,
      stage,
      measurements,
      blockedSlotCount: blockedKeys.length,
      blockedSlotKeys: [...blockedKeys].sort(),
      terminalAtAbort: this.results.size,
      note: 'blocked slots were never attempted and carry no result. They become runnable again only after the breach is resolved and the campaign is resumed; terminal slots never do.',
    };
    atomicWriteJSON(this.abortPath, record as unknown as CanonicalValue);
    this.event('abort', { reason, stage, blocked: blockedKeys.length });
    return record;
  }

  standingAbort(): AbortRecord | undefined {
    if (!fs.existsSync(this.abortPath)) return undefined;
    try { return JSON.parse(fs.readFileSync(this.abortPath, 'utf8')) as AbortRecord; } catch { return undefined; }
  }

  /** Supersede a standing abort on resume. The record is KEPT, never deleted. */
  clearAbort(why: string): AbortRecord | undefined {
    const current = this.standingAbort();
    if (!current) return undefined;
    fs.mkdirSync(this.abortsDirectory, { recursive: true });
    const count = fs.readdirSync(this.abortsDirectory).length;
    const superseded: AbortRecord = { ...current, supersededAt: this.clock(), supersededBecause: why };
    atomicWriteJSON(path.join(this.abortsDirectory, `abort-${String(count).padStart(3, '0')}.json`), superseded as unknown as CanonicalValue);
    fs.unlinkSync(this.abortPath);
    fsyncDirectory(this.root);
    this.event('abortSuperseded', { why });
    return superseded;
  }

  pastAborts(): AbortRecord[] {
    if (!fs.existsSync(this.abortsDirectory)) return [];
    return fs.readdirSync(this.abortsDirectory).filter((name) => name.endsWith('.json')).sort()
      .map((name) => JSON.parse(fs.readFileSync(path.join(this.abortsDirectory, name), 'utf8')) as AbortRecord);
  }

  // ---------------------------------------------------------------------- queries

  /** Plan order, minus everything already terminal. This is the resume cursor. */
  pending(): PlanSlot[] {
    return this.plan.filter((slot) => !this.results.has(slot.slotKey));
  }

  isTerminal(key: string): boolean {
    return this.results.has(key);
  }

  slot(key: string): PlanSlot | undefined {
    return this.bySlotKey.get(key);
  }

  completedCandidates(): Set<string> {
    const done = new Set<string>();
    for (const candidate of new Set(this.plan.map((slot) => slot.candidate))) {
      const keys = this.plan.filter((slot) => slot.candidate === candidate).map((slot) => slot.slotKey);
      if (keys.length > 0 && keys.every((key) => this.results.has(key))) done.add(candidate);
    }
    return done;
  }

  meta(): Record<string, CanonicalValue> {
    if (!fs.existsSync(this.metaPath)) return {};
    return JSON.parse(fs.readFileSync(this.metaPath, 'utf8')) as Record<string, CanonicalValue>;
  }

  planDigest(): string {
    return sha256Text(canonicalJSON(this.plan.map((slot) => slot.slotKey)));
  }

  /** The one arithmetic that has to hold: every slot accounted for, exactly once. */
  reconcile(): Reconciliation {
    const abort = this.standingAbort();
    const blocked = new Set(abort?.blockedSlotKeys ?? []);
    const terminal = new Set(this.results.keys());
    const planned = new Set(this.plan.map((slot) => slot.slotKey));
    const unaccounted = [...planned].filter((key) => !terminal.has(key) && !blocked.has(key));
    const overlap = [...terminal].filter((key) => blocked.has(key));
    const byStatus: Record<string, number> = {};
    for (const result of this.results.values()) byStatus[result.status] = (byStatus[result.status] ?? 0) + 1;
    return {
      slotCount: planned.size,
      terminal: terminal.size,
      blocked: blocked.size,
      unaccounted: unaccounted.length,
      duplicateTerminalResults: this.anomalies.filter((a) => a.kind === 'duplicateTerminalResult').length,
      overlapBlockedAndTerminal: overlap.length,
      byStatus,
      balances: terminal.size + blocked.size + unaccounted.length === planned.size && overlap.length === 0,
      complete: terminal.size === planned.size,
      anomalies: [...this.anomalies],
    };
  }
}
