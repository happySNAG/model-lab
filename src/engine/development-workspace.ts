// Benchmark engine · putting a fixture repository in front of an attempt, and reading back what it did.
//
// THE WORKSPACE IS THE ONE `engine/isolation.ts` ALREADY BUILDS. Fresh temp directory per attempt,
// fixtures COPIED in as data so the originals are never anywhere the attempt can reach, every path
// resolved through `resolveInside` (absolute paths, `..` traversal and symlinks all refused before
// the check), a scrubbed environment, and the whole directory deleted afterwards whether the attempt
// succeeded or not. Nothing new is claimed here, and in particular this is still not an OS sandbox —
// which is why `development-scoring.ts` refuses to report the executed tier.
//
// READING BACK IS WHERE A DEVELOPMENT BENCHMARK CAN BE ATTACKED BY ACCIDENT. A model asked to make a
// change can, without any intent, produce a workspace that is expensive or impossible to read: a
// build directory with fifty thousand files, a log that grew to a gigabyte, a symlink pointing at
// the machine's root. So the reader is bounded in three independent ways, and a bound that trips is
// RECORDED AND REPORTED rather than silently absorbed:
//
//   file count   a runaway generator is a fact about the attempt, and the scorer should see it.
//   file size    one enormous file must not become a gigabyte in a snapshot digest.
//   total size   the sum, because many medium files are the same problem as one huge one.
//
// A file the reader refuses is not dropped. It is recorded with an explicit marker, so every
// assertion that reads it fails with a truthful reason instead of quietly holding against absence.

import * as fs from 'node:fs';
import * as path from 'node:path';

import { FixtureRepo, RepoSnapshot } from '../core/development-fixture';
import { IsolatedWorkspace, IsolationError } from './isolation';

/** Enough for any repository this benchmark ships, and far below anything that hurts. */
export const MAX_WORKSPACE_FILES = 2_000;
export const MAX_WORKSPACE_FILE_BYTES = 1_048_576;
export const MAX_WORKSPACE_TOTAL_BYTES = 16_777_216;

/**
 * What is recorded in place of a file the reader would not read.
 *
 * It is deliberately something no source file would contain, so an assertion can never mistake it
 * for real content, and it states the reason so the failure it causes is legible.
 */
export const REFUSED_CONTENT_PREFIX = '<<cernum-unreadable: ';

export function refusedContentMarker(reason: string): string {
  return `${REFUSED_CONTENT_PREFIX}${reason}>>`;
}

export function isRefusedContent(contents: string): boolean {
  return contents.startsWith(REFUSED_CONTENT_PREFIX);
}

/** Copy a sealed fixture into a disposable workspace. The fixture itself is never opened again. */
export function materializeFixture(workspace: IsolatedWorkspace, repo: FixtureRepo): void {
  for (const file of repo.files) workspace.placeFixture(file.path, file.contents);
}

export interface WorkspaceReading {
  snapshot: RepoSnapshot;
  /** Every bound that tripped and every path that could not be read, in the reader's own words. */
  warnings: string[];
  fileCount: number;
  totalBytes: number;
  /** True when a bound tripped. A grade computed over a truncated reading must say so. */
  bounded: boolean;
}

/**
 * Read the workspace back as a snapshot.
 *
 * Paths are reported relative to the workspace root with forward slashes on every platform, because
 * an assertion written against `src/util/money.js` must match on Windows too — a benchmark whose
 * verdicts depend on the path separator is not a benchmark of the model.
 */
export function readWorkspaceSnapshot(workspace: IsolatedWorkspace): WorkspaceReading {
  const snapshot = new Map<string, string>();
  const warnings: string[] = [];
  let totalBytes = 0;

  let relativePaths: string[];
  try {
    relativePaths = workspace.list();
  } catch (error) {
    return {
      snapshot, warnings: [`the workspace could not be listed: ${(error as Error).message}`],
      fileCount: 0, totalBytes: 0, bounded: true,
    };
  }

  const ordered = [...relativePaths].sort();
  let bounded = false;
  if (ordered.length > MAX_WORKSPACE_FILES) {
    warnings.push(`the workspace holds ${ordered.length} files, over the ${MAX_WORKSPACE_FILES}-file bound; `
      + `only the first ${MAX_WORKSPACE_FILES} by path were read, and this grade rests on a partial reading`);
    bounded = true;
  }

  for (const relative of ordered.slice(0, MAX_WORKSPACE_FILES)) {
    const normalized = relative.split(path.sep).join('/');
    let resolved: string;
    try {
      resolved = workspace.resolve(normalized);
    } catch (error) {
      // A path that will not resolve inside the workspace is refused by the fence, which is the
      // fence doing its job. It is recorded rather than dropped.
      const reason = error instanceof IsolationError ? error.message : (error as Error).message;
      snapshot.set(normalized, refusedContentMarker(reason));
      warnings.push(`${normalized}: ${reason}`);
      bounded = true;
      continue;
    }

    let size: number;
    try {
      size = fs.statSync(resolved).size;
    } catch (error) {
      snapshot.set(normalized, refusedContentMarker(`could not be inspected: ${(error as Error).message}`));
      warnings.push(`${normalized}: could not be inspected`);
      bounded = true;
      continue;
    }

    if (size > MAX_WORKSPACE_FILE_BYTES) {
      const reason = `${size} bytes, over the ${MAX_WORKSPACE_FILE_BYTES}-byte per-file bound`;
      snapshot.set(normalized, refusedContentMarker(reason));
      warnings.push(`${normalized}: ${reason}`);
      bounded = true;
      continue;
    }
    if (totalBytes + size > MAX_WORKSPACE_TOTAL_BYTES) {
      const reason = `reading it would pass the ${MAX_WORKSPACE_TOTAL_BYTES}-byte total bound`;
      snapshot.set(normalized, refusedContentMarker(reason));
      warnings.push(`${normalized}: ${reason}`);
      bounded = true;
      continue;
    }

    try {
      snapshot.set(normalized, fs.readFileSync(resolved, 'utf8'));
      totalBytes += size;
    } catch (error) {
      snapshot.set(normalized, refusedContentMarker(`could not be read as text: ${(error as Error).message}`));
      warnings.push(`${normalized}: could not be read as text`);
      bounded = true;
    }
  }

  return { snapshot, warnings, fileCount: snapshot.size, totalBytes, bounded };
}
