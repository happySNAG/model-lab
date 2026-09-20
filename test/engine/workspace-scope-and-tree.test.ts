// The two pure primitives a workspace verdict rests on: which paths were allowed, and what actually
// changed. Both are decided without running anything, so both can be proven exhaustively here.

import { describe, expect, it, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  WorkspaceScopeError, assessScope, classifyPath, normalizeRelativePath, patternMatches, scopePolicy,
} from '../../src/engine/workspace-scope';
import {
  assessPatchCleanliness, copyTree, diffSnapshots, renderPatch, snapshotTree,
} from '../../src/engine/workspace-tree';

const temporary: string[] = [];
afterEach(() => { for (const directory of temporary.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

function scratch(prefix = 'workspace-test-'): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporary.push(directory);
  return directory;
}

function write(root: string, relative: string, contents: string): void {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents, 'utf8');
}

describe('path normalization', () => {
  it('collapses the spellings that mean the same path', () => {
    expect(normalizeRelativePath('./src//calc.ts')).toBe('src/calc.ts');
    expect(normalizeRelativePath('src\\calc.ts')).toBe('src/calc.ts');
    expect(normalizeRelativePath('src/')).toBe('src');
  });

  it('refuses an absolute path and a parent traversal rather than rewriting them', () => {
    expect(() => normalizeRelativePath('/etc/passwd')).toThrow(WorkspaceScopeError);
    expect(() => normalizeRelativePath('src/../../outside')).toThrow(WorkspaceScopeError);
  });
});

describe('pattern matching', () => {
  it('matches an exact path and nothing else', () => {
    expect(patternMatches('src/calc.ts', 'src/calc.ts')).toBe(true);
    expect(patternMatches('src/calc.ts', 'src/calc.test.ts')).toBe(false);
  });

  it('keeps a single star inside one segment', () => {
    expect(patternMatches('src/*.ts', 'src/calc.ts')).toBe(true);
    expect(patternMatches('src/*.ts', 'src/deep/calc.ts')).toBe(false);
    expect(patternMatches('src/*.ts', 'src/calc.js')).toBe(false);
  });

  it('lets a trailing globstar reach any depth, and the directory itself', () => {
    expect(patternMatches('src/**', 'src/a/b/c.ts')).toBe(true);
    expect(patternMatches('src/**', 'src')).toBe(true);
    expect(patternMatches('src/**', 'test/a.ts')).toBe(false);
    expect(patternMatches('**', 'anything/at/all')).toBe(true);
  });

  it('does not let a star match across a separator through a shared literal', () => {
    expect(patternMatches('src/a*z.ts', 'src/abz.ts')).toBe(true);
    expect(patternMatches('src/a*z.ts', 'src/a/z.ts')).toBe(false);
  });
});

describe('scope classification', () => {
  const policy = scopePolicy({ allowed: ['src/**'], forbidden: ['src/generated/**', 'test/**'] });

  it('admits an allowed path', () => {
    expect(classifyPath(policy, 'src/calc.ts')).toBe('inScope');
  });

  it('refuses a path outside the allowed list', () => {
    expect(classifyPath(policy, 'docs/readme.md')).toBe('outOfScope');
  });

  it('lets forbidden win over allowed', () => {
    // `src/generated/**` is inside `src/**`. A reader must be able to rely on the narrower rule.
    expect(classifyPath(policy, 'src/generated/parser.ts')).toBe('forbidden');
  });

  it('treats an empty allow-list as unconstrained rather than as refusing everything', () => {
    const open = scopePolicy({ forbidden: ['test/**'] });
    expect(classifyPath(open, 'anything.ts')).toBe('inScope');
    expect(classifyPath(open, 'test/a.ts')).toBe('forbidden');
  });

  it('assesses a whole change set in a stable order', () => {
    const assessment = assessScope(policy, ['test/a.ts', 'src/calc.ts', 'docs/readme.md']);
    expect(assessment.clean).toBe(false);
    expect(assessment.inScopePaths).toEqual(['src/calc.ts']);
    expect(assessment.violations.map((violation) => violation.path)).toEqual(['docs/readme.md', 'test/a.ts']);
    expect(assessment.violations.map((violation) => violation.decision)).toEqual(['outOfScope', 'forbidden']);
  });
});

describe('tree snapshots', () => {
  it('digests the same tree to the same value and a changed one to a different value', () => {
    const root = scratch();
    write(root, 'a/one.txt', 'hello');
    write(root, 'b/two.txt', 'world');
    const first = snapshotTree(root);
    const second = snapshotTree(root);
    expect(second.treeDigest).toBe(first.treeDigest);
    expect(first.fileCount).toBe(2);

    write(root, 'b/two.txt', 'world!');
    expect(snapshotTree(root).treeDigest).not.toBe(first.treeDigest);
  });

  it('records a symlink without following it', () => {
    const root = scratch();
    const outside = scratch();
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'not for the candidate');
    fs.symlinkSync(outside, path.join(root, 'escape'));
    const snapshot = snapshotTree(root);
    expect(snapshot.entries).toHaveLength(1);
    expect(snapshot.entries[0].symlink).toBe(true);
    // The pointed-at file is not in the listing, so its content never enters the digest.
    expect(snapshot.entries.map((entry) => entry.path)).not.toContain('escape/secret.txt');
  });
});

