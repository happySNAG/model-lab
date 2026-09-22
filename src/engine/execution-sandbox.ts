// Benchmark engine · THE ONE RULE for running code a model has touched, and the OS sandbox it runs in.
//
// THE INCONSISTENCY THIS CLOSES. Two halves of this engine answered the same question two ways.
//
//   The DEVELOPMENT runner refuses to execute candidate-authored code at all: its `executed` scoring
//   tier is declared and reported `notMeasured`, because `isolation.ts` is a path fence and a
//   scrubbed environment and "does not stop a child process from opening a socket".
//
//   The WORKSPACE runner executed candidate-authored code on every attempt. Its verification commands
//   are sealed in the case — `node test/stats.test.js` — but the file that command `require`s is the
//   one the model just edited. So a model-written program ran as the operator's user, with the
//   network and read access to HOME, behind nothing stronger than an allow-listed environment. That is
//   exactly the arrangement the development runner refuses, arriving through the side door.
//
// THE V1 RULE, STATED ONCE. Four different things were being called "running the model's code", and
// they are not the same thing:
//
//   A  THE MODEL EDITS FILES.        Allowed, inside the disposable workspace only. Every write a
//                                    Cernum-owned tool makes goes through `resolveInside`; every write
//                                    an agent CLI makes is judged afterwards from the tree, and the
//                                    pristine baseline copy is re-digested so an escape is detected.
//   B  CERNUM INSPECTS THE PATCH.     Always allowed. A diff, a scope check, a cleanliness check and an
//                                    invariant check read bytes and execute nothing.
//   C  CERNUM RUNS A SEALED COMMAND.  Allowed ONLY under an OS sandbox, and the command's argv comes
//      ON THE MODEL'S TREE            from the frozen case — never from the model. Setup, the baseline
//                                    probe, visible verification, hidden verification, and a Cernum-run
//                                    agent loop's "run the checks" tool are all C. If this machine has no
//                                    OS sandbox Cernum can apply, the run is REFUSED before any attempt
//                                    is made and before anything is spent — never run unsandboxed.
//   D  A MODEL CHOOSES A COMMAND.     CERNUM NEVER EXECUTES ONE. A Cernum-owned agent loop (the Ollama
//                                    driver) offers no free-form command tool at all. A THIRD-PARTY agent
//                                    CLI (claude, codex, opencode) may execute model-chosen commands as
//                                    part of being that tool; that happens inside the tool the operator
//                                    installed, under whatever controls the driver could express — the
//                                    Codex Seatbelt profile, OpenCode's permission table, Claude's
//                                    `--restricted` — each recorded on the attempt, and each driver
//                                    records plainly when its shell is NOT confined
//                                    (`CLAUDE_SHELL_IS_NOT_CONFINED`). The engine's own verdict never
//                                    depends on a command the model chose.
//
// WHY THE STRONGER CONTRACT WAS PRACTICAL. Both machines this project runs on are macOS, and macOS
// ships `sandbox-exec`. The profile below was established by probing it locally — no model, no
// network — and every claim in `SEATBELT_PROFILE_GUARANTEES` is asserted by a test that runs a real
// child under it: network denied, writes outside the workspace and scratch refused, HOME unreadable,
// and a later `allow` re-admitting the workspace even when it lives under HOME (the last matching
// Seatbelt rule wins, which was observed rather than assumed).
//
// WHAT IS NOT CHANGED. The development runner is untouched: its executed tier stays `notMeasured`.
// This module makes a sandbox EXIST; turning that tier on is a separate decision with its own
// evidence, and is not taken here.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { sha256Text } from './canonical';
import { resolveOnChildPath, runCLI } from './cli-process';

/** Where macOS keeps the Seatbelt launcher. Absolute, so a PATH entry can never stand in for it. */
export const SANDBOX_EXEC_PATH = '/usr/bin/sandbox-exec';

/** The profile family Cernum writes. Versioned, so a record says which set of rules it ran under. */
export const SEATBELT_PROFILE_VERSION = 'cernum-seatbelt-1';

export type ExecutionSandboxKind =
  /** macOS Seatbelt through `/usr/bin/sandbox-exec`, with a Cernum-authored profile. */
  | 'macosSeatbelt'
  /** No OS sandbox Cernum can apply on this machine. Sealed commands on a model's tree are REFUSED. */
  | 'unavailable';

