// Lining up a path the AGENT NAMED with the paths this engine OBSERVED — and the five ways that
// must fail rather than succeed tidily.
//
// THE FINDING. In the first live workspace run `claude` reported editing
// `/private/var/folders/…/cernum-ws-…/work/src/stats.js` while `changedPaths` said `src/stats.js`.
// Both correct, neither comparable. The fix expresses the claim in the engine's vocabulary BESIDE
// the claim, and the point of most of this file is that the expression stops at the workspace
// boundary: a path outside the tree must never gain a relative-looking form, because every table
// that shows this column would then read an out-of-scope edit as an in-scope one.

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  PATH_RECONCILIATION_IS_NOT_OBSERVATION, reconcileReportedPath, reconciledInsideWorkspace,
} from '../../src/engine/workspace-path-reconciliation';
import { TranscriptBuilder } from '../../src/engine/workspace-transcript';

const temporaries: string[] = [];
afterEach(() => { for (const directory of temporaries.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

/** A real directory tree, because every rule here is about what the FILESYSTEM resolves. */
function workspace(): { root: string; outside: string } {
  const attempt = fs.mkdtempSync(path.join(os.tmpdir(), 'cernum-reconcile-'));
  temporaries.push(attempt);
  const root = path.join(attempt, 'work');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'stats.js'), 'module.exports = {};\n');
  const outside = path.join(attempt, 'baseline');
  fs.mkdirSync(path.join(outside, 'src'), { recursive: true });
  fs.writeFileSync(path.join(outside, 'src', 'stats.js'), 'module.exports = {};\n');
  return { root, outside };
}

describe('testimony is expressed in the engine\'s vocabulary, and only when it belongs there', () => {
  it('normalizes an absolute path that resolves inside the workspace', () => {
    const { root } = workspace();
    const reconciled = reconcileReportedPath(root, path.join(root, 'src', 'stats.js'));
    expect(reconciled.resolution).toBe('normalizedFromAbsolute');
    expect(reconciled.workspaceRelative).toBe('src/stats.js');
    // THE REPORTED VALUE SURVIVES. This is the whole discipline: the second field explains the
    // first, and never replaces it.
    expect(reconciled.reported).toBe(path.join(root, 'src', 'stats.js'));
    expect(reconciledInsideWorkspace(reconciled)).toBe(true);
  });

  it('accepts an already-relative path and says so, rather than pretending it did work', () => {
    const { root } = workspace();
    const reconciled = reconcileReportedPath(root, './src/stats.js');
    expect(reconciled.resolution).toBe('alreadyRelative');
    expect(reconciled.workspaceRelative).toBe('src/stats.js');
    expect(reconciled.reported).toBe('./src/stats.js');
  });

  it('handles the macOS /var → /private/var alias, because it is one directory spelled two ways', () => {
    const { root } = workspace();
    // The runner realpaths its side; the tool may report either spelling. Both must line up, and the
    // alias is resolved by the filesystem rather than by stripping a prefix off a string.
    const aliased = root.startsWith('/private/') ? root.slice('/private'.length) : path.join('/private', root);
    if (!fs.existsSync(aliased)) {
      // Not every platform has the alias. Where it does not exist there is nothing to reconcile, and
      // the test says so rather than asserting a behaviour this machine cannot exhibit.
      expect(fs.realpathSync(root)).toBe(fs.realpathSync(root));
      return;
    }
    const reconciled = reconcileReportedPath(root, path.join(aliased, 'src', 'stats.js'));
    expect(reconciled.resolution).toBe('normalizedFromAbsolute');
    expect(reconciled.workspaceRelative).toBe('src/stats.js');
    // And the same in reverse: a root spelled one way, a report spelled the other.
    expect(reconcileReportedPath(aliased, path.join(root, 'src', 'stats.js')).workspaceRelative).toBe('src/stats.js');
  });

  it('refuses an absolute path OUTSIDE the workspace, and gives it no relative form', () => {
    const { root, outside } = workspace();
    const reconciled = reconcileReportedPath(root, path.join(outside, 'src', 'stats.js'));
    expect(reconciled.resolution).toBe('outsideWorkspace');
    expect(reconciled.workspaceRelative).toBeUndefined();
    expect(reconciled.reported).toBe(path.join(outside, 'src', 'stats.js'));
    expect(reconciled.reason).toMatch(/not under the workspace root/);
    expect(reconciledInsideWorkspace(reconciled)).toBe(false);
  });

  it('refuses `..` traversal rather than normalizing it away', () => {
    const { root } = workspace();
    const reconciled = reconcileReportedPath(root, '../baseline/src/stats.js');
    expect(reconciled.resolution).toBe('outsideWorkspace');
    expect(reconciled.workspaceRelative).toBeUndefined();
    expect(reconciled.reason).toMatch(/'\.\.' segment/);
  });

  it('refuses a path THROUGH a symlink planted inside the workspace', () => {
    const { root, outside } = workspace();
    // Creating the link is legitimate — a model may run `ln -s`. The question is whether a path that
    // goes through it is refused, and it is, by the same `resolveInside` the drivers use.
    fs.symlinkSync(outside, path.join(root, 'escape'));
    const relative = reconcileReportedPath(root, 'escape/src/stats.js');
    expect(relative.resolution).toBe('outsideWorkspace');
    expect(relative.workspaceRelative).toBeUndefined();
    const absolute = reconcileReportedPath(root, path.join(root, 'escape', 'src', 'stats.js'));
    expect(absolute.resolution).toBe('outsideWorkspace');
    expect(absolute.workspaceRelative).toBeUndefined();
  });

  it('reconciles a path for a file that no longer exists, because a claim is still worth lining up', () => {
    const { root } = workspace();
    const reconciled = reconcileReportedPath(root, path.join(root, 'src', 'deleted-later.js'));
    expect(reconciled.resolution).toBe('normalizedFromAbsolute');
    expect(reconciled.workspaceRelative).toBe('src/deleted-later.js');
  });

  it('says so, rather than throwing, when the workspace root cannot be resolved', () => {
    const reconciled = reconcileReportedPath(path.join(os.tmpdir(), 'cernum-no-such-workspace'), 'src/stats.js');
    expect(reconciled.resolution).toBe('unresolvable');
    expect(reconciled.workspaceRelative).toBeUndefined();
    expect(reconciled.reported).toBe('src/stats.js');
  });
});

describe('reconciliation is not promotion', () => {
  it('leaves an agent-reported event agent-reported, and keeps the reported path verbatim', () => {
    const { root } = workspace();
    const builder = new TranscriptBuilder(0, () => 0, root);
    const absolute = path.join(root, 'src', 'stats.js');
    const event = builder.emit('fileWrite', 'agentReported', 0, `the tool reported writing ${absolute}`,
      { path: absolute, toolName: 'Edit' });

    // THE PROVENANCE IS UNTOUCHED. A tool saying it wrote a file is still the tool saying so.
    expect(event.provenance).toBe('agentReported');
    expect(event.path).toBe(absolute);
    expect(event.workspaceRelativePath).toBe('src/stats.js');
    expect(event.pathResolution).toBe('normalizedFromAbsolute');
  });

  it('does not touch an ENGINE-OBSERVED path, which is already the engine\'s own arithmetic', () => {
    const { root } = workspace();
    const builder = new TranscriptBuilder(0, () => 0, root);
    const event = builder.emit('fileWrite', 'engineObserved', 0, 'wrote src/stats.js', { path: 'src/stats.js' });
    expect(event.path).toBe('src/stats.js');
    expect(event.workspaceRelativePath).toBeUndefined();
    expect(event.pathResolution).toBeUndefined();
  });

  it('records an out-of-workspace claim as out-of-workspace, and counts it in the summary', () => {
    const { root, outside } = workspace();
    const builder = new TranscriptBuilder(0, () => 0, root);
    const escaping = path.join(outside, 'src', 'stats.js');
    const event = builder.emit('fileWrite', 'agentReported', 0, 'the tool reported writing outside the tree',
      { path: escaping, toolName: 'Write' });
    expect(event.path).toBe(escaping);
    expect(event.workspaceRelativePath).toBeUndefined();
    expect(event.pathResolution).toBe('outsideWorkspace');

    builder.emit('fileRead', 'agentReported', 0, 'read', { path: path.join(root, 'src', 'stats.js'), toolName: 'Read' });
    const summary = builder.build().summary;
    expect(summary.reportedPathsOutsideWorkspace).toBe(1);
    expect(summary.reportedPathsNormalizedFromAbsolute).toBe(1);
  });

  it('records nothing extra when the builder was given no workspace root', () => {
    const builder = new TranscriptBuilder(0, () => 0);
    const event = builder.emit('fileWrite', 'agentReported', 0, 'wrote', { path: '/somewhere/else.js' });
    expect(event.path).toBe('/somewhere/else.js');
    expect(event.workspaceRelativePath).toBeUndefined();
    expect(event.pathResolution).toBeUndefined();
  });

  it('states in one place that a tidy relative path is not an observation', () => {
    expect(PATH_RECONCILIATION_IS_NOT_OBSERVATION).toMatch(/not an observation/);
    expect(PATH_RECONCILIATION_IS_NOT_OBSERVATION).toMatch(/does not change the event's provenance/);
  });
});