describe('copying a fixture', () => {
  it('leaves the source untouched, whatever is done to the copy', () => {
    const source = scratch();
    write(source, 'src/stats.js', 'original');
    const before = snapshotTree(source).treeDigest;

    const destination = path.join(scratch(), 'work');
    copyTree(source, destination);
    write(destination, 'src/stats.js', 'rewritten by a model');
    fs.rmSync(path.join(destination, 'src'), { recursive: true, force: true });

    expect(snapshotTree(source).treeDigest).toBe(before);
    expect(fs.readFileSync(path.join(source, 'src/stats.js'), 'utf8')).toBe('original');
  });
});

describe('diff and patch', () => {
  function twoTrees() {
    const parent = scratch();
    const before = path.join(parent, 'before');
    const after = path.join(parent, 'after');
    write(before, 'src/calc.js', 'const a = 1;\nconst b = 2;\nmodule.exports = a + b;\n');
    write(before, 'docs/readme.md', 'old\n');
    copyTree(before, after);
    return { before, after };
  }

  it('renders a byte-stable unified patch with no timestamps', () => {
    const { before, after } = twoTrees();
    write(after, 'src/calc.js', 'const a = 1;\nconst b = 3;\nmodule.exports = a + b;\n');
    const diff = diffSnapshots(snapshotTree(before), snapshotTree(after), { beforeRoot: before, afterRoot: after });
    const first = renderPatch(diff, { beforeRoot: before, afterRoot: after });
    const second = renderPatch(diff, { beforeRoot: before, afterRoot: after });

    expect(first.text).toBe(second.text);
    expect(first.patchDigest).toBe(second.patchDigest);
    expect(first.text).toContain('--- a/src/calc.js');
    expect(first.text).toContain('+++ b/src/calc.js');
    expect(first.text).toContain('-const b = 2;');
    expect(first.text).toContain('+const b = 3;');
    expect(first.text).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('counts added and removed lines, and names added and removed files', () => {
    const { before, after } = twoTrees();
    write(after, 'src/new.js', 'one\ntwo\n');
    fs.rmSync(path.join(after, 'docs/readme.md'));
    const diff = diffSnapshots(snapshotTree(before), snapshotTree(after), { beforeRoot: before, afterRoot: after });

    expect(diff.addedFileCount).toBe(1);
    expect(diff.removedFileCount).toBe(1);
    expect(diff.addedLineCount).toBe(2);
    expect(diff.removedLineCount).toBe(1);
    expect(diff.changedPaths).toEqual(['docs/readme.md', 'src/new.js']);
  });

  it('reports an unchanged tree as clean', () => {
    const { before, after } = twoTrees();
    const diff = diffSnapshots(snapshotTree(before), snapshotTree(after), { beforeRoot: before, afterRoot: after });
    expect(diff.clean).toBe(true);
    expect(renderPatch(diff, { beforeRoot: before, afterRoot: after }).text).toBe('');
  });

  it('names a binary change without inlining it', () => {
    const { before, after } = twoTrees();
    fs.writeFileSync(path.join(after, 'blob.bin'), Buffer.from([0, 1, 2, 3, 0, 255]));
    const diff = diffSnapshots(snapshotTree(before), snapshotTree(after), { beforeRoot: before, afterRoot: after });
    const patch = renderPatch(diff, { beforeRoot: before, afterRoot: after });
    expect(patch.text).toContain('Binary files differ');
    expect(patch.truncated).toBe(true);
    expect(patch.omittedPaths).toEqual(['blob.bin']);
  });
});

describe('patch cleanliness', () => {
  it('catches a conflict marker left in a changed file', () => {
    const parent = scratch();
    const before = path.join(parent, 'before');
    const after = path.join(parent, 'after');
    write(before, 'src/calc.js', 'a\n');
    copyTree(before, after);
    write(after, 'src/calc.js', '<<<<<<< HEAD\na\n=======\nb\n>>>>>>> theirs\n');
    const diff = diffSnapshots(snapshotTree(before), snapshotTree(after), { beforeRoot: before, afterRoot: after });
    const findings = assessPatchCleanliness(after, diff);
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('conflictMarker');
  });

  it('catches the residue of a failed patch application', () => {
    const parent = scratch();
    const before = path.join(parent, 'before');
    const after = path.join(parent, 'after');
    write(before, 'src/calc.js', 'a\n');
    copyTree(before, after);
    write(after, 'src/calc.js.orig', 'a\n');
    const diff = diffSnapshots(snapshotTree(before), snapshotTree(after), { beforeRoot: before, afterRoot: after });
    expect(assessPatchCleanliness(after, diff).map((finding) => finding.kind)).toEqual(['strayArtefact']);
  });
});
