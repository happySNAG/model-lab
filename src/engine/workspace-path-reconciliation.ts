// Benchmark engine · reconciling a path the AGENT NAMED with the paths this engine OBSERVED.
//
// THE FINDING THIS EXISTS FOR. In the first live workspace run, `claude` reported editing
// `/private/var/folders/…/cernum-ws-…/work/src/stats.js`, and the engine's own `changedPaths` said
// `src/stats.js`. Both were correct. They were also impossible to line up by eye, and impossible to
// line up in code at all: one is an absolute path on this machine, the other is workspace-relative,
// and a reader comparing testimony against evidence had to do the arithmetic in their head.
//
// THIS IS RECONCILIATION OF TESTIMONY TO OBSERVATION, AND IT IS NOT A PROMOTION. What comes back is
// a SECOND field beside the reported one, never a replacement for it, and the transcript event
// keeps its `agentReported` provenance. A tool saying it wrote a file is still the tool saying so;
// expressing that claim in the engine's own vocabulary makes it CHECKABLE against the diff, which
// is the opposite of treating it as checked. `reported` is always preserved verbatim.
//
// THE THREE RULES THAT KEEP IT SAFE
//
//   1  ONLY A PATH THAT RESOLVES INSIDE THE LIVE WORKSPACE ROOT IS NORMALIZED. Everything else
//      comes back `outsideWorkspace` with the reason, and carries NO relative form — because a
//      relative form is exactly what would make an out-of-scope edit read as an in-scope one in
//      every table that shows this column.
//   2  THE ESCAPES GO THROUGH `resolveInside`, not through string comparison. `..` traversal and a
//      symlink planted inside the workspace that points out of it are refused by the same
//      confinement the drivers use, after the symlink is resolved rather than before.
//   3  THE macOS ALIAS IS HANDLED BY REALPATH, NOT BY STRIPPING `/private`. `/var/folders/…` and
//      `/private/var/folders/…` are one directory spelled two ways, and `sameDirectory` in the
//      Claude driver already has to know that for the working-directory check. Here both sides are
//      realpath'd, so the alias resolves the way the filesystem resolves it and a path that merely
//      *begins* with `/private` gains nothing.
//
// Nothing in this module throws. A reconciliation that failed would be a transcript that lost an
// event, and the event is worth more than the tidiness of its path field.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { CanonicalValue } from './canonical';
import { resolveInside } from './isolation';
import { normalizeRelativePath } from './workspace-scope';

/** What became of one reported path. Every value is a statement about the CLAIM, never about the file. */
export type PathTestimonyResolution =
  /** It was already workspace-relative and names something inside the workspace. */
  | 'alreadyRelative'
  /** It was absolute, resolved inside the workspace, and has been expressed relative to it. */
  | 'normalizedFromAbsolute'
  /** It resolves outside the workspace, or through something that leaves it. Never normalized. */
  | 'outsideWorkspace'
  /** The workspace root itself could not be resolved, so nothing can be said about the path. */
  | 'unresolvable';

export interface ReconciledPath extends Record<string, CanonicalValue | undefined> {
  /** EXACTLY what was reported, byte for byte. Present on every result, whatever the resolution. */
  reported: string;
  /**
   * The same file in the engine's own vocabulary — the spelling `changedPaths`, `ScopePolicy` and
   * every invariant use. Present ONLY on `alreadyRelative` and `normalizedFromAbsolute`.
   */
  workspaceRelative?: string;
  resolution: PathTestimonyResolution;
  /** Why, in words, on every resolution that produced no relative form. */
  reason?: string;
}

/**
 * Resolve a directory the way the filesystem does, or fall back to a lexical resolve.
 *
 * `realpathSync` is what makes the macOS `/var` → `/private/var` alias a non-issue, and it is also
 * what makes a symlinked workspace root compare equal to its target. A root that does not exist
 * cannot be realpath'd; that is `unresolvable` rather than an exception.
 */
function realDirectory(candidate: string): string | undefined {
  try {
    return fs.realpathSync(candidate);
  } catch {
    return undefined;
  }
}

const withSeparator = (directory: string): string =>
  (directory.endsWith(path.sep) ? directory : directory + path.sep);

/**
 * Line up one path the agent named against the workspace this attempt actually measured.
 *
 * Pure apart from reading the filesystem to resolve symlinks, and it never throws.
 */
