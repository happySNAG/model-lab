// Benchmark engine · running somebody else's command-line tool, and being able to stop.
//
// A subscription CLI is a CHILD PROCESS, and that is a materially different failure surface from an
// HTTP request. A request that is abandoned stops costing anything the moment the socket closes. A
// child process that is abandoned keeps running: it keeps its file handles, it keeps its slot in the
// user's rate limit, it keeps consuming the allowance the run was supposed to be measuring, and on
// the next campaign it is still there competing with its own successor.
//
// So every process this module starts is owned. Owned means:
//
//   * it is started detached, in its own PROCESS GROUP, so a signal reaches the tool AND anything
//     the tool spawned. A CLI that shells out — and they do — leaves orphans otherwise, and an
//     orphaned model request is an orphaned charge.
//   * it has a deadline, enforced here rather than hoped for.
//   * `terminate()` sends SIGTERM to the group, waits a grace period, then SIGKILL. A tool that is
//     mid-flush gets the chance to finish the line it was writing; a tool that is wedged does not
//     get to ignore us.
//   * it is registered in a module-level set until it exits, so `terminateAll()` can stop everything
//     a pause or an abort left running, from a handler that has no reference to any of them.
//
// THE ENVIRONMENT IS NARROWED, NOT INHERITED. The tool is authenticated by its own session. Handing
// it this process's ANTHROPIC_API_KEY would let a run the person authorised as subscription-included
// quietly bill their card instead, which is the single worst thing this module could do.
//
// NOTHING HERE KNOWS WHAT A MODEL IS. It runs a command, times it, watches the first byte arrive,
// and reports what came back. Deciding what to ask and how to read the answer is the adapter's job.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ChildProcess, spawn } from 'node:child_process';
import { environmentWithoutCredentials, redactSecrets } from './redaction';

export type CLIFailureKind =
  /** The executable was not found. */
  | 'notInstalled'
  /** The deadline passed with the process still running. */
  | 'timeout'
  /** The caller asked for it to stop — a pause or an abort. */
  | 'cancelled'
  /** It exited non-zero. */
  | 'exitFailure'
  /** It could not be started at all. */
  | 'spawnFailure';

export interface CLIResult {
  /** Exactly what the tool wrote to stdout, redacted. */
  stdout: string;
  stderr: string;
  exitCode: number | null;
  /** The signal that ended it, when one did. `SIGTERM` here means Cernum stopped it. */
  signal: NodeJS.Signals | null;
  /** Milliseconds from spawn to exit, on this process's clock. */
  elapsedMilliseconds: number;
  /**
   * Milliseconds from spawn to the FIRST BYTE on stdout. Undefined when nothing ever arrived.
   *
   * This is the closest honest analogue of time-to-first-token for a tool that does not stream
   * tokens as such, and it is recorded as an observation of when bytes landed — never derived from
   * a duration the tool reported afterwards.
   */
  firstOutputMilliseconds?: number;
  failure?: { kind: CLIFailureKind; detail: string };
}

export interface CLIRunOptions {
  executable: string;
  args: string[];
  /** Written to the tool's stdin, then stdin is closed. Keeps a long prompt out of the process table. */
  input?: string;
  timeoutMilliseconds: number;
  /** Milliseconds between SIGTERM and SIGKILL. A tool mid-write gets this long to finish its line. */
  graceMilliseconds?: number;
  workingDirectory?: string;
  /** Extra variables the tool needs. Merged AFTER credentials are stripped, so this is the only way in. */
  extraEnvironment?: Record<string, string>;
  /** Called the moment the first stdout byte lands, with its arrival time. */
  onFirstOutput?: (atMilliseconds: number) => void;
  /** Called for every stdout chunk as it arrives, with its arrival time. */
  onChunk?: (chunk: string, atMilliseconds: number) => void;
  /** Return true to stop the process at the next opportunity. Polled, so a wedged tool still dies. */
  shouldCancel?: () => boolean;
  /** Injected for tests; defaults to the real clock. */
  now?: () => number;
}

/** Every process this module currently owns. Module-level so a signal handler can reach them all. */
const live = new Set<OwnedProcess>();

/** A running child, and the only two things a caller is allowed to do with one. */
export class OwnedProcess {
  private killTimer?: NodeJS.Timeout;

  constructor(readonly child: ChildProcess, readonly describe: string) {}

  get pid(): number | undefined {
    return this.child.pid;
  }

  /**
   * Stop it, and mean it.
   *
   * The signal goes to the process GROUP (negative pid), not to the process, because a CLI that
   * spawned its own helper leaves that helper holding the request otherwise. SIGKILL follows after
   * the grace period whether or not SIGTERM was acknowledged — a tool that ignores SIGTERM is
   * exactly the tool that must not survive a pause.
   */
  terminate(graceMilliseconds = 2_000): void {
    const pid = this.child.pid;
    if (pid === undefined || this.child.exitCode !== null || this.child.signalCode !== null) return;
    signalGroup(pid, 'SIGTERM');
    if (this.killTimer) return;
    this.killTimer = setTimeout(() => {
      if (this.child.exitCode === null && this.child.signalCode === null) signalGroup(pid, 'SIGKILL');
    }, graceMilliseconds);
    // A pending kill timer must not be the reason a terminal command refuses to exit.
    this.killTimer.unref?.();
  }

  settled(): void {
    if (this.killTimer) clearTimeout(this.killTimer);
    this.killTimer = undefined;
    live.delete(this);
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    // Negative pid is the process group. `detached: true` at spawn is what makes the child the
    // leader of one, so this reaches its descendants too.
    process.kill(-pid, signal);
  } catch {
    // The group may already be gone — which is the outcome we wanted. Fall back to the process
    // itself in case the platform did not give it its own group.
    try { process.kill(pid, signal); } catch { /* already gone */ }
  }
}

