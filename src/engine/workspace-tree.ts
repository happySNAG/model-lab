// Benchmark engine · what the tree looked like before, what it looks like after, and the exact
// difference between the two.
//
// A WORKSPACE RESULT IS A CLAIM ABOUT A DIFF, so the diff has to be evidence rather than narration.
// Three properties are required of it, and each is a deliberate choice here:
//
//   IT IS COMPUTED, NOT ASKED FOR.  The patch is derived from two snapshots this engine took of the
//                                   directory itself. It is never the patch the model said it made:
//                                   a model that reports a tidy diff and leaves a stray file behind
//                                   has left a stray file behind, and the evidence must show it.
//   IT NEEDS NO GIT.                Snapshots are content-addressed by SHA-256 over file bytes, and
//                                   the unified diff is rendered here. A fixture does not have to be
//                                   a repository, `git` does not have to be installed, and no
//                                   subprocess sits between the filesystem and the record.
//   IT IS BYTE-STABLE.              Paths are sorted by code point, hunk headers carry no timestamps,
//                                   and line endings are recorded rather than normalized. The same
//                                   two trees always render the same patch bytes, which is what
//                                   makes `patchDigest` an identity rather than a checksum of one
//                                   particular afternoon.
//
// BINARY CONTENT IS NEVER INLINED. A changed binary file is recorded as a digest change with its
// byte counts. Rendering it would put megabytes of base64 into an evidence file that a person is
// expected to read, and would make the patch digest depend on an encoder's choices.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { CanonicalValue, digestObject, sha256Bytes } from './canonical';
import { resolveInside } from './isolation';
import { normalizeRelativePath } from './workspace-scope';

export class WorkspaceTreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceTreeError';
  }
}

/** One file, as the engine found it. `executable` is carried because a mode change is a real change. */
export interface TreeEntry extends Record<string, CanonicalValue | undefined> {
  path: string;
  sha256: string;
  byteCount: number;
  executable: boolean;
  /** A symlink is recorded as one and never followed. Its `sha256` digests the target string. */
  symlink: boolean;
}

export interface TreeSnapshot {
  /** Sorted by path, code point ascending. */
  entries: TreeEntry[];
  fileCount: number;
  totalByteCount: number;
  /** SHA-256 over the canonical encoding of `entries`. Two identical trees have one digest. */
  treeDigest: string;
  capturedAt: string;
}

/** Directories never walked into, whatever a case declares. */
const ALWAYS_SKIPPED_DIRECTORIES = new Set(['.git', 'node_modules', '.venv', '__pycache__', '.mypy_cache', '.pytest_cache']);

export interface SnapshotOptions {
  /** Directory names skipped anywhere in the tree, on top of the always-skipped set. */
  skipDirectories?: string[];
  /**
   * The ceiling on how much of a tree will be read, in bytes.
   *
   * A snapshot that silently stopped part way would report a clean diff for a change it never
   * looked at, so exceeding it THROWS. A case whose fixture is genuinely this large raises the
   * ceiling explicitly, which is a decision somebody made rather than a limit that quietly held.
   */
  maximumTotalBytes?: number;
  capturedAt?: string;
}

export const DEFAULT_MAXIMUM_TREE_BYTES = 64 * 1024 * 1024;

/**
 * Walk a directory and record every file in it.
 *
 * Symlinks are recorded, never followed — a snapshot that followed one would attribute whatever it
 * pointed at to the workspace, and a model that plants a symlink at the fixture would then appear
 * to have changed nothing.
 */
