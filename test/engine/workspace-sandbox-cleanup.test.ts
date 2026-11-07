// SANDBOX CLEANUP (IO-2 P2, G-24301 C1). Every attempt root under the sandbox is removed in a `finally`,
// and a matrix sweeps stale `cernum-ws-*` attempt roots from its sandbox root before its first cell.
//
//   (a) the sandbox root is empty after a success, a failure, a thrown execution error, and an evidence
//       root that throws on write (which must not be finalized a second time);
//   (b) --preserve-failed still preserves a failed attempt;
//   (c) stale cernum-ws-* directories are swept; fresh ones and non-matching names are kept, and each
//       removal is reported;
//   (d) the sweep never leaves the sandbox root: a symlink inside it is not followed.
//
// FAKE DRIVERS ONLY. The model is a ScriptedWorkspaceAgent, every sealed command goes through an injected
// `runCommand` that starts no process, and the OS sandbox is injected rather than probed. Every directory
// this file makes is under os.tmpdir() and is removed in afterEach.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BROKEN_SUM_MEAN } from '../../src/engine/workspace-catalog';
import { ScriptedAttempt, ScriptedWorkspaceAgent, WorkspaceAgentDriver, WorkspaceAgentRequest } from '../../src/engine/workspace-agent';
import {
  STALE_WORKSPACE_SANDBOX_AGE_MILLISECONDS, StaleSandboxRemoval, WorkspaceExecutionError, WorkspaceRunOptions,
  attemptSucceeded, runWorkspaceCase, sweepStaleWorkspaceSandboxes,
} from '../../src/engine/workspace-execution';
import { CLIResult } from '../../src/engine/cli-process';
import { WorkspaceMatrixRequest, buildWorkspaceMatrixPlan, runWorkspaceMatrix } from '../../src/engine/workspace-matrix';
import { parseWorkspaceCellList } from '../../src/engine/workspace-cell-selection';
import { B, CHANGES_NOTHING, DISCOVERY, PACK, RUN_OPTIONS, request } from './workspace-continuation-harness';

const FIXTURE_ROOT = path.resolve(__dirname, '../../fixtures');

