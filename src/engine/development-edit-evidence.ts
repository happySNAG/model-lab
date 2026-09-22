// Benchmark engine · keeping the bytes a multi-file-edit attempt left behind, and proving they are them.
//
// WHY THIS EXISTS. A multi-file-edit row is graded from the workspace the attempt left, and that
// workspace is deleted the moment it has been read. Before this module the row kept only a digest of
// what was graded, so a verdict like "the default rounding mode was not preserved" could be neither
// audited nor re-graded: the bytes the regex judged were gone. Now every graded edit attempt writes
// one EDIT EVIDENCE document beside the campaign, and the row commits to that document's hash.
//
// WHAT IS KEPT. For every path the attempt added, modified or removed: the final text (for added and
// modified paths), a unified diff against the sealed baseline, and a sha256 of each side. Paths the
// attempt left unchanged are NOT copied — the baseline already holds them — and are only counted.
// The baseline itself is written once per fixture to `baselines/`, as the sealed fixture object, so
// the evidence reproduces the graded repository with no reference to this build's registry.
//
// WHAT IS PROVEN, ON WRITE AND AGAIN ON EVERY RE-READ.
//
//   baseline    the stored fixture seals to the row's `fixtureRepoDigest`, and its snapshot digests
//               to the row's `baselineSnapshotDigest`.
//   diffs       every diff, applied strictly to the baseline, yields exactly the retained text.
//   snapshot    the baseline with the retained changes applied digests to the graded
//               `resultSnapshotDigest` (FNV, as the row records it) AND to a sha256 over the same
//               canonical form, which is the tamper-evident one.
//
// A document that fails any of these on write is not silently kept as though it were good: it is
// written as INCOMPLETE with the failure named, and a re-read refuses to grade from it.
//
// LIMITS FAIL CLOSED. Beyond `MAX_EDIT_EVIDENCE_CHANGED_FILES` changed paths or
// `MAX_EDIT_EVIDENCE_RETAINED_BYTES` of retained text plus diffs, NO contents are kept — never a
// truncated prefix of them. The document keeps the manifest (paths, change kinds, sha256 of each side)
// and says `state: "incomplete"` with the bound that tripped. A partial copy that looked whole would
// be the one thing worse than no copy.
//
// REDACTION IS DECLARED, NEVER HIDDEN. Retained text passes through the same secret redactor every
// other artefact does. When that changes a file, the document keeps the redacted text, records which
// shapes were removed, keeps the sha256 of the ORIGINAL bytes, and says `state: "redacted"`. It then
// proves the retained bytes against a second digest taken over the redacted snapshot — which detects
// tampering — and never against the graded digest, which redacted bytes cannot and must not match. A
// re-read will not grade redacted bytes as though they were what the model wrote.

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  FixtureRepo, RepoSnapshot, diffSnapshots, fixtureRepoDigest, snapshotDigest, snapshotOf, snapshotPaths,
} from '../core/development-fixture';
import { canonicalJSON } from '../core/digest';
import { UnifiedDiffError, applyUnifiedDiff, unifiedDiff } from '../core/unified-diff';
import { CanonicalValue } from './canonical';
import { atomicWriteJSON } from './ledger';
import { redactSecrets } from './redaction';
import { isRefusedContent } from './development-workspace';

export const DEVELOPMENT_EDIT_EVIDENCE_DIRECTORY = 'development-edits';
export const DEVELOPMENT_EDIT_BASELINES_DIRECTORY = 'baselines';
export const DEVELOPMENT_EDIT_EVIDENCE_FORMAT = 'cernum-development-edit-evidence-1';
export const DEVELOPMENT_EDIT_BASELINE_FORMAT = 'cernum-development-edit-baseline-1';

/** Changed paths one attempt may retain. Every task this benchmark ships changes fewer than ten. */
export const MAX_EDIT_EVIDENCE_CHANGED_FILES = 256;
/** UTF-8 bytes of retained text plus diffs one attempt may retain: 4 MiB. */
export const MAX_EDIT_EVIDENCE_RETAINED_BYTES = 4_194_304;

export interface EditEvidenceLimits {
  maxChangedFiles: number;
  maxRetainedBytes: number;
}

export const DEFAULT_EDIT_EVIDENCE_LIMITS: EditEvidenceLimits = {
  maxChangedFiles: MAX_EDIT_EVIDENCE_CHANGED_FILES,
  maxRetainedBytes: MAX_EDIT_EVIDENCE_RETAINED_BYTES,
};