export function reconcileReportedPath(workspaceRoot: string, reported: string): ReconciledPath {
  const realRoot = realDirectory(workspaceRoot);
  if (realRoot === undefined) {
    return {
      reported,
      resolution: 'unresolvable',
      reason: `the workspace root '${workspaceRoot}' could not be resolved on this filesystem, so nothing can be said `
        + 'about where this path points. The reported value is recorded unchanged.',
    };
  }

  // THE RELATIVE CASE. `normalizeRelativePath` refuses `..` outright, and `resolveInside` then
  // refuses a symlink that leaves the tree — both are needed, because the first is lexical and a
  // path with no `..` in it can still escape through a link planted in the workspace.
  if (!path.isAbsolute(reported)) {
    let relative: string;
    try {
      relative = normalizeRelativePath(reported);
    } catch (error) {
      return {
        reported,
        resolution: 'outsideWorkspace',
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    if (relative.length === 0) {
      return { reported, workspaceRelative: '', resolution: 'alreadyRelative' };
    }
    try {
      resolveInside(realRoot, relative);
    } catch (error) {
      return {
        reported,
        resolution: 'outsideWorkspace',
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    return { reported, workspaceRelative: relative, resolution: 'alreadyRelative' };
  }

  // THE ABSOLUTE CASE. Resolve the deepest existing ancestor — the file may not exist any more, and
  // a `Write` reported for a path that was later deleted is still testimony worth lining up.
  let existing = path.resolve(reported);
  const trailing: string[] = [];
  while (realDirectory(existing) === undefined) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    trailing.unshift(path.basename(existing));
    existing = parent;
  }
  const resolvedBase = realDirectory(existing);
  if (resolvedBase === undefined) {
    return {
      reported,
      resolution: 'outsideWorkspace',
      reason: `no part of '${reported}' resolves on this filesystem, so it cannot be shown to name anything inside `
        + `the workspace at ${realRoot}. It is recorded as reported and is not expressed relative to the workspace.`,
    };
  }
  const resolved = path.join(resolvedBase, ...trailing);

  if (resolved !== realRoot && !resolved.startsWith(withSeparator(realRoot))) {
    return {
      reported,
      resolution: 'outsideWorkspace',
      reason: `'${reported}' resolves to '${resolved}', which is not under the workspace root '${realRoot}'. It is `
        + 'recorded as reported and deliberately NOT expressed as a workspace-relative path: a path outside the '
        + 'tree being measured must never be rendered in a form that reads as though it were inside it.',
    };
  }

  const relative = path.relative(realRoot, resolved).split(path.sep).join('/');
  if (relative.length === 0) {
    return { reported, workspaceRelative: '', resolution: 'normalizedFromAbsolute' };
  }
  // The last gate, through the same confinement a driver's write goes through. Belt and braces: the
  // prefix check above is lexical over already-resolved paths, and this is the function whose
  // refusals the rest of the engine is built on.
  try {
    resolveInside(realRoot, relative);
  } catch (error) {
    return {
      reported,
      resolution: 'outsideWorkspace',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  return { reported, workspaceRelative: relative, resolution: 'normalizedFromAbsolute' };
}

/** True when this resolution produced a workspace-relative form a caller may compare against a diff. */
export function reconciledInsideWorkspace(reconciled: ReconciledPath): boolean {
  return reconciled.resolution === 'alreadyRelative' || reconciled.resolution === 'normalizedFromAbsolute';
}

/**
 * The sentence carried on every run whose transcript contains reconciled paths.
 *
 * Written once and quoted, for the same reason `WORKSPACE_ENVIRONMENT_IS_NOT_A_SANDBOX` is: the one
 * thing a reader must not carry away from a tidy relative path is the impression that somebody
 * checked the file.
 */
export const PATH_RECONCILIATION_IS_NOT_OBSERVATION =
  'A workspace-relative path beside an agent-reported one is a RECONCILIATION of what the tool said into the '
  + 'vocabulary this engine uses, so the claim can be compared against the diff. It is not an observation, it does '
  + 'not change the event\'s provenance, and the value the tool actually reported is preserved beside it. What the '
  + 'model did is still decided by the tree this engine snapshotted and the commands this engine ran.';