const temporaries: string[] = [];
afterEach(() => { for (const directory of temporaries.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
function temporary(prefix: string): string {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  temporaries.push(directory);
  return directory;
}

const CORRECT_STATS = `'use strict';

function sum(values) {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

function mean(values) {
  if (values.length === 0) throw new RangeError('the mean of an empty list is undefined');
  return sum(values) / values.length;
}

module.exports = { sum, mean };
`;
const FIXES_IT: ScriptedAttempt = { steps: [{ do: 'write', path: 'src/stats.js', contents: CORRECT_STATS }] };
const DOES_NOTHING: ScriptedAttempt = { steps: [{ do: 'say', text: 'I could not work out what to do.' }] };

/** A sealed command that never starts a process. Exits 0 after the change and 1 on the baseline probe. */
function fakeCommands(options: { verificationPasses: boolean; throwOnCall?: () => Error }): WorkspaceRunOptions['runCommand'] {
  return async (command) => {
    if (options.throwOnCall !== undefined) throw options.throwOnCall();
    const isProbe = command.workingDirectory !== undefined && command.workingDirectory.split(path.sep).includes('probe');
    const exitCode = !isProbe && options.verificationPasses ? 0 : 1;
    const result: CLIResult = { stdout: '', stderr: '', exitCode, signal: null, elapsedMilliseconds: 1 };
    return result;
  };
}

function caseOptions(sandboxRoot: string, attempts: ScriptedAttempt[], extra: Partial<WorkspaceRunOptions> = {}): WorkspaceRunOptions {
  return {
    case: BROKEN_SUM_MEAN,
    driver: new ScriptedWorkspaceAgent(attempts),
    fixtureRoot: FIXTURE_ROOT,
    sandboxRoot,
    executionSandbox: { kind: 'macosSeatbelt', detail: 'injected by workspace-sandbox-cleanup.test.ts' },
    runCommand: fakeCommands({ verificationPasses: true }),
    ...extra,
  };
}

/** Set a path's modification time to `ageMilliseconds` ago, on the wall clock the sweep reads. */
function age(target: string, ageMilliseconds: number): void {
  const when = new Date(Date.now() - ageMilliseconds);
  fs.lutimesSync(target, when, when);
}

const HOUR = 60 * 60 * 1000;

describe('(a) the attempt root is removed on every path', () => {
  it('after a success', async () => {
    const sandboxRoot = temporary('cernum-cleanup-sandbox-');
    const result = await runWorkspaceCase(caseOptions(sandboxRoot, [FIXES_IT]));
    expect(result.attemptsUsed).toBe(1);
    expect(attemptSucceeded(result.attempts[0])).toBe(true);
    expect(result.attempts[0].preservedAt).toBeUndefined();
    expect(fs.readdirSync(sandboxRoot)).toEqual([]);
  });

  it('after a failure (every attempt fails its verification)', async () => {
    const sandboxRoot = temporary('cernum-cleanup-sandbox-');
    const result = await runWorkspaceCase(caseOptions(sandboxRoot, [DOES_NOTHING, DOES_NOTHING], {
      runCommand: fakeCommands({ verificationPasses: false }),
    }));
    expect(result.attemptsUsed).toBe(BROKEN_SUM_MEAN.execution.maximumAttempts);
    expect(result.attempts.every((attempt) => !attemptSucceeded(attempt))).toBe(true);
    expect(result.attempts.every((attempt) => attempt.preservedAt === undefined)).toBe(true);
    expect(fs.readdirSync(sandboxRoot)).toEqual([]);
  });

  it('after an ordinary error inside the attempt (recorded as harnessThrew)', async () => {
    const sandboxRoot = temporary('cernum-cleanup-sandbox-');
    const result = await runWorkspaceCase(caseOptions(sandboxRoot, [FIXES_IT], {
      runCommand: fakeCommands({ verificationPasses: true, throwOnCall: () => new Error('fixture: the command runner broke') }),
    }));
    expect(result.attempts[0].harnessFault?.code).toBe('harnessThrew');
    expect(fs.readdirSync(sandboxRoot)).toEqual([]);
  });

  it('after a thrown WorkspaceExecutionError, which is rethrown unchanged', async () => {
    const sandboxRoot = temporary('cernum-cleanup-sandbox-');
    let calls = 0;
    const thrown = runWorkspaceCase(caseOptions(sandboxRoot, [FIXES_IT], {
      runCommand: fakeCommands({ verificationPasses: true, throwOnCall: () => {
        calls += 1;
        return new WorkspaceExecutionError('fixtureExecutionError', 'fixture: an impossible request mid-attempt');
      } }),
    }));
    await expect(thrown).rejects.toMatchObject({ name: 'WorkspaceExecutionError', code: 'fixtureExecutionError' });
    expect(calls).toBe(1);
    expect(fs.readdirSync(sandboxRoot)).toEqual([]);
  });

  it('after an evidence root that throws on write, without finalizing a second time', async () => {
    const sandboxRoot = temporary('cernum-cleanup-sandbox-');
    const holder = temporary('cernum-cleanup-evidence-');
    // A regular file where the evidence directory's parent should be: every mkdir under it fails with ENOTDIR.
    const blocker = path.join(holder, 'not-a-directory');
    fs.writeFileSync(blocker, 'a file, not a directory\n');
    const evidenceRoot = path.join(blocker, 'evidence');

    let error: unknown;
    try {
      await runWorkspaceCase(caseOptions(sandboxRoot, [FIXES_IT], { evidenceRoot }));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(WorkspaceExecutionError);
    expect((error as WorkspaceExecutionError).code).toBe('evidenceWriteFailed');
    // The ORIGINAL failure is what is reported, not a second one from a recursive finalize.
    expect((error as Error).message).toMatch(/ENOTDIR/);
    expect(fs.readdirSync(sandboxRoot)).toEqual([]);
    expect(fs.readdirSync(holder)).toEqual(['not-a-directory']);
  });

  it('after an evidence root that throws on write for a failed attempt with a harness fault', async () => {
    const sandboxRoot = temporary('cernum-cleanup-sandbox-');
    const holder = temporary('cernum-cleanup-evidence-');
    const blocker = path.join(holder, 'not-a-directory');
    fs.writeFileSync(blocker, 'a file\n');
    await expect(runWorkspaceCase(caseOptions(sandboxRoot, [FIXES_IT], {
      evidenceRoot: path.join(blocker, 'evidence'),
      runCommand: fakeCommands({ verificationPasses: true, throwOnCall: () => new Error('fixture: broke') }),
    }))).rejects.toMatchObject({ code: 'evidenceWriteFailed' });
    expect(fs.readdirSync(sandboxRoot)).toEqual([]);
  });
});

describe('(b) --preserve-failed still preserves', () => {
  it('keeps a failed attempt\'s tree and says where, and still removes a passing one', async () => {
    const sandboxRoot = temporary('cernum-cleanup-sandbox-');
    const failing = await runWorkspaceCase(caseOptions(sandboxRoot, [DOES_NOTHING, DOES_NOTHING], {
      runCommand: fakeCommands({ verificationPasses: false }),
      preserveFailedWorkspaces: true,
    }));
    const preserved = failing.attempts.map((attempt) => attempt.preservedAt);
    expect(preserved.every((entry) => entry !== undefined)).toBe(true);
    for (const directory of preserved) {
      expect(path.dirname(directory!)).toBe(fs.realpathSync(sandboxRoot));
      expect(fs.existsSync(path.join(directory!, 'work', 'src', 'stats.js'))).toBe(true);
    }
    expect(fs.readdirSync(sandboxRoot).sort()).toEqual(preserved.map((entry) => path.basename(entry!)).sort());

    const passingRoot = temporary('cernum-cleanup-sandbox-');
    const passing = await runWorkspaceCase(caseOptions(passingRoot, [FIXES_IT], { preserveFailedWorkspaces: true }));
    expect(passing.attempts[0].preservedAt).toBeUndefined();
    expect(fs.readdirSync(passingRoot)).toEqual([]);
  });

  it('keeps a failed attempt\'s tree when its evidence write then fails', async () => {
    const sandboxRoot = temporary('cernum-cleanup-sandbox-');
    const holder = temporary('cernum-cleanup-evidence-');
    const blocker = path.join(holder, 'not-a-directory');
    fs.writeFileSync(blocker, 'a file\n');
    await expect(runWorkspaceCase(caseOptions(sandboxRoot, [DOES_NOTHING], {
      evidenceRoot: path.join(blocker, 'evidence'),
      runCommand: fakeCommands({ verificationPasses: false }),
      preserveFailedWorkspaces: true,
    }))).rejects.toMatchObject({ code: 'evidenceWriteFailed' });
    const left = fs.readdirSync(sandboxRoot);
    expect(left).toHaveLength(1);
    expect(left[0].startsWith(`cernum-ws-${BROKEN_SUM_MEAN.id}-0-`)).toBe(true);
  });
});

describe('(c) the stale-sandbox sweep', () => {
  it('defaults to six hours', () => {
    expect(STALE_WORKSPACE_SANDBOX_AGE_MILLISECONDS).toBe(6 * HOUR);
  });

  it('removes stale cernum-ws-* directories and keeps fresh ones and non-matching names', () => {
    const sandboxRoot = temporary('cernum-sweep-sandbox-');
    const stale = ['cernum-ws-ws.case-0-aaaaaa', 'cernum-ws-ws.case-1-bbbbbb'];
    for (const name of stale) {
      fs.mkdirSync(path.join(sandboxRoot, name, 'work', 'src'), { recursive: true });
      fs.writeFileSync(path.join(sandboxRoot, name, 'work', 'src', 'file.js'), 'x\n');
      age(path.join(sandboxRoot, name), 7 * HOUR);
    }
    const fresh = 'cernum-ws-ws.case-0-cccccc';
    fs.mkdirSync(path.join(sandboxRoot, fresh));
    age(path.join(sandboxRoot, fresh), 5 * HOUR);
    const unrelatedDirectory = 'someone-else-0-dddddd';
    fs.mkdirSync(path.join(sandboxRoot, unrelatedDirectory));
    age(path.join(sandboxRoot, unrelatedDirectory), 30 * HOUR);
    const staleFile = 'cernum-ws-not-a-directory';
    fs.writeFileSync(path.join(sandboxRoot, staleFile), 'a file\n');
    age(path.join(sandboxRoot, staleFile), 30 * HOUR);

    const reported: StaleSandboxRemoval[] = [];
    const sweep = sweepStaleWorkspaceSandboxes(sandboxRoot, { onRemoved: (removal) => reported.push(removal) });

    expect(sweep.removed.map((entry) => path.basename(entry.path)).sort()).toEqual(stale);
    expect(reported).toEqual(sweep.removed);
    for (const removal of reported) {
      expect(path.dirname(removal.path)).toBe(sandboxRoot);
      expect(removal.ageMilliseconds).toBeGreaterThan(6 * HOUR);
    }
    expect(sweep.keptYounger.map((entry) => path.basename(entry))).toEqual([fresh]);
    expect(sweep.failures).toEqual([]);
    expect(fs.readdirSync(sandboxRoot).sort()).toEqual([fresh, staleFile, unrelatedDirectory].sort());
  });

  it('honours a stated age, and does nothing for a root that does not exist', () => {
    const sandboxRoot = temporary('cernum-sweep-sandbox-');
    fs.mkdirSync(path.join(sandboxRoot, 'cernum-ws-x-0-eeeeee'));
    age(path.join(sandboxRoot, 'cernum-ws-x-0-eeeeee'), 2 * HOUR);
    expect(sweepStaleWorkspaceSandboxes(sandboxRoot).removed).toEqual([]);
    expect(sweepStaleWorkspaceSandboxes(sandboxRoot, { maximumAgeMilliseconds: HOUR }).removed).toHaveLength(1);
    expect(fs.readdirSync(sandboxRoot)).toEqual([]);

    const missing = path.join(sandboxRoot, 'never-made');
    expect(sweepStaleWorkspaceSandboxes(missing).removed).toEqual([]);
    expect(fs.existsSync(missing)).toBe(false);
  });

  it('runs at matrix start and reports each removal through the run\'s callbacks', async () => {
    const campaignRoot = temporary('cernum-sweep-campaign-');
    const sandboxRoot = temporary('cernum-sweep-sandbox-');
    const stale = path.join(sandboxRoot, 'cernum-ws-left-by-a-killed-run-0-ffffff');
    fs.mkdirSync(path.join(stale, 'work'), { recursive: true });
    age(stale, 8 * HOUR);
    const fresh = path.join(sandboxRoot, 'cernum-ws-another-matrix-0-gggggg');
    fs.mkdirSync(fresh);
    const unrelated = path.join(sandboxRoot, 'notes');
    fs.mkdirSync(unrelated);
    age(unrelated, 80 * HOUR);

    const order: string[] = [];
    const driverFactory: NonNullable<WorkspaceMatrixRequest['driverFactory']> = (binding) => {
      if (binding.provider !== 'claudeCLI') return undefined;
      const driver: WorkspaceAgentDriver = {
        driverID: 'driver.scripted.claude',
        provider: 'claudeCLI',
        capabilities: new ScriptedWorkspaceAgent([]).capabilities,
        async run(agentRequest: WorkspaceAgentRequest) {
          order.push('cell');
          const result = await new ScriptedWorkspaceAgent([CHANGES_NOTHING]).run(agentRequest);
          return { ...result, reportedModelID: binding.requestedModelID };
        },
      };
      return driver;
    };
    const matrix = request({
      campaignRoot, sandboxRoot, runLabel: 'sweep-test', provider: 'claudeCLI', effort: 'none',
      modelIDs: ['claude-haiku-4-5'], driverFactory, discovery: DISCOVERY,
      cellSelection: { mode: 'explicit', selectors: parseWorkspaceCellList(`${B}@1`, PACK.caseIDs) },
    });
    const plan = buildWorkspaceMatrixPlan(matrix);
    expect(plan.runnableRunCount).toBe(1);

    const removed: StaleSandboxRemoval[] = [];
    const result = await runWorkspaceMatrix(plan, matrix, {
      ...RUN_OPTIONS,
      runCommand: fakeCommands({ verificationPasses: false }),
      onStaleSandboxRemoved: (removal) => { order.push('removed'); removed.push(removal); },
      onStaleSandboxSweep: () => order.push('sweep'),
    });
    expect(result.executedRunCount).toBe(1);
    expect(order).toEqual(['removed', 'sweep', 'cell']);
    expect(removed.map((entry) => entry.path)).toEqual([stale]);
    // The fresh one and the unrelated one are kept, and the cell's own attempt root is gone.
    expect(fs.readdirSync(sandboxRoot).sort()).toEqual([path.basename(fresh), 'notes'].sort());
  });
});

describe('(d) the sweep never leaves the sandbox root', () => {
  it('does not follow a symlink, whether the link itself or one inside a stale directory', () => {
    const sandboxRoot = temporary('cernum-sweep-sandbox-');
    const outside = temporary('cernum-sweep-outside-');
    const precious = path.join(outside, 'cernum-ws-precious-0-hhhhhh');
    fs.mkdirSync(precious);
    fs.writeFileSync(path.join(precious, 'keep.txt'), 'not the sweep\'s to delete\n');
    age(precious, 50 * HOUR);
    age(outside, 50 * HOUR);

    // A stale-looking symlink straight to a directory outside the root.
    const link = path.join(sandboxRoot, 'cernum-ws-link-0-iiiiii');
    fs.symlinkSync(precious, link, 'dir');
    age(link, 50 * HOUR);
    // A stale directory that contains a symlink pointing outside the root.
    const staleWithLink = path.join(sandboxRoot, 'cernum-ws-holder-0-jjjjjj');
    fs.mkdirSync(staleWithLink);
    fs.symlinkSync(outside, path.join(staleWithLink, 'escape'), 'dir');
    age(staleWithLink, 50 * HOUR);

    const sweep = sweepStaleWorkspaceSandboxes(sandboxRoot);

    expect(sweep.removed.map((entry) => entry.path)).toEqual([staleWithLink]);
    expect(sweep.ignored).toContain(link);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(staleWithLink)).toBe(false);
    // Everything outside the root is exactly as it was.
    expect(fs.readFileSync(path.join(precious, 'keep.txt'), 'utf8')).toBe('not the sweep\'s to delete\n');
    expect(fs.readdirSync(outside)).toEqual(['cernum-ws-precious-0-hhhhhh']);
    for (const removal of sweep.removed) expect(path.dirname(removal.path)).toBe(fs.realpathSync(sandboxRoot));
  });

  it('a sandbox root reached through a symlink is swept at its real path and nothing above it is touched', () => {
    const parent = temporary('cernum-sweep-parent-');
    const realRoot = path.join(parent, 'real-root');
    fs.mkdirSync(realRoot);
    const sibling = path.join(parent, 'cernum-ws-sibling-0-kkkkkk');
    fs.mkdirSync(sibling);
    age(sibling, 50 * HOUR);
    const inside = path.join(realRoot, 'cernum-ws-inside-0-llllll');
    fs.mkdirSync(inside);
    age(inside, 50 * HOUR);
    const linkedRoot = path.join(parent, 'linked-root');
    fs.symlinkSync(realRoot, linkedRoot, 'dir');

    const sweep = sweepStaleWorkspaceSandboxes(linkedRoot);
    expect(sweep.sandboxRoot).toBe(realRoot);
    expect(sweep.removed.map((entry) => entry.path)).toEqual([inside]);
    expect(fs.existsSync(sibling)).toBe(true);
    expect(fs.lstatSync(linkedRoot).isSymbolicLink()).toBe(true);
  });
});