/**
 * What a document is good for.
 *
 *   byteExact    the retained bytes are the graded bytes, proven. A re-read may grade from them.
 *   redacted     the retained bytes are the graded bytes with declared secret spans replaced. They
 *                are proven intact, and they are NOT the graded bytes, so nothing is graded from them.
 *   incomplete   no contents were kept (a bound tripped, or the write-time proof failed). The manifest
 *                is there; nothing is graded from it.
 */
export type EditEvidenceState = 'byteExact' | 'redacted' | 'incomplete';

export type EditChangeKind = 'added' | 'modified' | 'removed';

export interface EditEvidenceChange {
  path: string;
  change: EditChangeKind;
  /** sha256 of the baseline text. Absent on an added path. */
  baselineSha256?: string;
  /** sha256 of the text the attempt left, as graded. Absent on a removed path. */
  resultSha256?: string;
  /** sha256 of `contents` as kept here. Differs from `resultSha256` only on a redacted file. */
  retainedSha256?: string;
  /** The final text, as kept. Absent on a removed path and on an incomplete document. */
  contents?: string;
  /** Unified diff from the baseline to `contents`. Absent on an incomplete document. */
  diff?: string;
  /** Present only when redaction changed this file. */
  redaction?: { kinds: string[]; originalCharacters: number; retainedCharacters: number };
  /** True when the reader recorded its refusal marker here instead of the file (a bounded reading). */
  unreadByWorkspaceReader?: boolean;
}

export interface DevelopmentEditEvidence {
  format: typeof DEVELOPMENT_EDIT_EVIDENCE_FORMAT;
  slotKey: string;
  runID: string;
  taskID: string;
  state: EditEvidenceState;
  /** Why the document is not byteExact. Empty when it is. */
  notByteExactBecause: string[];
  baseline: {
    fixtureRepoID: string;
    fixtureRepoVersion: string;
    fixtureRepoDigest: string;
    /** Relative to the edit evidence directory. */
    file: string;
    snapshotDigest: string;
    snapshotSha256: string;
    fileCount: number;
  };
  result: {
    /** The graded digest, exactly as the row records it. */
    snapshotDigest: string;
    snapshotSha256: string;
    fileCount: number;
    /** True when the workspace reader tripped a bound: what was graded is itself a bounded reading. */
    gradedFromBoundedReading: boolean;
  };
  /** The snapshot the retained bytes reproduce. Equal to `result` on a byteExact document. */
  retained?: { snapshotDigest: string; snapshotSha256: string };
  limits: EditEvidenceLimits;
  changedFileCount: number;
  unchangedFileCount: number;
  retainedBytes: number;
  changes: EditEvidenceChange[];
  selfVerification: { baselineReproduced: boolean; diffsApply: boolean; snapshotReproduced: boolean; detail: string };
}

/** What the row records about its evidence: enough to find it and to know it was not swapped. */
export interface EditEvidenceReference {
  file: string;
  sha256: string;
  state: EditEvidenceState | 'notRetained';
  notByteExactBecause: string[];
  changedFileCount: number;
  retainedBytes: number;
  resultSnapshotSha256: string;
}

export class EditEvidenceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'EditEvidenceError';
  }
}

export function sha256(text: string | Buffer): string {
  return 'sha256:' + createHash('sha256').update(text).digest('hex');
}

/** sha256 over exactly the canonical form `snapshotDigest` seals, so the two name the same bytes. */
export function snapshotSha256(snapshot: RepoSnapshot): string {
  return sha256(canonicalJSON(snapshotPaths(snapshot).map((entry) => ({ path: entry, contents: snapshot.get(entry) }))));
}

export function editEvidenceFileName(slotKey: string): string {
  return `${slotKey.replace(/[^A-Za-z0-9._-]/g, '_')}.json`;
}

export function baselineFileName(repo: { id: string; version: string }): string {
  return `${`${repo.id}@${repo.version}`.replace(/[^A-Za-z0-9._@-]/g, '_')}.json`;
}

/** Which secret shapes redaction replaced, read off the markers it left. */
function redactedKinds(text: string): string[] {
  return [...new Set([...text.matchAll(/\[redacted:([A-Za-z]+):\d+chars\]/g)].map((match) => match[1]))].sort();
}