export function snapshotTree(root: string, options: SnapshotOptions = {}): TreeSnapshot {
  const realRoot = fs.realpathSync(root);
  const skip = new Set([...ALWAYS_SKIPPED_DIRECTORIES, ...(options.skipDirectories ?? [])]);
  const ceiling = options.maximumTotalBytes ?? DEFAULT_MAXIMUM_TREE_BYTES;
  const entries: TreeEntry[] = [];
  let totalByteCount = 0;

  const walk = (directory: string): void => {
    const found = fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of found) {
      const full = path.join(directory, entry.name);
      const relative = path.relative(realRoot, full).split(path.sep).join('/');
      if (entry.isSymbolicLink()) {
        const target = fs.readlinkSync(full);
        const bytes = Buffer.from(target, 'utf8');
        totalByteCount += bytes.byteLength;
        entries.push({ path: relative, sha256: sha256Bytes(bytes), byteCount: bytes.byteLength, executable: false, symlink: true });
        continue;
      }
      if (entry.isDirectory()) {
        if (skip.has(entry.name)) continue;
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const stats = fs.statSync(full);
      totalByteCount += stats.size;
      if (totalByteCount > ceiling) {
        throw new WorkspaceTreeError(`this tree exceeds the ${ceiling}-byte snapshot ceiling at ${relative}; refusing to `
          + 'record a partial snapshot, because a partial snapshot reports a clean diff for everything it did not read');
      }
      const bytes = fs.readFileSync(full);
      entries.push({
        path: relative,
        sha256: sha256Bytes(bytes),
        byteCount: bytes.byteLength,
        executable: (stats.mode & 0o111) !== 0,
        symlink: false,
      });
    }
  };
  walk(realRoot);

  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    entries,
    fileCount: entries.length,
    totalByteCount,
    treeDigest: digestObject(entries as unknown as CanonicalValue),
    capturedAt: options.capturedAt ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
}

/**
 * Copy an immutable source tree into a destination, as data.
 *
 * THE SOURCE IS OPENED READ-ONLY AND NOTHING IS EVER WRITTEN BACK TO IT. Every destination path
 * goes through `resolveInside`, so a symlink already present in the fixture cannot be used to write
 * outside the workspace — the link is recreated as a link, never followed to copy through.
 */
