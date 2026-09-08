// Benchmark engine · run candidate-generated work without letting it reach anything that matters.
// The portable counterpart of the proven `sandbox_v2.py`.
//
// THE THREAT MODEL IS NOT A MALICIOUS ATTACKER — it is a capable model that writes plausible code.
// A model asked to make tests pass may try to read the test file, write to it, reach the network
// for a package, or wander up the filesystem. None of that should be POSSIBLE, so that a score
// means what it claims to mean.
//
// WHAT THIS ENFORCES, HONESTLY STATED. Python's harness monkey-patches `builtins.open`,
// `socket.socket` and `subprocess.Popen` inside the interpreter that runs the candidate's code.
// Node has no equivalent in-process hook that a determined caller cannot route around, so this
// module does NOT claim to be an OS sandbox. It enforces exactly this, and each is proven by a
// test in `test/engine/isolation.test.ts`:
//
//   temp workspace      every attempt gets a fresh directory under the OS temp root; fixtures are
//                       COPIED in as data. The originals are never on disk anywhere the attempt
//                       can reach.
//   path confinement    `resolveInside` resolves absolute paths, `..` traversal AND symlinks
//                       before checking, and refuses anything outside the workspace root. Every
//                       file the engine opens on an attempt's behalf goes through it.
//   scrubbed env        `isolatedEnvironment` returns a minimal environment. No HOME, no
//                       credential-shaped variables, no ANTHROPIC_*/OPENAI_*/AWS_*/OLLAMA_* names.
//   no persistent state the workspace is deleted after the attempt, whether it succeeded or not.
//
// WHAT IT DOES NOT ENFORCE, stated so nobody relies on it: it does not block a child process from
// opening a socket. The engine never spawns one for a candidate — `docs/ENGINE.md` records that
// limitation, and executing untrusted candidate CODE (as opposed to scoring candidate TEXT) stays
// out of the desktop product until there is a real sandbox to put it in.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export class IsolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IsolationError';
  }
}

/** Environment variable names that must never reach an isolated workspace, matched case-insensitively. */
const FORBIDDEN_ENVIRONMENT_PREFIXES = ['ANTHROPIC_', 'OPENAI_', 'AWS_', 'OLLAMA_', 'GITHUB_', 'GOOGLE_', 'AZURE_', 'HF_', 'NPM_'];
const FORBIDDEN_ENVIRONMENT_SUBSTRINGS = ['TOKEN', 'SECRET', 'PASSWORD', 'CREDENTIAL', 'API_KEY', 'APIKEY', 'PRIVATE_KEY', 'SESSION'];
const FORBIDDEN_ENVIRONMENT_NAMES = ['HOME', 'USER', 'LOGNAME', 'USERPROFILE', 'SSH_AUTH_SOCK', 'XDG_RUNTIME_DIR'];

/**
 * The minimal environment an isolated attempt is given. Everything is denied unless it is one of a
 * handful of names that only describe the machine — an allow-list, because a deny-list of secret
 * names is always one new vendor prefix out of date.
 */
export function isolatedEnvironment(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const permitted = new Set(['PATH', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR']);
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (!permitted.has(name)) continue;
    out[name] = value;
  }
  return out;
}

/** True when a variable must never be passed through, whatever else is decided. */
export function isForbiddenEnvironmentName(name: string): boolean {
  const upper = name.toUpperCase();
  if (FORBIDDEN_ENVIRONMENT_NAMES.includes(upper)) return true;
  if (FORBIDDEN_ENVIRONMENT_PREFIXES.some((prefix) => upper.startsWith(prefix))) return true;
  return FORBIDDEN_ENVIRONMENT_SUBSTRINGS.some((fragment) => upper.includes(fragment));
}

export interface IsolatedWorkspace {
  root: string;
  /** Resolve a relative path inside the workspace, refusing every escape. */
  resolve(relative: string): string;
  /** Copy a fixture in as data. The source is read once and never referenced again. */
  placeFixture(relative: string, contents: string | Uint8Array): string;
  read(relative: string): string;
  list(): string[];
  environment(): Record<string, string>;
  dispose(): void;
}

/**
 * Resolve `relative` inside `root`, refusing anything that escapes.
 *
 * Symlinks are resolved BEFORE the check, so a symlink planted inside the workspace that points at
 * the real filesystem is refused rather than followed. `fs.realpathSync` on a path that does not
 * exist yet throws, so the deepest existing ancestor is resolved and the remainder appended — which
 * is what makes "create a new file" work while "create a new file through a symlinked directory"
 * does not.
 */
export function resolveInside(root: string, relative: string): string {
  if (path.isAbsolute(relative)) {
    throw new IsolationError(`refusing an absolute path (${relative}); an isolated attempt addresses its workspace by relative path only`);
  }
  const realRoot = fs.realpathSync(root);
  const target = path.resolve(realRoot, relative);

  let existing = target;
  const trailing: string[] = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    trailing.unshift(path.basename(existing));
    existing = parent;
  }
  const resolved = path.join(fs.realpathSync(existing), ...trailing);
  const withSeparator = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
  if (resolved !== realRoot && !resolved.startsWith(withSeparator)) {
    throw new IsolationError(`refusing a path that resolves outside the workspace: ${relative} resolves to ${resolved}, which is not under ${realRoot}`);
  }
  return resolved;
}

/** A fresh, empty, disposable workspace. Nothing an attempt writes survives it. */
export function createIsolatedWorkspace(prefix = 'engine-attempt-'): IsolatedWorkspace {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  let disposed = false;
  const guard = (): void => {
    if (disposed) throw new IsolationError('this workspace has been disposed; an attempt cannot reach back into it after it finished');
  };
  return {
    root,
    resolve(relative: string): string {
      guard();
      return resolveInside(root, relative);
    },
    placeFixture(relative: string, contents: string | Uint8Array): string {
      guard();
      const target = resolveInside(root, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, contents);
      return target;
    },
    read(relative: string): string {
      guard();
      return fs.readFileSync(resolveInside(root, relative), 'utf8');
    },
    list(): string[] {
      guard();
      const out: string[] = [];
      const walk = (directory: string): void => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
          const full = path.join(directory, entry.name);
          if (entry.isDirectory()) walk(full);
          else out.push(path.relative(root, full));
        }
      };
      walk(root);
      return out.sort();
    },
    environment(): Record<string, string> {
      guard();
      return { ...isolatedEnvironment(), TMPDIR: root };
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Run `work` in a fresh workspace and delete it afterwards, whether or not `work` threw. */
export async function withIsolatedWorkspace<T>(work: (workspace: IsolatedWorkspace) => Promise<T>, prefix?: string): Promise<T> {
  const workspace = createIsolatedWorkspace(prefix);
  try {
    return await work(workspace);
  } finally {
    workspace.dispose();
  }
}