/** The retained repository: the baseline with every retained change applied. */
export function reconstructSnapshot(baseline: RepoSnapshot, changes: EditEvidenceChange[]): Map<string, string> {
  const out = new Map(baseline);
  for (const change of changes) {
    if (change.change === 'removed') {
      if (!out.has(change.path)) throw new EditEvidenceError('evidenceInconsistent', `${change.path} is recorded removed but is not in the baseline`);
      out.delete(change.path);
      continue;
    }
    if (typeof change.contents !== 'string') {
      throw new EditEvidenceError('retainedFileMissing', `${change.path} is recorded ${change.change} but its contents were not retained`);
    }
    if (change.change === 'added' && out.has(change.path)) {
      throw new EditEvidenceError('evidenceInconsistent', `${change.path} is recorded added but is in the baseline`);
    }
    if (change.change === 'modified' && !out.has(change.path)) {
      throw new EditEvidenceError('evidenceInconsistent', `${change.path} is recorded modified but is not in the baseline`);
    }
    out.set(change.path, change.contents);
  }
  return out;
}

/** Every diff, applied strictly to the baseline, must give exactly the retained text. */
function diffsApply(baseline: RepoSnapshot, changes: EditEvidenceChange[]): string | undefined {
  for (const change of changes) {
    if (typeof change.diff !== 'string') return `${change.path} has no diff`;
    try {
      const applied = applyUnifiedDiff(baseline.get(change.path), change.diff);
      const expected = change.change === 'removed' ? undefined : change.contents;
      if (applied !== expected) return `${change.path}: its diff applied to the baseline does not give the retained text`;
    } catch (error) {
      if (error instanceof UnifiedDiffError) return `${change.path}: its diff does not apply to the baseline (${error.message})`;
      throw error;
    }
  }
  return undefined;
}

/**
 * Build the evidence for one graded edit attempt. Pure: nothing is written.
 *
 * `graded` is the digest the grader recorded. The builder proves its own output reproduces it and
 * records the proof; it never throws for a proof that fails — it says so, as `incomplete`.
 */