export function copyTree(source: string, destination: string, options: { skipDirectories?: string[] } = {}): number {
  const realSource = fs.realpathSync(source);
  fs.mkdirSync(destination, { recursive: true });
  const skip = new Set([...ALWAYS_SKIPPED_DIRECTORIES, ...(options.skipDirectories ?? [])]);
  let copied = 0;

  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      const relative = path.relative(realSource, full).split(path.sep).join('/');
      if (entry.isSymbolicLink()) {
        const target = resolveInside(destination, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.symlinkSync(fs.readlinkSync(full), target);
        copied += 1;
        continue;
      }
      if (entry.isDirectory()) {
        if (skip.has(entry.name)) continue;
        fs.mkdirSync(resolveInside(destination, relative), { recursive: true });
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const target = resolveInside(destination, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(full, target);
      fs.chmodSync(target, fs.statSync(full).mode & 0o777);
      copied += 1;
    }
  };
  walk(realSource);
  return copied;
}

// MARK: - The difference between two snapshots

export type ChangeKind = 'added' | 'removed' | 'modified' | 'modeChanged';

export interface FileChange extends Record<string, CanonicalValue | undefined> {
  path: string;
  kind: ChangeKind;
  beforeSHA256?: string;
  afterSHA256?: string;
  beforeByteCount?: number;
  afterByteCount?: number;
  /** Absent when either side is binary or absent; lines are counted, never guessed. */
  addedLineCount?: number;
  removedLineCount?: number;
  binary: boolean;
}

export interface TreeDiff {
  changes: FileChange[];
  changedPaths: string[];
  addedFileCount: number;
  removedFileCount: number;
  modifiedFileCount: number;
  /** Total lines added and removed across every text change. The honest "how big is this patch". */
  addedLineCount: number;
  removedLineCount: number;
  clean: boolean;
  beforeTreeDigest: string;
  afterTreeDigest: string;
}

/** A file is text when its first 8 KiB contain no NUL byte. The rule `git` uses, and for the same reason. */
export function looksBinary(bytes: Buffer): boolean {
  const window = bytes.subarray(0, 8192);
  return window.includes(0);
}

function readIfPresent(root: string, relative: string): Buffer | undefined {
  try {
    return fs.readFileSync(path.join(root, relative.split('/').join(path.sep)));
  } catch {
    return undefined;
  }
}

/**
 * Compare two snapshots, reading file bytes from the two roots to count lines.
 *
 * `beforeRoot` may be undefined when the baseline tree is gone by the time the diff is taken — a
 * preserved workspace read back later. The diff is still complete; only the per-file line counts
 * for modified text files go missing, and they go missing rather than being estimated.
 */
export function diffSnapshots(before: TreeSnapshot, after: TreeSnapshot,
                              roots: { beforeRoot?: string; afterRoot?: string } = {}): TreeDiff {
  const beforeByPath = new Map(before.entries.map((entry) => [entry.path, entry]));
  const afterByPath = new Map(after.entries.map((entry) => [entry.path, entry]));
  const allPaths = [...new Set([...beforeByPath.keys(), ...afterByPath.keys()])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const changes: FileChange[] = [];
  for (const relative of allPaths) {
    const from = beforeByPath.get(relative);
    const to = afterByPath.get(relative);
    if (from && to && from.sha256 === to.sha256) {
      if (from.executable !== to.executable) {
        changes.push({
          path: relative, kind: 'modeChanged', beforeSHA256: from.sha256, afterSHA256: to.sha256,
          beforeByteCount: from.byteCount, afterByteCount: to.byteCount, binary: false,
        });
      }
      continue;
    }
    const beforeBytes = from && roots.beforeRoot ? readIfPresent(roots.beforeRoot, relative) : undefined;
    const afterBytes = to && roots.afterRoot ? readIfPresent(roots.afterRoot, relative) : undefined;
    const binary = (beforeBytes !== undefined && looksBinary(beforeBytes)) || (afterBytes !== undefined && looksBinary(afterBytes));
    const kind: ChangeKind = from === undefined ? 'added' : to === undefined ? 'removed' : 'modified';

    const change: FileChange = {
      path: relative,
      kind,
      beforeSHA256: from?.sha256,
      afterSHA256: to?.sha256,
      beforeByteCount: from?.byteCount,
      afterByteCount: to?.byteCount,
      binary,
    };
    if (!binary) {
      const beforeLines = beforeBytes === undefined ? undefined : splitLines(beforeBytes.toString('utf8'));
      const afterLines = afterBytes === undefined ? undefined : splitLines(afterBytes.toString('utf8'));
      if (kind === 'added' && afterLines) { change.addedLineCount = afterLines.length; change.removedLineCount = 0; }
      else if (kind === 'removed' && beforeLines) { change.addedLineCount = 0; change.removedLineCount = beforeLines.length; }
      else if (beforeLines && afterLines) {
        const hunks = diffLines(beforeLines, afterLines);
        change.addedLineCount = hunks.reduce((sum, hunk) => sum + hunk.lines.filter((line) => line.startsWith('+')).length, 0);
        change.removedLineCount = hunks.reduce((sum, hunk) => sum + hunk.lines.filter((line) => line.startsWith('-')).length, 0);
      }
    }
    changes.push(change);
  }

  return {
    changes,
    changedPaths: changes.map((change) => change.path),
    addedFileCount: changes.filter((change) => change.kind === 'added').length,
    removedFileCount: changes.filter((change) => change.kind === 'removed').length,
    modifiedFileCount: changes.filter((change) => change.kind === 'modified' || change.kind === 'modeChanged').length,
    addedLineCount: changes.reduce((sum, change) => sum + (change.addedLineCount ?? 0), 0),
    removedLineCount: changes.reduce((sum, change) => sum + (change.removedLineCount ?? 0), 0),
    clean: changes.length === 0,
    beforeTreeDigest: before.treeDigest,
    afterTreeDigest: after.treeDigest,
  };
}

// MARK: - The patch itself

/** Split on LF, keeping a trailing empty line distinguishable from no trailing newline. */
function splitLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

interface Hunk { beforeStart: number; beforeCount: number; afterStart: number; afterCount: number; lines: string[] }

/**
 * A longest-common-subsequence diff over lines, with three lines of context.
 *
 * The LCS table is O(n·m) in memory, so it is bounded: past the ceiling the file is reported as a
 * whole-file replacement rather than line by line. That is a worse patch and an honest one — an
 * approximate diff dressed up as an exact one is the failure mode this avoids.
 */
export const MAXIMUM_DIFF_LINES = 4_000;

export function diffLines(before: string[], after: string[], contextLines = 3): Hunk[] {
  if (before.length > MAXIMUM_DIFF_LINES || after.length > MAXIMUM_DIFF_LINES) {
    return [{
      beforeStart: 1, beforeCount: before.length, afterStart: 1, afterCount: after.length,
      lines: [...before.map((line) => `-${line}`), ...after.map((line) => `+${line}`)],
    }];
  }

  // table[i][j] = length of the LCS of before[i..] and after[j..]
  const table: number[][] = Array.from({ length: before.length + 1 }, () => new Array<number>(after.length + 1).fill(0));
  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = after.length - 1; j >= 0; j--) {
      table[i][j] = before[i] === after[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  type Op = { sign: ' ' | '-' | '+'; text: string };
  const operations: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) { operations.push({ sign: ' ', text: before[i] }); i++; j++; }
    else if (table[i + 1][j] >= table[i][j + 1]) { operations.push({ sign: '-', text: before[i] }); i++; }
    else { operations.push({ sign: '+', text: after[j] }); j++; }
  }
  while (i < before.length) { operations.push({ sign: '-', text: before[i] }); i++; }
  while (j < after.length) { operations.push({ sign: '+', text: after[j] }); j++; }

  // Group the operations into hunks: every run of changes, padded with context on both sides.
  const changedAt = operations.map((operation) => operation.sign !== ' ');
  const hunks: Hunk[] = [];
  let cursor = 0;
  let beforeLine = 1;
  let afterLine = 1;
  const lineNumbers: { before: number; after: number }[] = [];
  for (const operation of operations) {
    lineNumbers.push({ before: beforeLine, after: afterLine });
    if (operation.sign !== '+') beforeLine++;
    if (operation.sign !== '-') afterLine++;
  }

  while (cursor < operations.length) {
    if (!changedAt[cursor]) { cursor++; continue; }
    const start = Math.max(0, cursor - contextLines);
    let end = cursor;
    while (end < operations.length) {
      // Extend while another change is within 2·context of this one, so adjacent edits share a hunk.
      const next = changedAt.indexOf(true, end + 1);
      if (next >= 0 && next - end <= contextLines * 2) { end = next; continue; }
      break;
    }
    const stop = Math.min(operations.length, end + contextLines + 1);
    const slice = operations.slice(start, stop);
    const first = lineNumbers[start];
    const beforeCount = slice.filter((operation) => operation.sign !== '+').length;
    const afterCount = slice.filter((operation) => operation.sign !== '-').length;
    hunks.push({
      beforeStart: beforeCount === 0 ? Math.max(0, first.before - 1) : first.before,
      beforeCount,
      afterStart: afterCount === 0 ? Math.max(0, first.after - 1) : first.after,
      afterCount,
      lines: slice.map((operation) => `${operation.sign}${operation.text}`),
    });
    cursor = stop;
  }
  return hunks;
}

export interface PatchArtifact {
  /** Unified diff text. Empty when nothing changed. */
  text: string;
  /** SHA-256 over `text`. The identity of this attempt's work. */
  patchDigest: string;
  byteCount: number;
  /** True when a file was too large or too binary to render, so the patch is not the whole story. */
  truncated: boolean;
  omittedPaths: string[];
}

/**
 * Render the diff as a unified patch.
 *
 * `a/` and `b/` prefixes and no timestamps, so the output applies with `patch -p1` and hashes the
 * same on every machine. A binary change gets a one-line marker naming both digests rather than
 * its content.
 */
export function renderPatch(diff: TreeDiff, roots: { beforeRoot?: string; afterRoot?: string }): PatchArtifact {
  const parts: string[] = [];
  const omittedPaths: string[] = [];

  for (const change of diff.changes) {
    if (change.kind === 'modeChanged') {
      parts.push(`diff --cernum a/${change.path} b/${change.path}`);
      parts.push(`mode changed, content unchanged (${change.beforeSHA256})`);
      continue;
    }
    if (change.binary) {
      parts.push(`diff --cernum a/${change.path} b/${change.path}`);
      parts.push(`Binary files differ: ${change.beforeSHA256 ?? 'absent'} -> ${change.afterSHA256 ?? 'absent'}`);
      omittedPaths.push(change.path);
      continue;
    }
    const beforeBytes = roots.beforeRoot && change.kind !== 'added' ? readIfPresent(roots.beforeRoot, change.path) : undefined;
    const afterBytes = roots.afterRoot && change.kind !== 'removed' ? readIfPresent(roots.afterRoot, change.path) : undefined;
    if ((change.kind !== 'added' && beforeBytes === undefined) || (change.kind !== 'removed' && afterBytes === undefined)) {
      parts.push(`diff --cernum a/${change.path} b/${change.path}`);
      parts.push(`content unavailable: ${change.beforeSHA256 ?? 'absent'} -> ${change.afterSHA256 ?? 'absent'}`);
      omittedPaths.push(change.path);
      continue;
    }
    const beforeLines = beforeBytes === undefined ? [] : splitLines(beforeBytes.toString('utf8'));
    const afterLines = afterBytes === undefined ? [] : splitLines(afterBytes.toString('utf8'));
    parts.push(`diff --cernum a/${change.path} b/${change.path}`);
    parts.push(`--- ${change.kind === 'added' ? '/dev/null' : `a/${change.path}`}`);
    parts.push(`+++ ${change.kind === 'removed' ? '/dev/null' : `b/${change.path}`}`);
    for (const hunk of diffLines(beforeLines, afterLines)) {
      parts.push(`@@ -${hunk.beforeStart},${hunk.beforeCount} +${hunk.afterStart},${hunk.afterCount} @@`);
      parts.push(...hunk.lines);
    }
  }

  const text = parts.length === 0 ? '' : parts.join('\n') + '\n';
  return {
    text,
    patchDigest: digestObject(text),
    byteCount: Buffer.byteLength(text, 'utf8'),
    truncated: omittedPaths.length > 0,
    omittedPaths,
  };
}

/**
 * Leftovers a finished patch must not contain.
 *
 * These are not style opinions. Each one is a specific way a change can look complete and not be:
 * a conflict marker is an unfinished merge, a `.orig`/`.rej` file is a failed patch application,
 * and an editor swap file is a session someone walked away from. A case may add to this list; it is
 * the floor, not the whole rule.
 */
export const PATCH_CLEANLINESS_MARKERS = ['<<<<<<<', '>>>>>>>', '=======\n<<<'] as const;
export const PATCH_CLEANLINESS_ARTEFACT_SUFFIXES = ['.orig', '.rej', '.swp', '.swo', '.bak'] as const;

export interface CleanlinessFinding extends Record<string, CanonicalValue | undefined> {
  path: string;
  kind: 'conflictMarker' | 'strayArtefact';
  detail: string;
}

/** Check the FINAL TREE, not the patch text: a stray file with no diff hunk is still a stray file. */
export function assessPatchCleanliness(afterRoot: string, diff: TreeDiff): CleanlinessFinding[] {
  const findings: CleanlinessFinding[] = [];
  for (const change of diff.changes) {
    if (change.kind === 'removed') continue;
    const suffix = PATCH_CLEANLINESS_ARTEFACT_SUFFIXES.find((candidate) => change.path.endsWith(candidate));
    if (suffix !== undefined) {
      findings.push({
        path: change.path, kind: 'strayArtefact',
        detail: `${change.path} is a ${suffix} file: the residue of a failed patch or an abandoned editor session, left in the tree`,
      });
      continue;
    }
    if (change.binary) continue;
    const bytes = readIfPresent(afterRoot, change.path);
    if (bytes === undefined) continue;
    const text = bytes.toString('utf8');
    if (text.includes('<<<<<<<') && text.includes('>>>>>>>')) {
      findings.push({
        path: change.path, kind: 'conflictMarker',
        detail: `${change.path} still contains merge conflict markers, so this change was never finished`,
      });
    }
  }
  return findings;
}

/** The normalized change set a scope assessment is run against. */
export function changedPathsOf(diff: TreeDiff): string[] {
  return diff.changes.map((change) => normalizeRelativePath(change.path));
}
