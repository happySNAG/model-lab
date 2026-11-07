// PROCESS-GROUP TERMINATION (IO-2 P1, G-24301 C0).
//
// `runCLI` starts every command as the leader of its own process group. These tests pin that the
// GROUP — not just the leader — is stopped: on a deadline, on cancel, and when the leader exits
// leaving a member behind that ignores SIGTERM and still holds stdout. Before this pass the last case
// never settled at all, because `close` waits for every holder of the pipe.
//
// FIXTURE SHELL CHILDREN ONLY. No provider, no model, no external drive. Each fixture prints its own
// pid (`leader <pid>`) and its grandchild's (`grandchild <pid>`) so the test can probe them with
// process.kill(pid, 0). `trap '' TERM` before `sleep 60 &` makes the grandchild IGNORE SIGTERM, since an
// ignored disposition survives fork and exec. Every pid seen is SIGKILLed in afterEach, whatever
// happened, and every temporary directory is removed.

import { afterEach, describe, expect, it } from 'vitest';
import {
  installMatrixSignalHandlers, liveCLIProcessCount, runCLI, terminateAllCLIProcesses,
} from '../../src/engine/cli-process';
import { buildWorkspaceMatrixPlan, runWorkspaceMatrix, WorkspaceMatrixRequest } from '../../src/engine/workspace-matrix';
import { ScriptedWorkspaceAgent, WorkspaceAgentDriver, WorkspaceAgentRequest } from '../../src/engine/workspace-agent';
import { CHANGES_NOTHING, DISCOVERY, RUN_OPTIONS, request, temporary } from './workspace-continuation-harness';

const seenLeaders = new Set<number>();
const seenGrandchildren = new Set<number>();