export function buildEditEvidence(options: {
  slotKey: string;
  runID: string;
  taskID: string;
  repo: FixtureRepo;
  result: RepoSnapshot;
  gradedResultSnapshotDigest: string;
  gradedBaselineSnapshotDigest: string;
  gradedFromBoundedReading: boolean;
  limits?: EditEvidenceLimits;
}): DevelopmentEditEvidence {
  const limits = options.limits ?? DEFAULT_EDIT_EVIDENCE_LIMITS;
  const baseline = snapshotOf(options.repo);
  const difference = diffSnapshots(baseline, options.result);
  const notByteExactBecause: string[] = [];

  const changes: EditEvidenceChange[] = [];
  const kinds: [string[], EditChangeKind][] = [[difference.added, 'added'], [difference.modified, 'modified'], [difference.removed, 'removed']];
  for (const [paths, change] of kinds) {
    for (const entry of paths) {
      const before = baseline.get(entry);
      const after = options.result.get(entry);
      const record: EditEvidenceChange = { path: entry, change };
      if (before !== undefined) record.baselineSha256 = sha256(before);
      if (after !== undefined) {
        record.resultSha256 = sha256(after);
        const retained = redactSecrets(after);
        record.contents = retained;
        record.retainedSha256 = sha256(retained);
        if (retained !== after) {
          record.redaction = { kinds: redactedKinds(retained), originalCharacters: after.length, retainedCharacters: retained.length };
        }
        if (isRefusedContent(after)) record.unreadByWorkspaceReader = true;
      }
      record.diff = unifiedDiff(entry, before, record.contents);
      changes.push(record);
    }
  }
  changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const retainedBytes = changes.reduce((sum, change) =>
    sum + Buffer.byteLength(change.contents ?? '', 'utf8') + Buffer.byteLength(change.diff ?? '', 'utf8'), 0);

  const resultSha = snapshotSha256(options.result);
  const baselineSha = snapshotSha256(baseline);
  const redacted = changes.filter((change) => change.redaction !== undefined);
  if (redacted.length > 0) {
    notByteExactBecause.push(`secret redaction replaced ${redacted.map((change) => `${change.path} (${change.redaction!.kinds.join(', ')})`).join('; ')}; `
      + 'the retained text is not the text that was graded');
  }

  // PROOF ON WRITE.
  const baselineReproduced = snapshotDigest(baseline) === options.gradedBaselineSnapshotDigest;
  const diffFailure = diffsApply(baseline, changes);
  let reconstructed: Map<string, string> | undefined;
  let reconstructionFailure: string | undefined;
  try {
    reconstructed = reconstructSnapshot(baseline, changes);
  } catch (error) {
    reconstructionFailure = (error as Error).message;
  }
  const retainedDigest = reconstructed ? snapshotDigest(reconstructed) : undefined;
  const retainedSha = reconstructed ? snapshotSha256(reconstructed) : undefined;
  const originalReproduced = snapshotDigest(options.result) === options.gradedResultSnapshotDigest;
  const snapshotReproduced = redacted.length === 0
    ? retainedDigest === options.gradedResultSnapshotDigest && retainedSha === resultSha
    : originalReproduced && redacted.every((change) => redactSecrets(options.result.get(change.path)!) === change.contents);

  const proofFailures: string[] = [];
  if (!baselineReproduced) proofFailures.push(`the baseline digests to ${snapshotDigest(baseline)}, not the graded ${options.gradedBaselineSnapshotDigest}`);
  if (diffFailure) proofFailures.push(diffFailure);
  if (reconstructionFailure) proofFailures.push(reconstructionFailure);
  if (!snapshotReproduced) proofFailures.push(`the retained changes do not reproduce the graded snapshot ${options.gradedResultSnapshotDigest}`);

  const overFiles = changes.length > limits.maxChangedFiles;
  const overBytes = retainedBytes > limits.maxRetainedBytes;
  const bounds: string[] = [];
  if (overFiles) bounds.push(`${changes.length} changed paths, over the ${limits.maxChangedFiles}-path edit evidence bound`);
  if (overBytes) bounds.push(`${retainedBytes} bytes of retained text and diffs, over the ${limits.maxRetainedBytes}-byte edit evidence bound`);

  const incomplete = bounds.length > 0 || proofFailures.length > 0;
  if (incomplete) {
    // FAIL CLOSED: the manifest is kept, every byte of content is dropped, and the reason is named.
    for (const change of changes) { delete change.contents; delete change.diff; delete change.retainedSha256; }
    notByteExactBecause.push(...bounds.map((bound) => `${bound}; no contents were retained, rather than a truncated part of them`));
    notByteExactBecause.push(...proofFailures.map((failure) => `the write-time proof failed: ${failure}`));
  }

  const state: EditEvidenceState = incomplete ? 'incomplete' : redacted.length > 0 ? 'redacted' : 'byteExact';
  return {
    format: DEVELOPMENT_EDIT_EVIDENCE_FORMAT,
    slotKey: options.slotKey,
    runID: options.runID,
    taskID: options.taskID,
    state,
    notByteExactBecause,
    baseline: {
      fixtureRepoID: options.repo.id,
      fixtureRepoVersion: options.repo.version,
      fixtureRepoDigest: fixtureRepoDigest(options.repo),
      file: `${DEVELOPMENT_EDIT_BASELINES_DIRECTORY}/${baselineFileName(options.repo)}`,
      snapshotDigest: snapshotDigest(baseline),
      snapshotSha256: baselineSha,
      fileCount: baseline.size,
    },
    result: {
      snapshotDigest: options.gradedResultSnapshotDigest,
      snapshotSha256: resultSha,
      fileCount: options.result.size,
      gradedFromBoundedReading: options.gradedFromBoundedReading,
    },
    retained: incomplete || retainedDigest === undefined || retainedSha === undefined
      ? undefined : { snapshotDigest: retainedDigest, snapshotSha256: retainedSha },
    limits,
    changedFileCount: changes.length,
    unchangedFileCount: difference.unchanged.length,
    retainedBytes: incomplete ? 0 : retainedBytes,
    changes,
    selfVerification: {
      baselineReproduced,
      diffsApply: diffFailure === undefined,
      snapshotReproduced,
      detail: proofFailures.length === 0
        ? (redacted.length === 0
          ? 'baseline + retained changes reproduce the graded snapshot digest and sha256; every diff applies exactly'
          : 'the original bytes reproduce the graded snapshot, and redacting them gives exactly the retained text; '
            + 'every diff applies exactly to give the retained (redacted) text')
        : proofFailures.join('; '),
    },
  };
}

interface StoredBaseline {
  format: typeof DEVELOPMENT_EDIT_BASELINE_FORMAT;
  fixtureRepoDigest: string;
  snapshotDigest: string;
  repo: FixtureRepo;
}

