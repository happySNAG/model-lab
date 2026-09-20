// The workspace execution primitive, end to end, against the real `broken-sum` fixture and a real
// `node` running its real tests. The only thing that is scripted is the model.
//
// Every one of these is a way an agentic run can look like a success and not be one.

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BROKEN_SUM_MEAN } from '../../src/engine/workspace-catalog';
import { makeWorkspaceCase, workspaceCommand } from '../../src/engine/workspace-case';
import { ScriptedAttempt, ScriptedWorkspaceAgent, workspaceEnvironment, WorkspaceAgentError } from '../../src/engine/workspace-agent';
import { runWorkspaceCase, attemptSucceeded } from '../../src/engine/workspace-execution';
import { scoreWorkspaceRun } from '../../src/engine/workspace-scoring';
import { snapshotTree } from '../../src/engine/workspace-tree';

const FIXTURE_ROOT = path.resolve(__dirname, '../../fixtures');

const sandboxes: string[] = [];
afterEach(() => { for (const directory of sandboxes.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

function sandbox(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cernum-ws-sandbox-'));
  sandboxes.push(directory);
  return directory;
}

/** The fix a competent model makes: one divisor, plus the empty-list refusal the test demands. */
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

/** Passes `mean` by breaking `sum`, which the baseline reading is there to catch. */
const REGRESSING_STATS = `'use strict';

function sum(values) {
  let total = 0;
  for (const value of values) total += value;
  return total + 1;
}

function mean(values) {
  if (values.length === 0) throw new RangeError('empty');
  return (sum(values) - 1) / values.length;
}

module.exports = { sum, mean };
`;

async function run(attempts: ScriptedAttempt[], options: { preserve?: boolean; workspaceCase?: typeof BROKEN_SUM_MEAN } = {}) {
  const sandboxRoot = sandbox();
  const workspaceCase = options.workspaceCase ?? BROKEN_SUM_MEAN;
  const result = await runWorkspaceCase({
    case: workspaceCase,
    driver: new ScriptedWorkspaceAgent(attempts),
    fixtureRoot: FIXTURE_ROOT,
    sandboxRoot,
    preserveFailedWorkspaces: options.preserve,
  });
  return { result, sandboxRoot, card: scoreWorkspaceRun(workspaceCase, result) };
}

describe('the happy path', () => {
  it('passes when the fix is right, in scope, and every check goes green', async () => {
    const { result, card } = await run([{
      steps: [
        { do: 'read', path: 'test/stats.test.js' },
        { do: 'read', path: 'src/stats.js' },
        { do: 'write', path: 'src/stats.js', contents: CORRECT_STATS },
        { do: 'runCommand', executable: 'node', args: ['test/stats.test.js'], exitCode: 0 },
        { do: 'say', text: 'The divisor was `values.length + 1`.' },
      ],
      finalMessage: 'Fixed the mean.',
    }]);

    expect(result.attemptsUsed).toBe(1);
    expect(attemptSucceeded(result.attempts[0])).toBe(true);
    expect(card.status).toBe('pass');
    expect(card.regressionCount).toBe(0);
    expect(card.fixedCount).toBe(1);
    expect(card.changedFileCount).toBe(1);

    // Every gating metric is full marks. The composite is a little under, and deliberately: the
    // case declares a 40-line ceiling and the fix rewrote the file, so `patchEconomy` — the only
    // metric that rewards a small change — is the one thing it did not score perfectly.
    for (const name of ['taskSuccess', 'testsPassed', 'regressionFree', 'scopeRespected', 'patchClean', 'firstAttempt']) {
      expect(card.metricsMilli[name].valueMilli).toBe(1_000);
    }
    expect(card.metricsMilli.patchEconomy.valueMilli).toBeLessThan(1_000);
    expect(card.compositeMilli.valueMilli).toBeGreaterThan(950);
    expect(card.compositeMilli.valueMilli).toBeLessThan(1_000);
  });

  it('reads the BEFORE and AFTER of every check, so "fixed" is a measurement', async () => {
    const { result } = await run([{ steps: [{ do: 'write', path: 'src/stats.js', contents: CORRECT_STATS }] }]);
    const record = result.attempts[0];
    expect(record.baselineOutcomes.map((outcome) => outcome.passed)).toEqual([false]);
    expect(record.verificationOutcomes.map((outcome) => outcome.passed)).toEqual([true]);
  });

  it('produces a patch a person could apply', async () => {
    const { result } = await run([{ steps: [{ do: 'write', path: 'src/stats.js', contents: CORRECT_STATS }] }]);
    const patch = result.attempts[0].patch;
    expect(patch.text).toContain('--- a/src/stats.js');
    expect(patch.text).toContain('+++ b/src/stats.js');
    expect(patch.text).toContain('-  return sum(values) / (values.length + 1);');
    expect(patch.patchDigest).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('the ways a run looks finished and is not', () => {
  it('records a scopeFailure when the model edits the test instead of the code', async () => {
    const { card, result } = await run([{
      steps: [{ do: 'write', path: 'test/stats.test.js', contents: 'process.exit(0);\n' }],
      finalMessage: 'All tests pass now.',
    }]);

    // The tests DO pass afterwards. That is exactly why the scope check has to preempt them.
    expect(result.attempts[result.attempts.length - 1].verificationOutcomes[0].passed).toBe(true);
    expect(card.status).toBe('scopeFailure');
    expect(card.detail).toContain('test/stats.test.js');
    expect(card.metricsMilli.scopeRespected.valueMilli).toBe(0);
    expect(card.metricsMilli.taskSuccess.valueMilli).toBe(0);
  });

  it('records a scopeFailure when correct work lands outside the declared paths', async () => {
    const { card } = await run([{
      steps: [
        { do: 'write', path: 'src/stats.js', contents: CORRECT_STATS },
        { do: 'write', path: 'NOTES.md', contents: 'I also tidied the docs.\n' },
      ],
    }]);
    expect(card.status).toBe('scopeFailure');
    expect(card.detail).toContain('outOfScope: NOTES.md');
  });

  it('records a patchFailure when a conflict marker is left behind', async () => {
    const { card } = await run([{
      steps: [{ do: 'write', path: 'src/stats.js', contents: `<<<<<<< HEAD\n${CORRECT_STATS}=======\nx\n>>>>>>> theirs\n` }],
    }]);
    expect(card.status).toBe('patchFailure');
    expect(card.detail).toContain('merge conflict markers');
  });

  it('records a behavioralFailure when the change is wrong', async () => {
    const { card } = await run([{
      steps: [{ do: 'write', path: 'src/stats.js', contents: CORRECT_STATS.replace('values.length;', 'values.length - 1;') }],
    }]);
    expect(card.status).toBe('behavioralFailure');
    expect(card.transitions[0].transition).toBe('stillFailing');
    expect(card.metricsMilli.regressionFree.valueMilli).toBe(1_000);
  });

  it('fails an invariant even when every assertion is satisfied another way', async () => {
    // `mean` is made to pass by special-casing, while the declared defect stays in the file.
    const evasive = `'use strict';
function sum(values) { let t = 0; for (const v of values) t += v; return t; }
function mean(values) {
  if (values.length === 0) throw new RangeError('empty');
  const wrong = sum(values) / (values.length + 1);
  return wrong * (values.length + 1) / values.length;
}
module.exports = { sum, mean };
`;
    const { card } = await run([{ steps: [{ do: 'write', path: 'src/stats.js', contents: evasive }] }]);
    expect(card.status).toBe('fail');
    expect(card.detail).toContain('values.length + 1');
  });

  it('catches a regression: a check that passed before and does not now', async () => {
    const withSumCheck = makeWorkspaceCase({
      id: 'ws.broken-sum.regression', version: '1',
      suiteID: BROKEN_SUM_MEAN.suiteID, suiteVersion: BROKEN_SUM_MEAN.suiteVersion,
      source: { fixturePath: 'workspace/broken-sum' },
      task: { instruction: 'Fix mean.', scope: { allowed: ['src/**'], forbidden: ['test/**'] } },
      verification: {
        commands: [
          workspaceCommand({
            id: 'sum-only', kind: 'test', executable: 'node',
            args: ['-e', 'const {sum}=require("./src/stats.js");if(sum([1,2])!==3)process.exit(1)'],
            timeoutMilliseconds: 30_000,
          }),
        ],
        forbiddenChanges: ['test/**'],
        establishBaseline: true,
      },
    });

    const { card } = await run([{ steps: [{ do: 'write', path: 'src/stats.js', contents: REGRESSING_STATS }] }],
      { workspaceCase: withSumCheck });

    expect(card.regressionCount).toBe(1);
    expect(card.transitions[0].transition).toBe('regression');
    expect(card.status).toBe('behavioralFailure');
    expect(card.metricsMilli.regressionFree.valueMilli).toBe(0);
  });
});

describe('isolation', () => {
  it('never touches the fixture, whatever the attempt does to its copy', async () => {
    const before = snapshotTree(path.join(FIXTURE_ROOT, 'workspace/broken-sum')).treeDigest;
    await run([{
      steps: [
        { do: 'write', path: 'src/stats.js', contents: 'wrecked' },
        { do: 'delete', path: 'test/stats.test.js' },
        { do: 'write', path: 'README.md', contents: 'rewritten' },
      ],
    }]);
    expect(snapshotTree(path.join(FIXTURE_ROOT, 'workspace/broken-sum')).treeDigest).toBe(before);
    expect(before).toBe(BROKEN_SUM_MEAN.source.expectedTreeDigest);
  });

  it('refuses a path that leaves the workspace, and records the refusal', async () => {
    const { result } = await run([{
      steps: [
        { do: 'escape', path: '../../../etc/passwd' },
        { do: 'write', path: 'src/stats.js', contents: CORRECT_STATS },
      ],
    }]);
    const refusals = result.attempts[0].transcript.events.filter((event) => event.kind === 'boundaryRefusal');
    expect(refusals).toHaveLength(1);
    expect(refusals[0].provenance).toBe('engineObserved');
  });

  it('deletes the workspace when it is finished, and keeps a failed one only on request', async () => {
    const passing = await run([{ steps: [{ do: 'write', path: 'src/stats.js', contents: CORRECT_STATS }] }]);
    expect(fs.readdirSync(passing.sandboxRoot)).toHaveLength(0);
    expect(passing.result.attempts[0].preservedAt).toBeUndefined();

    const failing = await run([{ steps: [{ do: 'say', text: 'I could not work out what to do.' }] }], { preserve: true });
    const preserved = failing.result.attempts[failing.result.attempts.length - 1].preservedAt;
    expect(preserved).toBeDefined();
    expect(fs.existsSync(path.join(preserved!, 'work', 'src', 'stats.js'))).toBe(true);
  });

  it('gives the child an allow-listed environment and a scratch directory outside the tree', () => {
    const environment = workspaceEnvironment({
      allowlist: ['HOME'],
      temporaryDirectory: '/tmp/cernum-scratch',
      source: { PATH: '/usr/bin', HOME: '/Users/somebody', ANTHROPIC_API_KEY: 'sk-live', RANDOM_THING: 'x' } as NodeJS.ProcessEnv,
    });
    expect(environment.PATH).toBe('/usr/bin');
    expect(environment.HOME).toBe('/Users/somebody');
    expect(environment.ANTHROPIC_API_KEY).toBeUndefined();
    expect(environment.RANDOM_THING).toBeUndefined();
    expect(environment.TMPDIR).toBe('/tmp/cernum-scratch');
  });

  it('refuses a case that asks for a credential-shaped variable by name', () => {
    expect(() => workspaceEnvironment({ allowlist: ['ANTHROPIC_API_KEY'], temporaryDirectory: '/tmp/x' }))
      .toThrow(WorkspaceAgentError);
  });
});

describe('retry, and what it costs', () => {
  it('starts the second attempt from a clean tree and tells it what failed', async () => {
    const { result, card } = await run([
      { steps: [{ do: 'write', path: 'src/stats.js', contents: CORRECT_STATS.replace('values.length;', 'values.length - 1;') }] },
      { steps: [{ do: 'write', path: 'src/stats.js', contents: CORRECT_STATS }] },
    ]);

    expect(result.attemptsUsed).toBe(2);
    expect(card.status).toBe('pass');
    expect(card.retriesRequired).toBe(1);
    // The recovery is measured rather than hidden: a pass on the second go does not score like a
    // pass on the first.
    expect(card.metricsMilli.firstAttempt.valueMilli).toBe(500);
    expect(card.compositeMilli.valueMilli).toBeLessThan(1_000);
    expect(card.wastedMilliseconds).toBeGreaterThanOrEqual(0);

    // Attempt 2 began from the fixture, not from attempt 1's edits.
    expect(result.attempts[1].baselineTreeDigest).toBe(result.attempts[0].baselineTreeDigest);
  });

  it('stops at the first success rather than spending the remaining attempts', async () => {
    const { result } = await run([
      { steps: [{ do: 'write', path: 'src/stats.js', contents: CORRECT_STATS }] },
      { steps: [{ do: 'write', path: 'src/stats.js', contents: 'never reached' }] },
    ]);
    expect(result.attemptsUsed).toBe(1);
  });
});

describe('the verdict is never taken from the agent', () => {
  it('scores a model that claims success and changes nothing exactly as one that does nothing', async () => {
    const { card } = await run([{
      steps: [{ do: 'say', text: 'I have fixed the bug and all tests pass.' }],
      finalMessage: 'Done — every test passes.',
    }]);
    expect(card.status).toBe('behavioralFailure');
    expect(card.changedFileCount).toBe(0);
  });

  it('records a tool failure as a tool failure, not as a wrong answer', async () => {
    const { card } = await run([{ steps: [{ do: 'fail', kind: 'timeout', detail: 'the tool did not finish in time' }] }]);
    expect(card.status).toBe('timeout');
    expect(card.metricsMilli.taskSuccess.unavailableReason).toContain('nothing about the model\'s work was measured');
    expect(card.compositeMilli.valueMilli).toBeUndefined();
  });

  it('flags a provider throttle so the campaign aborts instead of recording a failure', async () => {
    const { card } = await run([{ steps: [{ do: 'fail', kind: 'rateLimited', detail: 'the allowance is exhausted' }] }]);
    expect(card.providerThrottled).toBe(true);
    expect(card.detail).toContain('not recorded as a quality outcome');
  });

  it('separates what the engine observed from what the agent reported', async () => {
    const { result } = await run([{
      steps: [
        { do: 'say', text: 'I will look at the test first.' },
        { do: 'read', path: 'src/stats.js' },
        { do: 'write', path: 'src/stats.js', contents: CORRECT_STATS },
      ],
    }]);
    const summary = result.attempts[0].transcript.summary;
    expect(summary.reportedEventCount).toBeGreaterThan(0);
    expect(summary.observedEventCount).toBeGreaterThan(0);
    expect(summary.toolsUsed).toEqual(['readFile', 'writeFile']);
    // Every verification reading is observed, never reported.
    const verification = result.attempts[0].transcript.events.filter((event) => event.kind === 'verificationRan');
    expect(verification.every((event) => event.provenance === 'engineObserved')).toBe(true);
    expect(verification.map((event) => event.reason)).toEqual(['baseline', 'afterChange']);
  });
});

describe('the fixture seal', () => {
  it('refuses to run against a tree the case was not sealed against', async () => {
    const wrongSeal = makeWorkspaceCase({
      ...BROKEN_SUM_MEAN,
      id: 'ws.broken-sum.wrong-seal',
      source: { fixturePath: 'workspace/broken-sum', expectedTreeDigest: 'f'.repeat(64) },
      task: { instruction: BROKEN_SUM_MEAN.task.instruction, scope: BROKEN_SUM_MEAN.task.scope },
      verification: BROKEN_SUM_MEAN.verification,
      execution: BROKEN_SUM_MEAN.execution,
    });
    const { card, result } = await run([{ steps: [{ do: 'write', path: 'src/stats.js', contents: CORRECT_STATS }] }],
      { workspaceCase: wrongSeal });

    expect(result.attempts[0].harnessFault?.code).toBe('fixtureDrift');
    expect(card.status).toBe('runtimeError');
    expect(card.detail).toContain('was sealed against');
  });
});

describe('a driver that cannot do what the case needs', () => {
  it('is refused before a workspace is made or anything is spent', async () => {
    const result = await runWorkspaceCase({
      case: BROKEN_SUM_MEAN,
      driver: new ScriptedWorkspaceAgent([], { capabilities: { rootsToDirectory: false } }),
      fixtureRoot: FIXTURE_ROOT,
      sandboxRoot: sandbox(),
    });
    expect(result.attempts).toHaveLength(0);
    expect(result.refusedBecause[0]).toContain('cannot be told which directory to work in');
    expect(scoreWorkspaceRun(BROKEN_SUM_MEAN, result).status).toBe('envelopeFailure');
  });
});