/**
 * Stop every child this module owns.
 *
 * Called from a pause, from an abort, and from the terminal command's signal handler. It is safe to
 * call when nothing is running, and safe to call twice.
 */
export function terminateAllCLIProcesses(graceMilliseconds = 2_000): number {
  const count = live.size;
  for (const owned of [...live]) owned.terminate(graceMilliseconds);
  return count;
}

/** How many children are running right now. For a status view and for the tests. */
export function liveCLIProcessCount(): number {
  return live.size;
}

/**
 * Run one command to completion, or to its deadline, or until the caller cancels it.
 *
 * Never throws for a tool that failed: a non-zero exit, a timeout and a cancellation are all
 * ORDINARY OUTCOMES of asking a tool to do something, and turning them into exceptions loses the
 * stdout that explains them. It throws only when the caller asked for something impossible.
 */
export function runCLI(options: CLIRunOptions): Promise<CLIResult> {
  const now = options.now ?? (() => Date.now());
  const grace = options.graceMilliseconds ?? 2_000;
  const startedAt = now();

  return new Promise<CLIResult>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(options.executable, options.args, {
        cwd: options.workingDirectory,
        // Its own process group, so terminate() reaches whatever it spawns.
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...environmentWithoutCredentials(process.env), ...(options.extraEnvironment ?? {}) },
        windowsHide: true,
      });
    } catch (error) {
      resolve({
        stdout: '', stderr: '', exitCode: null, signal: null, elapsedMilliseconds: now() - startedAt,
        failure: { kind: 'spawnFailure', detail: redactSecrets(error instanceof Error ? error.message : String(error)) },
      });
      return;
    }

    const owned = new OwnedProcess(child, `${options.executable} ${options.args.join(' ')}`);
    live.add(owned);

    let stdout = '';
    let stderr = '';
    let firstOutputMilliseconds: number | undefined;
    let outcome: { kind: CLIFailureKind; detail: string } | undefined;
    let finished = false;

    const deadline = setTimeout(() => {
      outcome = {
        kind: 'timeout',
        detail: `the tool did not finish within ${options.timeoutMilliseconds} ms and was stopped; `
          + 'a request still in flight at its deadline is an unfinished measurement, not a slow one',
      };
      owned.terminate(grace);
    }, options.timeoutMilliseconds);
    deadline.unref?.();

    // Cancellation is POLLED rather than awaited on a promise, so a tool that has stopped producing
    // output — the wedged case — is still reachable by a pause.
    const cancelPoll = options.shouldCancel
      ? setInterval(() => {
        if (finished || !options.shouldCancel?.()) return;
        outcome = { kind: 'cancelled', detail: 'the run was paused or aborted, and this request was stopped before it finished' };
        owned.terminate(grace);
      }, 200)
      : undefined;
    cancelPoll?.unref?.();

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      const at = now() - startedAt;
      if (firstOutputMilliseconds === undefined) {
        firstOutputMilliseconds = at;
        options.onFirstOutput?.(at);
      }
      stdout += chunk;
      options.onChunk?.(chunk, at);
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => { stderr += chunk; });

    child.on('error', (error: NodeJS.ErrnoException) => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      if (cancelPoll) clearInterval(cancelPoll);
      owned.settled();
      resolve({
        stdout: redactSecrets(stdout), stderr: redactSecrets(stderr), exitCode: null, signal: null,
        elapsedMilliseconds: now() - startedAt, firstOutputMilliseconds,
        failure: {
          kind: error.code === 'ENOENT' ? 'notInstalled' : 'spawnFailure',
          detail: error.code === 'ENOENT'
            ? `${options.executable} is not on this machine's PATH. Cernum drives the official CLI you installed and `
              + 'authenticated yourself; it does not install one, and it does not reach the service any other way.'
            : redactSecrets(error.message),
        },
      });
    });

    child.on('close', (code, signal) => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      if (cancelPoll) clearInterval(cancelPoll);
      owned.settled();
      const failure = outcome ?? (code === 0 ? undefined : {
        kind: 'exitFailure' as const,
        detail: `the tool exited with status ${code ?? 'unknown'}${signal ? ` after ${signal}` : ''}`,
      });
      resolve({
        stdout: redactSecrets(stdout), stderr: redactSecrets(stderr), exitCode: code, signal: signal as NodeJS.Signals | null,
        elapsedMilliseconds: now() - startedAt, firstOutputMilliseconds, failure,
      });
    });

    if (options.input !== undefined) {
      child.stdin?.on('error', () => { /* the tool closed stdin first; the close handler reports it */ });
      child.stdin?.end(options.input, 'utf8');
    } else {
      child.stdin?.end();
    }
  });
}

/**
 * Where an executable is, without running it.
 *
 * This is a PATH lookup and a stat, so it can be called from a status view: knowing whether a tool
 * is installed must not cost a provider request, an authentication check or a rate-limit slot.
 */
export function findExecutable(name: string, environment: NodeJS.ProcessEnv = process.env): string | undefined {
  const pathValue = environment.PATH ?? '';
  const separator = process.platform === 'win32' ? ';' : ':';
  const extensions = process.platform === 'win32' ? (environment.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const directory of pathValue.split(separator)) {
    if (directory.length === 0) continue;
    for (const extension of extensions) {
      const candidate = path.join(directory, name + extension);
      try {
        const stats = fs.statSync(candidate);
        if (stats.isFile() && (process.platform === 'win32' || (stats.mode & 0o111) !== 0)) return candidate;
      } catch { /* not here; try the next directory */ }
    }
  }
  return undefined;
}