export interface ExecutionSandbox {
  kind: ExecutionSandboxKind;
  /** In words: what established this — the platform, the launcher, the canary. */
  detail: string;
}

export const EXECUTION_POLICY_RULE =
  'Cernum never executes a command a model chose. It executes only commands sealed in the benchmark definition, and '
  + 'whenever such a command runs on a tree a model has touched it runs under an OS sandbox (macOS Seatbelt): no '
  + 'network, no writes outside the disposable workspace and its scratch directory, and no reads of the home '
  + 'directory. A machine with no OS sandbox Cernum can apply refuses the run before any attempt is made.';

/** Printed beside every sealed command's outcome. One wording, so no surface softens it. */
export const SEATBELT_PROFILE_GUARANTEES = [
  'network: every socket is denied (inbound and outbound, loopback included)',
  'writes: refused everywhere except the attempt\'s workspace, its scratch TMPDIR and /dev/null-class devices',
  'reads: the home directory is unreadable, except the workspace and the executable\'s own install tree when either '
    + 'lives under it; file METADATA stays readable so a process can resolve its own working directory',
  'processes: children inherit the profile, so a test runner that spawns a helper is confined too',
];

export const SEATBELT_PROFILE_LIMITS =
  'the profile does not hide paths OUTSIDE the home directory (system libraries, /opt, /usr), which a program needs '
  + 'to run at all; it bounds what a model-edited program can change and reach, not everything it can read.';

export const EXECUTION_SANDBOX_UNAVAILABLE =
  'this machine offers no OS sandbox Cernum can apply (macOS Seatbelt via /usr/bin/sandbox-exec), and the workspace '
  + 'benchmark executes sealed verification commands on a tree a model has edited. Under the V1 execution policy that '
  + 'code runs sandboxed or not at all, so nothing was attempted and nothing was spent. '
  + EXECUTION_POLICY_RULE;

/** Every spelling of a directory: as given, and resolved through symlinks (`/var` → `/private/var`). */
function spellings(directory: string): string[] {
  const out = [path.resolve(directory)];
  try { out.push(fs.realpathSync(directory)); } catch { /* the spelling given is still used */ }
  return [...new Set(out)];
}

/** A Seatbelt string literal. Paths are quoted, and a quote or backslash inside one is escaped. */
function sbplString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export interface SeatbeltProfileRequest {
  /** Directories a sealed command may write to: the workspace and its scratch directory. */
  writableRoots: string[];
  /** Directories that must stay readable even when they live under a denied home directory. */
  readableRoots?: string[];
  /** Every home directory to make unreadable. Empty is refused: see `seatbeltProfile`. */
  homeDirectories: string[];
}

/**
 * The profile, as text. PURE apart from resolving symlinks, so a test can read every rule.
 *
 * ORDER IS SEMANTIC. Seatbelt applies the LAST rule that matches, so the denials come first and the
 * narrow re-admissions after them. Observed on this machine, not assumed: with HOME denied and a
 * directory under HOME re-allowed after it, a file in that directory reads and a sibling does not.
 */
export function seatbeltProfile(request: SeatbeltProfileRequest): string {
  const homes = [...new Set(request.homeDirectories.filter((entry) => path.isAbsolute(entry)).flatMap(spellings))].sort();
  if (homes.length === 0) {
    throw new Error('a Seatbelt profile needs the home directory to deny; none could be determined');
  }
  const writable = [...new Set(request.writableRoots.flatMap(spellings))].sort();
  if (writable.length === 0) throw new Error('a Seatbelt profile with no writable root would fail every command');
  const readable = [...new Set([...writable, ...(request.readableRoots ?? []).flatMap(spellings)])].sort();

  return [
    '(version 1)',
    '(allow default)',
    '(deny network*)',
    '(deny file-write*)',
    `(allow file-write* ${writable.map((root) => `(subpath ${sbplString(root)})`).join(' ')} `
      + '(literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper") (regex #"^/dev/fd/") (regex #"^/dev/tty"))',
    `(deny file-read* ${homes.map((home) => `(subpath ${sbplString(home)})`).join(' ')})`,
    '(allow file-read-metadata)',
    `(allow file-read* ${readable.map((root) => `(subpath ${sbplString(root)})`).join(' ')})`,
  ].join('\n');
}

