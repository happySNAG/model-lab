// The isolation boundary is only worth having if every escape is actually refused. Each of these
// is one of the ways a plausible-looking piece of generated code tries to leave its workspace.

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { IsolationError, createIsolatedWorkspace, isForbiddenEnvironmentName, isolatedEnvironment, resolveInside, withIsolatedWorkspace } from '../../src/engine/isolation';

const created: { dispose(): void }[] = [];
afterEach(() => { for (const workspace of created.splice(0)) workspace.dispose(); });

function workspace() {
  const created_ = createIsolatedWorkspace('engine-isolation-test-');
  created.push(created_);
  return created_;
}

describe('path confinement', () => {
  it('allows an ordinary relative path, including a nested one', () => {
    const w = workspace();
    w.placeFixture('a/b/fixture.txt', 'data');
    expect(w.read('a/b/fixture.txt')).toBe('data');
    expect(w.list()).toEqual(['a/b/fixture.txt']);
  });

  it('refuses an absolute path', () => {
    expect(() => workspace().resolve('/etc/passwd')).toThrow(IsolationError);
  });

  it('refuses parent traversal, however deeply nested', () => {
    const w = workspace();
    expect(() => w.resolve('../outside.txt')).toThrow(IsolationError);
    expect(() => w.resolve('a/b/../../../outside.txt')).toThrow(IsolationError);
  });

  it('refuses a path that reaches outside through a symlink', () => {
    const w = workspace();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-outside-'));
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'not for the candidate');
    fs.symlinkSync(outside, path.join(w.root, 'escape'));
    try {
      expect(() => w.resolve('escape/secret.txt')).toThrow(/resolves outside the workspace/);
      expect(() => w.read('escape/secret.txt')).toThrow(IsolationError);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('refuses to create a new file THROUGH a symlinked directory', () => {
    const w = workspace();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-outside-'));
    fs.symlinkSync(outside, path.join(w.root, 'out'));
    try {
      expect(() => w.placeFixture('out/planted.txt', 'x')).toThrow(IsolationError);
      expect(fs.existsSync(path.join(outside, 'planted.txt'))).toBe(false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('resolves the workspace root itself without refusing it', () => {
    const w = workspace();
    expect(resolveInside(w.root, '.')).toBe(fs.realpathSync(w.root));
  });
});

describe('fixtures are copied in as data', () => {
  it('never references the original after the copy', () => {
    const w = workspace();
    const source = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-source-'));
    const original = path.join(source, 'repo.txt');
    fs.writeFileSync(original, 'version one');
    w.placeFixture('repo.txt', fs.readFileSync(original, 'utf8'));
    fs.writeFileSync(original, 'version two');
    expect(w.read('repo.txt')).toBe('version one');
    fs.rmSync(source, { recursive: true, force: true });
    expect(w.read('repo.txt')).toBe('version one');
  });
});

describe('environment scrubbing', () => {
  it('passes through only the handful of names that describe the machine', () => {
    const scrubbed = isolatedEnvironment({
      PATH: '/usr/bin', LANG: 'en_US.UTF-8', TZ: 'UTC',
      HOME: '/Users/someone', ANTHROPIC_API_KEY: 'sk-x', OPENAI_API_KEY: 'sk-y',
      AWS_SECRET_ACCESS_KEY: 'z', OLLAMA_HOST: 'http://x', GITHUB_TOKEN: 't',
      MY_APP_PASSWORD: 'p', SSH_AUTH_SOCK: '/tmp/sock',
    });
    expect(Object.keys(scrubbed).sort()).toEqual(['LANG', 'PATH', 'TZ']);
  });

  it('names a forbidden variable by prefix, by substring and by exact name', () => {
    for (const name of ['ANTHROPIC_API_KEY', 'OPENAI_ORG', 'AWS_REGION', 'OLLAMA_HOST', 'HOME', 'USER',
      'SOME_TOKEN', 'db_password', 'my_secret_thing', 'SSH_AUTH_SOCK', 'X_API_KEY', 'SESSION_ID']) {
      expect(isForbiddenEnvironmentName(name), name).toBe(true);
    }
    for (const name of ['PATH', 'LANG', 'TZ', 'TMPDIR']) expect(isForbiddenEnvironmentName(name), name).toBe(false);
  });

  it('points TMPDIR at the workspace, so a stray temp file lands inside the boundary', () => {
    const w = workspace();
    expect(w.environment().TMPDIR).toBe(w.root);
  });
});

describe('no persistent state', () => {
  it('deletes the workspace on dispose, whatever was written into it', () => {
    const w = createIsolatedWorkspace('engine-isolation-test-');
    w.placeFixture('deep/nested/file.txt', 'x');
    const root = w.root;
    w.dispose();
    expect(fs.existsSync(root)).toBe(false);
  });

  it('refuses to be used again after disposal', () => {
    const w = createIsolatedWorkspace('engine-isolation-test-');
    w.dispose();
    expect(() => w.resolve('x')).toThrow(/has been disposed/);
  });

  it('deletes the workspace even when the work throws', async () => {
    let root = '';
    await expect(withIsolatedWorkspace(async (w) => {
      root = w.root;
      w.placeFixture('x.txt', 'y');
      throw new Error('the attempt failed');
    })).rejects.toThrow('the attempt failed');
    expect(fs.existsSync(root)).toBe(false);
  });

  it('gives every attempt a distinct workspace', () => {
    const a = workspace();
    const b = workspace();
    expect(a.root).not.toBe(b.root);
  });
});