/** Write the fixture once per campaign; a second write must be byte-for-byte the same fixture. */
function ensureBaseline(directory: string, repo: FixtureRepo): void {
  const file = path.join(directory, DEVELOPMENT_EDIT_BASELINES_DIRECTORY, baselineFileName(repo));
  const value: StoredBaseline = {
    format: DEVELOPMENT_EDIT_BASELINE_FORMAT,
    fixtureRepoDigest: fixtureRepoDigest(repo),
    snapshotDigest: snapshotDigest(snapshotOf(repo)),
    repo,
  };
  if (fs.existsSync(file)) {
    const stored = readStoredBaseline(file);
    if (stored.fixtureRepoDigest !== value.fixtureRepoDigest) {
      throw new EditEvidenceError('baselineConflict',
        `${file} already holds ${stored.fixtureRepoDigest}, and this attempt ran against ${value.fixtureRepoDigest}`);
    }
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWriteJSON(file, value as unknown as CanonicalValue);
}

function readStoredBaseline(file: string): StoredBaseline {
  const value = JSON.parse(fs.readFileSync(file, 'utf8')) as StoredBaseline;
  if (value.format !== DEVELOPMENT_EDIT_BASELINE_FORMAT) {
    throw new EditEvidenceError('baselineUnreadable', `${file} is not a ${DEVELOPMENT_EDIT_BASELINE_FORMAT} document`);
  }
  return value;
}

/** Write one attempt's evidence (and its baseline, once) under `root`. Returns what the row records. */
export function writeEditEvidence(root: string, evidence: DevelopmentEditEvidence, repo: FixtureRepo): EditEvidenceReference {
  const directory = path.join(root, DEVELOPMENT_EDIT_EVIDENCE_DIRECTORY);
  fs.mkdirSync(directory, { recursive: true });
  ensureBaseline(directory, repo);
  const name = editEvidenceFileName(evidence.slotKey);
  const file = path.join(directory, name);
  atomicWriteJSON(file, evidence as unknown as CanonicalValue);
  return {
    file: `${DEVELOPMENT_EDIT_EVIDENCE_DIRECTORY}/${name}`,
    sha256: sha256(fs.readFileSync(file)),
    state: evidence.state,
    notByteExactBecause: evidence.notByteExactBecause,
    changedFileCount: evidence.changedFileCount,
    retainedBytes: evidence.retainedBytes,
    resultSnapshotSha256: evidence.result.snapshotSha256,
  };
}

// MARK: - Reading back

/** What a re-read establishes about one row's evidence. */
export type VerifiedEditEvidence =
  /** The retained bytes ARE the graded bytes. `snapshot` may be graded. */
  | { usable: true; evidence: DevelopmentEditEvidence; repo: FixtureRepo; snapshot: Map<string, string>; files: Record<string, string> }
  /** Intact and honest, but not gradeable: redacted or incomplete, as the document itself declares. */
  | { usable: false; evidence: DevelopmentEditEvidence; because: string; files: Record<string, string> };

/**
 * Read one row's evidence back and prove it, or throw.
 *
 * THROWS on anything that means the evidence is not what the row committed to: a missing document,
 * a document whose hash is not the row's, a missing or altered baseline, a diff that does not apply,
 * a retained file that is missing or altered. Returns `usable: false` only for a document that is
 * intact and says of itself that it cannot be graded from.
 */
export function readVerifiedEditEvidence(root: string, row: {
  slotKey: string; runID: string; fixtureRepoDigest: string; baselineSnapshotDigest: string;
  resultSnapshotDigest: string; reference: EditEvidenceReference;
}): VerifiedEditEvidence {
  const { reference } = row;
  const file = path.join(root, reference.file);
  if (!fs.existsSync(file)) {
    throw new EditEvidenceError('editEvidenceMissing', `${row.slotKey}: its edit evidence ${reference.file} is not on disk`);
  }
  const bytes = fs.readFileSync(file);
  const files: Record<string, string> = { [reference.file]: sha256(bytes) };
  if (files[reference.file] !== reference.sha256) {
    throw new EditEvidenceError('editEvidenceTampered',
      `${row.slotKey}: ${reference.file} hashes to ${files[reference.file]}, and the row recorded ${reference.sha256}`);
  }
  const evidence = JSON.parse(bytes.toString('utf8')) as DevelopmentEditEvidence;
  if (evidence.format !== DEVELOPMENT_EDIT_EVIDENCE_FORMAT || evidence.slotKey !== row.slotKey || evidence.runID !== row.runID) {
    throw new EditEvidenceError('editEvidenceMismatch', `${reference.file} does not describe ${row.slotKey} (run ${row.runID})`);
  }
  if (evidence.state !== reference.state || evidence.result.snapshotDigest !== row.resultSnapshotDigest
      || evidence.result.snapshotSha256 !== reference.resultSnapshotSha256) {
    throw new EditEvidenceError('editEvidenceMismatch',
      `${reference.file} records state ${evidence.state} and snapshot ${evidence.result.snapshotDigest}, and the row `
      + `recorded ${reference.state} and ${row.resultSnapshotDigest}`);
  }

  // The baseline: the stored fixture must be the one the row names, by both of its digests.
  const baselineRelative = `${DEVELOPMENT_EDIT_EVIDENCE_DIRECTORY}/${evidence.baseline.file}`;
  const baselineFile = path.join(root, baselineRelative);
  if (!fs.existsSync(baselineFile)) {
    throw new EditEvidenceError('baselineMissing', `${row.slotKey}: its baseline ${baselineRelative} is not on disk`);
  }
  files[baselineRelative] = sha256(fs.readFileSync(baselineFile));
  const stored = readStoredBaseline(baselineFile);
  const repo = stored.repo;
  const baseline = snapshotOf(repo);
  if (fixtureRepoDigest(repo) !== row.fixtureRepoDigest || snapshotDigest(baseline) !== row.baselineSnapshotDigest) {
    throw new EditEvidenceError('baselineTampered',
      `${baselineRelative} seals to ${fixtureRepoDigest(repo)} / ${snapshotDigest(baseline)}, and ${row.slotKey} was graded `
      + `against ${row.fixtureRepoDigest} / ${row.baselineSnapshotDigest}`);
  }

  if (evidence.state === 'incomplete') {
    return { usable: false, evidence, files,
      because: `its edit evidence is declared incomplete: ${evidence.notByteExactBecause.join('; ')}` };
  }

  // Every retained file is what the document says it retained, and every diff agrees with it.
  for (const change of evidence.changes) {
    if (change.change !== 'removed') {
      if (typeof change.contents !== 'string') {
        throw new EditEvidenceError('retainedFileMissing', `${row.slotKey}: ${change.path} is recorded ${change.change} and its text is missing`);
      }
      if (sha256(change.contents) !== change.retainedSha256) {
        throw new EditEvidenceError('retainedFileTampered', `${row.slotKey}: ${change.path} does not hash to the ${change.retainedSha256} it was retained with`);
      }
    }
  }
  const diffFailure = diffsApply(baseline, evidence.changes);
  if (diffFailure) throw new EditEvidenceError('diffDoesNotApply', `${row.slotKey}: ${diffFailure}`);

  // The whole repository, rebuilt, and checked against every digest that names it — the manifest of
  // changed paths included, so a file dropped from `changes` cannot pass as "unchanged".
  const snapshot = reconstructSnapshot(baseline, evidence.changes);
  const recount = diffSnapshots(baseline, snapshot);
  const changedPaths = [...recount.added, ...recount.modified, ...recount.removed].length;
  if (changedPaths !== evidence.changedFileCount || recount.unchanged.length !== evidence.unchangedFileCount) {
    throw new EditEvidenceError('notReproduced',
      `${row.slotKey}: the retained changes rebuild ${changedPaths} changed / ${recount.unchanged.length} unchanged paths, and the `
      + `evidence recorded ${evidence.changedFileCount} / ${evidence.unchangedFileCount}`);
  }
  if (evidence.state === 'redacted') {
    if (evidence.retained === undefined || snapshotSha256(snapshot) !== evidence.retained.snapshotSha256
        || snapshotDigest(snapshot) !== evidence.retained.snapshotDigest) {
      throw new EditEvidenceError('notReproduced', `${row.slotKey}: the retained (redacted) bytes do not reproduce the retained snapshot digest`);
    }
    return { usable: false, evidence, files,
      because: `its edit evidence is intact but redacted, so it is not the text that was graded: ${evidence.notByteExactBecause.join('; ')}` };
  }
  if (snapshotDigest(snapshot) !== row.resultSnapshotDigest || snapshotSha256(snapshot) !== reference.resultSnapshotSha256) {
    throw new EditEvidenceError('notReproduced',
      `${row.slotKey}: the stored baseline and retained files rebuild ${snapshotDigest(snapshot)}, not the graded `
      + `${row.resultSnapshotDigest}. The retained bytes are not provably the graded bytes.`);
  }
  return { usable: true, evidence, repo, snapshot, files };
}