/** The profile's identity, for a record: which rules, not which paths. */
export function seatbeltProfileDigest(profile: string): string {
  return `${SEATBELT_PROFILE_VERSION}:${sha256Text(profile).slice(0, 16)}`;
}

/**
 * The directories an executable is reached through, so a profile denying HOME can re-allow them.
 *
 * Only directories UNDER a home directory need re-allowing; a binary in `/opt/homebrew/bin` is
 * readable anyway. Every symlink hop contributes its directory, for the reason
 * `codexExecutableReadRoots` documents: denying a directory that holds a link breaks traversal.
 */
export function executableReadRoots(executable: string, environment: Record<string, string>,
                                    homeDirectories: string[]): string[] {
  const resolved = resolveOnChildPath(executable, environment);
  if (resolved === undefined) return [];
  const roots: string[] = [];
  let current = resolved;
  for (let hops = 0; hops < 16; hops += 1) {
    roots.push(path.dirname(current));
    let target: string | undefined;
    try { target = fs.readlinkSync(current); } catch { target = undefined; }
    if (target === undefined) break;
    current = path.resolve(path.dirname(current), target);
  }
  try { current = fs.realpathSync(current); } catch { /* keep what was found */ }
  roots.push(path.dirname(current), path.dirname(path.dirname(current)));
  const homes = homeDirectories.flatMap(spellings);
  return [...new Set(roots.flatMap(spellings))]
    .filter((root) => homes.some((home) => root === home || root.startsWith(home + path.sep)))
    .filter((root) => !homes.includes(root))
    .sort();
}

/** Where a command name resolves on the child's PATH. One implementation, shared with `runCLI`. */
export const resolveOnPath = resolveOnChildPath;

let cachedProbe: Promise<ExecutionSandbox> | undefined;

/**
 * Establish whether this machine can apply the sandbox, ONCE per process, by running a canary.
 *
 * The canary is `/usr/bin/true` under the most permissive profile Seatbelt accepts. It proves the
 * launcher exists AND accepts a profile — a binary that is present and refuses every profile (a
 * managed machine, a future OS) would otherwise be discovered one verification at a time.
 */
export function probeExecutionSandbox(options: {
  platform?: NodeJS.Platform;
  exists?: (file: string) => boolean;
  run?: typeof runCLI;
} = {}): Promise<ExecutionSandbox> {
  const injected = options.platform !== undefined || options.exists !== undefined || options.run !== undefined;
  if (!injected && cachedProbe !== undefined) return cachedProbe;
  const probe = (async (): Promise<ExecutionSandbox> => {
    const platform = options.platform ?? process.platform;
    if (platform !== 'darwin') {
      return { kind: 'unavailable', detail: `platform ${platform}: Cernum's only OS sandbox is macOS Seatbelt` };
    }
    const exists = options.exists ?? ((file: string) => fs.existsSync(file));
    if (!exists(SANDBOX_EXEC_PATH)) return { kind: 'unavailable', detail: `${SANDBOX_EXEC_PATH} is not present` };
    const result = await (options.run ?? runCLI)({
      executable: SANDBOX_EXEC_PATH, args: ['-p', '(version 1)(allow default)', '/usr/bin/true'],
      timeoutMilliseconds: 10_000, replaceEnvironment: { PATH: '/usr/bin:/bin' },
    });
    if (result.failure !== undefined || result.exitCode !== 0) {
      return { kind: 'unavailable', detail: `${SANDBOX_EXEC_PATH} did not run a canary under a profile: `
        + `${result.failure?.detail ?? `exit ${result.exitCode}`}` };
    }
    return { kind: 'macosSeatbelt', detail: `${SANDBOX_EXEC_PATH} ran a canary under a Cernum profile on ${platform}` };
  })();
  if (!injected) cachedProbe = probe;
  return probe;
}

/** The home directories a profile denies: the OS's answer and the environment's, both spellings. */
export function homeDirectoriesToDeny(environment: NodeJS.ProcessEnv = process.env): string[] {
  const homes = [os.homedir()];
  if (environment.HOME !== undefined && path.isAbsolute(environment.HOME)) homes.push(environment.HOME);
  return [...new Set(homes.flatMap(spellings))].sort();
}