afterEach(() => {
  // ALWAYS REAPED. The group first (it outlives its leader while any member lives), then each pid.
  for (const leader of seenLeaders) { try { process.kill(-leader, 'SIGKILL'); } catch { /* gone */ } }
  for (const pid of seenGrandchildren) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  seenLeaders.clear();
  seenGrandchildren.clear();
  terminateAllCLIProcesses(0);
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** The pid is gone: process.kill(pid, 0) throws ESRCH. Polled briefly, since init reaps an orphan asynchronously. */
async function expectGone(pid: number, what: string): Promise<void> {
  const until = Date.now() + 2_000;
  while (isAlive(pid) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 25));
  let code: string | undefined;
  try { process.kill(pid, 0); } catch (error) { code = (error as NodeJS.ErrnoException).code; }
  expect(code, `${what} ${pid} is gone`).toBe('ESRCH');
}

/** Reads `leader <pid>` and `grandchild <pid>` off stdout as it arrives, and notes whether each was alive then. */
function pidWatcher() {
  let buffer = '';
  const state: { leader?: number; grandchild?: number; grandchildAliveWhenSeen?: boolean } = {};
  const onChunk = (chunk: string): void => {
    buffer += chunk;
    const leader = /leader (\d+)/.exec(buffer);
    if (leader && state.leader === undefined) { state.leader = Number(leader[1]); seenLeaders.add(state.leader); }
    const grandchild = /grandchild (\d+)/.exec(buffer);
    if (grandchild && state.grandchild === undefined) {
      state.grandchild = Number(grandchild[1]);
      seenGrandchildren.add(state.grandchild);
      state.grandchildAliveWhenSeen = isAlive(state.grandchild);
    }
  };
  return { state, onChunk };
}

/** A TERM-ignoring grandchild holding stdout, then `tail` for the leader. */
const leaderScript = (tail: string): string[] =>
  ['-c', `echo leader $$; trap '' TERM; sleep 60 & echo grandchild $!; ${tail}`];

describe('runCLI stops the whole process group', () => {
  it('(a) a leader that exits 0 leaving a TERM-ignoring grandchild on stdout: settles by the deadline, grandchild gone', async () => {
    const watcher = pidWatcher();
    const timeout = 8_000;
    const started = Date.now();
    const result = await runCLI({
      executable: '/bin/sh', args: leaderScript('exit 0'), timeoutMilliseconds: timeout, graceMilliseconds: 300,
      onChunk: watcher.onChunk,
    });
    const elapsed = Date.now() - started;
    expect(watcher.state.grandchild).toBeDefined();
    expect(watcher.state.grandchildAliveWhenSeen).toBe(true);
    expect(elapsed, `settled in ${elapsed} ms`).toBeLessThan(timeout);
    expect(result.exitCode).toBe(0);
    expect(result.failure).toBeUndefined();
    expect(result.stdout).toMatch(/grandchild \d+/);
    await expectGone(watcher.state.grandchild!, 'the grandchild');
    expect(liveCLIProcessCount()).toBe(0);
  }, 20_000);

  it('(b) a deadline while the leader lives: the group is stopped, the run settles, grandchild gone', async () => {
    const watcher = pidWatcher();
    const timeout = 1_500;
    const grace = 300;
    const started = Date.now();
    const result = await runCLI({
      executable: '/bin/sh', args: leaderScript('while :; do sleep 0.2; done'), timeoutMilliseconds: timeout,
      graceMilliseconds: grace, onChunk: watcher.onChunk,
    });
    const elapsed = Date.now() - started;
    expect(watcher.state.grandchildAliveWhenSeen).toBe(true);
    expect(result.failure?.kind).toBe('timeout');
    // The leader ignores SIGTERM too (it set the trap), so it ends by the group SIGKILL.
    expect(result.signal).toBe('SIGKILL');
    expect(elapsed, `settled in ${elapsed} ms`).toBeGreaterThanOrEqual(timeout - 50);
    expect(elapsed, `settled in ${elapsed} ms`).toBeLessThan(timeout + grace + 1_500);
    await expectGone(watcher.state.leader!, 'the leader');
    await expectGone(watcher.state.grandchild!, 'the grandchild');
    expect(liveCLIProcessCount()).toBe(0);
  }, 20_000);

  it('(c) cancel stops the whole group', async () => {
    const watcher = pidWatcher();
    const result = await runCLI({
      executable: '/bin/sh', args: leaderScript('while :; do sleep 0.2; done'), timeoutMilliseconds: 15_000,
      graceMilliseconds: 300, onChunk: watcher.onChunk,
      // Cancel once both pids are known, so the grandchild certainly exists when the group is stopped.
      shouldCancel: () => watcher.state.grandchild !== undefined,
    });
    expect(watcher.state.grandchildAliveWhenSeen).toBe(true);
    expect(result.failure?.kind).toBe('cancelled');
    await expectGone(watcher.state.leader!, 'the leader');
    await expectGone(watcher.state.grandchild!, 'the grandchild');
    expect(liveCLIProcessCount()).toBe(0);
  }, 20_000);

  it('(e) a well-behaved child is unchanged: exit code, stdout and timing', async () => {
    const ok = await runCLI({ executable: '/bin/sh', args: ['-c', 'echo hello'], timeoutMilliseconds: 10_000 });
    expect(ok.exitCode).toBe(0);
    expect(ok.signal).toBeNull();
    expect(ok.stdout).toBe('hello\n');
    expect(ok.failure).toBeUndefined();
    // Settled on `close`, not on the post-exit bound (default grace 2 s plus the drain).
    expect(ok.elapsedMilliseconds).toBeLessThan(1_500);

    const failing = await runCLI({ executable: '/bin/sh', args: ['-c', 'echo out; echo err >&2; exit 3'], timeoutMilliseconds: 10_000 });
    expect(failing.exitCode).toBe(3);
    expect(failing.stdout).toBe('out\n');
    expect(failing.stderr).toBe('err\n');
    expect(failing.failure?.kind).toBe('exitFailure');
    expect(failing.failure?.detail).toBe('the tool exited with status 3');

    const slow = await runCLI({ executable: '/bin/sh', args: ['-c', 'sleep 0.3; echo late'], timeoutMilliseconds: 10_000 });
    expect(slow.exitCode).toBe(0);
    expect(slow.stdout).toBe('late\n');
    expect(slow.firstOutputMilliseconds).toBeGreaterThanOrEqual(200);
    expect(slow.elapsedMilliseconds).toBeGreaterThanOrEqual(slow.firstOutputMilliseconds!);
    expect(slow.elapsedMilliseconds).toBeLessThan(1_800);

    // A child that runs to its own end within the deadline is not stopped.
    const input = await runCLI({ executable: '/bin/cat', args: [], input: 'piped', timeoutMilliseconds: 10_000 });
    expect(input.stdout).toBe('piped');
    expect(input.exitCode).toBe(0);
    expect(liveCLIProcessCount()).toBe(0);
  }, 20_000);
});

describe('a cancelled matrix leaves no live child', () => {
  it('(d) an injected shouldCancel, a fake driver running a fixture group: no child survives, later cells are cancelled', async () => {
    const watcher = pidWatcher();
    let cancel = false;
    const driverFactory: NonNullable<WorkspaceMatrixRequest['driverFactory']> = (binding) => {
      if (binding.provider !== 'claudeCLI') return undefined;
      const driver: WorkspaceAgentDriver = {
        driverID: 'driver.scripted.claude',
        provider: 'claudeCLI',
        capabilities: new ScriptedWorkspaceAgent([]).capabilities,
        async run(agentRequest: WorkspaceAgentRequest) {
          // The "agent" is a fixture group with a TERM-ignoring grandchild. The matrix is cancelled as
          // soon as the grandchild exists, exactly as a SIGINT handler would.
          const cli = await runCLI({
            executable: '/bin/sh', args: leaderScript('while :; do sleep 0.2; done'), timeoutMilliseconds: 15_000,
            graceMilliseconds: 300, shouldCancel: agentRequest.shouldCancel,
            onChunk: (chunk) => {
              watcher.onChunk(chunk);
              if (watcher.state.grandchild !== undefined) cancel = true;
            },
          });
          expect(cli.failure?.kind).toBe('cancelled');
          // The scripted agent sees the same cancel and returns the run as cancelled.
          const result = await new ScriptedWorkspaceAgent([CHANGES_NOTHING]).run(agentRequest);
          return { ...result, reportedModelID: binding.requestedModelID };
        },
      };
      return driver;
    };
    const matrix = request({
      campaignRoot: temporary('cernum-pgroup-campaign-'), runLabel: 'process-group-test', provider: 'claudeCLI',
      effort: 'none', modelIDs: ['claude-haiku-4-5'], driverFactory, discovery: DISCOVERY,
    });
    const plan = buildWorkspaceMatrixPlan(matrix);
    expect(plan.runnableRunCount).toBeGreaterThan(1);
    const result = await runWorkspaceMatrix(plan, matrix, { ...RUN_OPTIONS, shouldCancel: () => cancel });

    expect(watcher.state.grandchildAliveWhenSeen).toBe(true);
    await expectGone(watcher.state.leader!, 'the leader');
    await expectGone(watcher.state.grandchild!, 'the grandchild');
    expect(liveCLIProcessCount()).toBe(0);
    // Only the first cell started; every later one is recorded as cancelled, not run.
    expect(result.completed.length + result.skipped.filter((entry) => entry.disposition === 'harnessFault').length).toBe(1);
    const cancelled = result.skipped.filter((entry) => entry.disposition === 'cancelled');
    expect(cancelled.length).toBe(plan.cells.length - 1);
    for (const entry of cancelled) expect(entry.reasons).toEqual(['the matrix was cancelled before this run started']);
  }, 30_000);

  it('(d) the workspace-benchmark signal handler cancels the matrix, stops every group, and is removed afterwards', async () => {
    const before = { int: process.listenerCount('SIGINT'), term: process.listenerCount('SIGTERM') };
    const handlers = installMatrixSignalHandlers(undefined, 300);
    try {
      expect(process.listenerCount('SIGINT')).toBe(before.int + 1);
      expect(process.listenerCount('SIGTERM')).toBe(before.term + 1);
      expect(handlers.shouldCancel()).toBe(false);

      const watcher = pidWatcher();
      const running = runCLI({
        executable: '/bin/sh', args: leaderScript('while :; do sleep 0.2; done'), timeoutMilliseconds: 15_000,
        graceMilliseconds: 300, onChunk: watcher.onChunk,
      });
      const until = Date.now() + 5_000;
      while (watcher.state.grandchild === undefined && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 25));
      expect(watcher.state.grandchildAliveWhenSeen).toBe(true);

      // What SIGINT runs, called directly so the test runner itself is not signalled.
      handlers.interrupt();
      expect(handlers.shouldCancel()).toBe(true);
      const result = await running;
      expect(result.signal === 'SIGTERM' || result.signal === 'SIGKILL').toBe(true);
      await expectGone(watcher.state.leader!, 'the leader');
      await expectGone(watcher.state.grandchild!, 'the grandchild');
      expect(liveCLIProcessCount()).toBe(0);
    } finally {
      handlers.dispose();
      handlers.dispose();
    }
    expect(process.listenerCount('SIGINT')).toBe(before.int);
    expect(process.listenerCount('SIGTERM')).toBe(before.term);
  }, 20_000);
});
