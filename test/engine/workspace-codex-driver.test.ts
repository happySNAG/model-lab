// The Codex workspace driver, held to the same host contracts as the Claude one, with NO request
// leaving this machine.
//
// THE STREAMS BELOW ARE NOT INVENTED. Every event shape — `command_execution` with its wrapped
// `/bin/zsh -lc '…'` string, `aggregated_output`, `exit_code` and `status`; `file_change` with absolute
// paths and a `kind`; the `model rerouted: a -> b (Reason)` error item; `turn.completed` usage with
// `cached_input_tokens`, `cache_write_input_tokens` and `reasoning_output_tokens` — was captured from
// the installed codex-cli 0.155.0 driven against a LOOPBACK fake of the Responses endpoint, during the
// audit this driver was written from. The fake answered; nothing reached a provider.
//
// TWO KINDS OF TEST, as on the Claude side. A fake `codex` on disk, spawned for real, for every claim
// about the CHILD PROCESS — its argv, its cwd, its environment, its stdin. An injected `run` for every
// claim about READING what came back.

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CLIResult, CLIRunOptions } from '../../src/engine/cli-process';
import { OTLPTurnObservation, OTLPTurnSource } from '../../src/engine/otlp-observer';
import { BROKEN_SUM_MEAN } from '../../src/engine/workspace-catalog';
import {
  ToolPolicy, WorkspaceCase, fileInvariant, makeWorkspaceCase, workspaceCommand, workspaceInstructionText,
} from '../../src/engine/workspace-case';
import { driverShortfalls } from '../../src/engine/workspace-agent';
import { runWorkspaceCase } from '../../src/engine/workspace-execution';
import { scoreWorkspaceRun } from '../../src/engine/workspace-scoring';
import { TranscriptBuilder } from '../../src/engine/workspace-transcript';
import { snapshotTree } from '../../src/engine/workspace-tree';
import { executionIdentity } from '../../src/engine/workspace-host';
import { ProviderBinding } from '../../src/engine/provider';
import {
  CODEX_CLI_VERSION_VERIFIED_AGAINST, CODEX_WORKSPACE_CAPABILITIES, CODEX_WORKSPACE_DISABLED_FEATURES,
  CodexPreflight, CodexWorkspaceDriver, buildCodexWorkspaceArguments, codexExecutableReadRoots,
  codexWorkspaceUsage, eventsFromCodexEvent, newCodexStreamState, readCodexReroute, unwrapCodexShellCommand,
} from '../../src/engine/workspace-codex-driver';

const FIXTURE_ROOT = path.resolve(__dirname, '../../fixtures');
const FIXTURE_SOURCE = path.join(FIXTURE_ROOT, 'workspace/broken-sum');

const temporaries: string[] = [];
afterEach(() => { for (const directory of temporaries.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

function temporary(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaries.push(directory);
  return directory;
}

const ALL_TOOLS: ToolPolicy = { fileRead: true, fileWrite: true, commandExecution: true, allowedExecutables: [] };

/** A ChatGPT subscription session, as `codex doctor --json` reports one, on the verified version. */
const SUBSCRIPTION: CodexPreflight = {
  version: CODEX_CLI_VERSION_VERIFIED_AGAINST,
  auth: { storedAuthMode: 'chatgpt', apiKeyStored: false, chatgptTokensStored: true, status: 'ok' },
};

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

// MARK: - The captured stream shapes

const threadStarted = { type: 'thread.started', thread_id: '01a0c5d7-2a7b-7553-9a84-de068c09ae35' };
const turnStarted = { type: 'turn.started' };
const commandStarted = (id: string, command: string) => ({
  type: 'item.started',
  item: { id, type: 'command_execution', command: `/bin/zsh -lc '${command}'`, aggregated_output: '', exit_code: null, status: 'in_progress' },
});
const commandCompleted = (id: string, command: string, output: string, exitCode: number) => ({
  type: 'item.completed',
  item: {
    id, type: 'command_execution', command: `/bin/zsh -lc '${command}'`, aggregated_output: output,
    exit_code: exitCode, status: exitCode === 0 ? 'completed' : 'failed',
  },
});
const patchStarted = (id: string, file: string) => ({
  type: 'item.started', item: { id, type: 'file_change', changes: [{ path: file, kind: 'update' }], status: 'in_progress' },
});
const patchCompleted = (id: string, file: string, status = 'completed') => ({
  type: 'item.completed', item: { id, type: 'file_change', changes: [{ path: file, kind: 'update' }], status },
});
const agentMessage = (id: string, text: string) => ({ type: 'item.completed', item: { id, type: 'agent_message', text } });
const reasoning = (id: string, text: string) => ({ type: 'item.completed', item: { id, type: 'reasoning', text } });
const turnCompleted = (usage: Record<string, number> = {}) => ({
  type: 'turn.completed',
  usage: {
    input_tokens: 6021, cached_input_tokens: 2400, cache_write_input_tokens: 0, output_tokens: 300,
    reasoning_output_tokens: 120, ...usage,
  },
});
const rerouteItem = (from: string, to: string) => ({
  type: 'item.completed',
  item: { id: 'item_r', type: 'error', message: `model rerouted: ${from} -> ${to} (HighRiskCyberActivity)` },
});
const turnFailed = (status: number | undefined, message: string) => ({
  type: 'turn.failed',
  error: { message: status === undefined ? message : JSON.stringify({ status, error: { message } }) },
});

/** A competent, honest run: run the tests, patch, re-run, answer. `__CWD__` becomes the child's cwd. */
function successfulStream(): unknown[] {
  return [
    threadStarted, turnStarted,
    reasoning('item_r0', 'The divisor looks wrong.'),
    commandStarted('item_0', 'node test/stats.test.js'),
    commandCompleted('item_0', 'node test/stats.test.js', 'not ok - mean divides by the count\n2/5 passed\n', 1),
    patchStarted('item_1', '__CWD__/src/stats.js'),
    patchCompleted('item_1', '__CWD__/src/stats.js'),
    commandStarted('item_2', 'node test/stats.test.js'),
    commandCompleted('item_2', 'node test/stats.test.js', '5/5 passed\n', 0),
    agentMessage('item_3', 'Fixed the divisor in `mean`; all five checks pass.'),
    turnCompleted(),
  ];
}

/** A fake `codex` that records what it was handed, applies scripted writes, and prints a stream. */
function fakeCodex(options: {
  recordPath: string; lines: unknown[]; writes?: { path: string; contents: string }[]; exitCode?: number; stderr?: string;
}): string {
  const directory = temporary('cernum-fake-codex-');
  const executable = path.join(directory, 'codex');
  const script = `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { stdin += chunk; });
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(options.recordPath)}, JSON.stringify({
    argv: process.argv.slice(2), cwd: process.cwd(),
    environmentNames: Object.keys(process.env).sort(), environment: process.env, stdin,
  }));
  for (const write of ${JSON.stringify(options.writes ?? [])}) {
    const target = path.resolve(process.cwd(), write.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, write.contents);
  }
  for (const line of ${JSON.stringify(options.lines)}) process.stdout.write(JSON.stringify(line).split('__CWD__').join(process.cwd()) + '\\n');
  ${options.stderr === undefined ? '' : `process.stderr.write(${JSON.stringify(options.stderr)});`}
  process.exit(${options.exitCode ?? 0});
});
`;
  fs.writeFileSync(executable, script, { mode: 0o755 });
  return executable;
}

interface ChildRecord {
  argv: string[]; cwd: string; environmentNames: string[]; environment: Record<string, string>; stdin: string;
}

function readRecord(recordPath: string): ChildRecord {
  return JSON.parse(fs.readFileSync(recordPath, 'utf8')) as ChildRecord;
}

function variant(overrides: {
  id: string; environmentAllowlist?: string[]; networkPolicy?: WorkspaceCase['execution']['networkPolicy'];
  tools?: Partial<ToolPolicy>; maximumAttempts?: number;
}): WorkspaceCase {
  return makeWorkspaceCase({
    id: overrides.id,
    version: '1',
    suiteID: BROKEN_SUM_MEAN.suiteID,
    suiteVersion: BROKEN_SUM_MEAN.suiteVersion,
    dimensions: ['multiFileEditing'],
    source: { fixturePath: 'workspace/broken-sum', expectedTreeDigest: BROKEN_SUM_MEAN.source.expectedTreeDigest },
    task: { instruction: BROKEN_SUM_MEAN.task.instruction, scope: { allowed: ['src/**'], forbidden: ['test/**'] } },
    execution: {
      timeoutMilliseconds: 60_000,
      maximumAttempts: overrides.maximumAttempts ?? 1,
      tools: { ...ALL_TOOLS, ...overrides.tools },
      networkPolicy: overrides.networkPolicy ?? 'providerOnly',
      environmentAllowlist: overrides.environmentAllowlist ?? ['HOME', 'USER'],
    },
    verification: {
      commands: [workspaceCommand({ id: 'stats-tests', kind: 'test', executable: 'node', args: ['test/stats.test.js'], timeoutMilliseconds: 30_000 })],
      invariants: [fileInvariant({ path: 'src/stats.js', mustExist: true, mustNotContain: ['values.length + 1'] })],
      forbiddenChanges: ['test/**'],
      maximumChangedFiles: 2,
      maximumChangedLines: 40,
    },
  });
}

async function runWithFake(options: {
  workspaceCase?: WorkspaceCase;
  lines: unknown[];
  writes?: { path: string; contents: string }[];
  exitCode?: number;
  stderr?: string;
  environmentSource?: NodeJS.ProcessEnv;
  requestedModelID?: string;
  effort?: 'medium' | 'max' | 'none';
  preflight?: CodexPreflight;
  otlp?: OTLPTurnSource;
}) {
  const recordDirectory = temporary('cernum-record-');
  const recordPath = path.join(recordDirectory, 'child.json');
  const executablePath = fakeCodex({
    recordPath, lines: options.lines, writes: options.writes, exitCode: options.exitCode, stderr: options.stderr,
  });
  const workspaceCase = options.workspaceCase ?? variant({ id: 'ws.fake.codex' });
  const driver = new CodexWorkspaceDriver({
    requestedModelID: options.requestedModelID ?? 'gpt-5.6-sol',
    effort: options.effort ?? 'medium',
    executablePath,
    preflight: async () => options.preflight ?? SUBSCRIPTION,
    otlp: options.otlp,
  });
  const result = await runWorkspaceCase({
    case: workspaceCase,
    driver,
    fixtureRoot: FIXTURE_ROOT,
    sandboxRoot: temporary('cernum-ws-sandbox-'),
    environmentSource: options.environmentSource
      ?? { PATH: process.env.PATH, HOME: process.env.HOME, USER: process.env.USER ?? 'someone' } as NodeJS.ProcessEnv,
  });
  return { result, recordPath, card: scoreWorkspaceRun(workspaceCase, result), driver };
}

/** A driver whose child is replaced by a scripted `CLIResult`. For reading, never for spawning. */
function injected(result: Partial<CLIResult>, overrides: { preflight?: CodexPreflight; otlp?: OTLPTurnSource } = {}) {
  const calls: CLIRunOptions[] = [];
  const driver = new CodexWorkspaceDriver({
    requestedModelID: 'gpt-5.6-sol', effort: 'medium', executablePath: '/fake/codex',
    preflight: async () => overrides.preflight ?? SUBSCRIPTION,
    otlp: overrides.otlp,
    run: async (options) => {
      calls.push(options);
      return { stdout: '', stderr: '', exitCode: 0, signal: null, elapsedMilliseconds: 10, ...result };
    },
  });
  return { driver, calls };
}

function bareRequest(overrides: { workspaceRoot?: string; tools?: ToolPolicy; environment?: Record<string, string> } = {}) {
  return {
    caseID: 'ws.bare', caseVersion: '1', caseDigest: 'cwc1:x', attemptIndex: 0, maximumAttempts: 1,
    instruction: 'do the thing',
    workspaceRoot: overrides.workspaceRoot ?? temporary('cernum-ws-'),
    scope: { allowed: [], forbidden: [] },
    tools: overrides.tools ?? ALL_TOOLS,
    networkPolicy: 'providerOnly' as const,
    environment: overrides.environment ?? { PATH: process.env.PATH ?? '' },
    timeoutMilliseconds: 1_000,
    transcript: new TranscriptBuilder(0, () => 0),
  };
}

const lines = (events: unknown[]) => events.map((event) => JSON.stringify(event)).join('\n') + '\n';

function planFor(options: Partial<Parameters<typeof buildCodexWorkspaceArguments>[0]> = {}) {
  return buildCodexWorkspaceArguments({
    tools: ALL_TOOLS, networkPolicy: 'providerOnly', requestedModelID: 'gpt-5.6-sol', effort: 'medium',
    workspaceRoot: '/private/var/folders/x/T/cernum-ws-1/attempt-1/work',
    homeDirectories: ['/Users/someone'],
    executableReadRoots: ['/Users/someone/.local/bin', '/Users/someone/.codex/packages/standalone/releases/0.155.0-x'],
    ...options,
  });
}

// 1 ─────────────────────────────────────────────────────────────────────────────────────────────
describe('1 · the working directory is the disposable workspace, and the sandbox is rooted there', () => {
  it('starts the child in the attempt workspace and names that same directory with -C', async () => {
    const { recordPath, result } = await runWithFake({ lines: [threadStarted, turnCompleted()] });
    const record = readRecord(recordPath);
    expect(result.attempts[0].harnessFault).toBeUndefined();
    expect(path.basename(record.cwd)).toBe('work');
    expect(record.cwd).not.toBe(process.cwd());
    // The same directory, allowing for macOS spelling `/var/…` and `/private/var/…` for one place.
    const rooted = record.argv[record.argv.indexOf('-C') + 1];
    const unprivate = (value: string) => value.replace(/^\/private/, '');
    expect(unprivate(rooted)).toBe(unprivate(record.cwd));
    expect(record.argv).not.toContain('--add-dir');
  });

  it('denies HOME to every model command, re-allows only the CLI\'s own install, and keeps /tmp read-only', () => {
    const plan = planFor();
    expect(plan.permissionFilesystem).toEqual({
      '/Users/someone': 'none',
      '/Users/someone/.codex/packages/standalone/releases/0.155.0-x': 'read',
      '/Users/someone/.local/bin': 'read',
      ':slash_tmp': 'read',
    });
    expect(plan.args).toContain('default_permissions="cernum_workspace"');
    expect(plan.args).toContain('permissions.cernum_workspace.extends=":workspace"');
  });

  it('does not re-allow a binary directory that is not under HOME — there is nothing to re-allow', () => {
    const plan = planFor({ executableReadRoots: ['/opt/homebrew/bin'] });
    expect(Object.keys(plan.permissionFilesystem)).not.toContain('/opt/homebrew/bin');
  });

  it('refuses a workspace inside HOME, which the profile would make unreadable', () => {
    const plan = planFor({ workspaceRoot: '/Users/someone/sandbox/work' });
    expect(plan.unexpressed.join(' ')).toContain('inside the home directory');
  });

  it('does not judge a preflight placeholder against wherever the command was typed', () => {
    expect(planFor({ workspaceRoot: '<workspace>' }).unexpressed).toEqual([]);
  });

  it('refuses when the home directory cannot be determined, rather than leaving it readable', () => {
    expect(planFor({ homeDirectories: [] }).unexpressed.join(' ')).toContain('home directory could not be determined');
  });

  it('follows the binary\'s symlinks at EVERY component, including a linked directory mid-path', () => {
    // The real layout: the leaf is a link, and so is the `current` DIRECTORY inside its target.
    const links: Record<string, string> = {
      '/Users/someone/.local/bin/codex': '/Users/someone/.codex/packages/standalone/current/bin/codex',
      '/Users/someone/.codex/packages/standalone/current': 'releases/0.155.0-x',
    };
    const roots = codexExecutableReadRoots('/Users/someone/.local/bin/codex', (file) => links[file]);
    expect(roots).toEqual([
      '/Users/someone/.local/bin',
      // The directory holding the `current` link — without it the helper cannot traverse to the binary.
      '/Users/someone/.codex/packages/standalone',
      '/Users/someone/.codex/packages/standalone/releases/0.155.0-x/bin',
      '/Users/someone/.codex/packages/standalone/releases/0.155.0-x',
    ]);
    // `~/.codex` itself — where auth.json lives — is never re-allowed.
    expect(roots).not.toContain('/Users/someone/.codex');
  });

  it('stops following a link cycle instead of hanging', () => {
    const roots = codexExecutableReadRoots('/a/codex', (file) => (file === '/a/codex' ? '/b/codex' : file === '/b/codex' ? '/a/codex' : undefined));
    expect(roots.length).toBeGreaterThan(0);
  });
});

// 2 ─────────────────────────────────────────────────────────────────────────────────────────────
describe('2 · the frozen instruction is delivered exactly, on stdin, and nowhere else', () => {
  it('writes workspaceInstructionText(case) to stdin byte for byte and keeps it out of argv', async () => {
    const workspaceCase = variant({ id: 'ws.fake.instruction' });
    const { recordPath } = await runWithFake({ workspaceCase, lines: [threadStarted, turnCompleted()] });
    const record = readRecord(recordPath);
    expect(record.stdin).toBe(workspaceInstructionText(workspaceCase));
    expect(record.argv.join(' ')).not.toContain('The test suite in this repository fails');
  });
});

// 3 ─────────────────────────────────────────────────────────────────────────────────────────────
describe('3 · the requested model and effort are sent exactly as frozen', () => {
  it('sends the documented vector, in a shape a reader can check', () => {
    const plan = planFor();
    expect(plan.args.slice(0, 4)).toEqual(['exec', '--json', '--color', 'never']);
    for (const flag of ['--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '--ignore-rules']) {
      expect(plan.args).toContain(flag);
    }
    expect(plan.args).toContain('forced_login_method="chatgpt"');
    expect(plan.args).toContain('approval_policy="never"');
    expect(plan.args).toContain('skills.include_instructions=false');
    expect(plan.args).toContain('web_search="disabled"');
    expect(plan.args).toContain('tools.web_search=false');
    for (const feature of CODEX_WORKSPACE_DISABLED_FEATURES) {
      expect(plan.args.some((argument, index) => argument === feature && plan.args[index - 1] === '--disable')).toBe(true);
    }
    expect(plan.args[plan.args.indexOf('-m') + 1]).toBe('gpt-5.6-sol');
    expect(plan.args).toContain('model_reasoning_effort="medium"');
    expect(plan.unexpressed).toEqual([]);
  });

  it('never disables the tools the task needs', () => {
    const plan = planFor();
    for (const needed of ['shell_tool', 'unified_exec', 'code_mode_host']) {
      expect(plan.args.some((argument, index) => argument === needed && plan.args[index - 1] === '--disable')).toBe(false);
    }
  });

  it('sends no effort flag when none was frozen, and says the default is the CLI\'s', () => {
    const plan = planFor({ effort: 'none' });
    expect(plan.args.some((argument) => argument.startsWith('model_reasoning_effort'))).toBe(false);
    expect(plan.notEnforceable.join(' ')).toContain('catalogue default');
  });

  it('refuses `ultra` — an orchestration mode, not an effort — before anything is sent', () => {
    const plan = planFor({ effort: 'ultra' as never });
    expect(plan.unexpressed.join(' ')).toContain('orchestration mode');
    expect(plan.args.some((argument) => argument.includes('ultra'))).toBe(false);
  });

  it('the child actually receives the model and effort', async () => {
    const { recordPath } = await runWithFake({ lines: [threadStarted, turnCompleted()], effort: 'max', requestedModelID: 'gpt-6-astra' });
    const argv = readRecord(recordPath).argv;
    expect(argv[argv.indexOf('-m') + 1]).toBe('gpt-6-astra');
    expect(argv).toContain('model_reasoning_effort="max"');
  });
});

// 4 ─────────────────────────────────────────────────────────────────────────────────────────────
describe('4 · no fallback model, and no requested model passed off as a reported one', () => {
  it('names exactly one model and never a dangerous or fallback switch', () => {
    const plan = planFor();
    expect(plan.args.filter((argument) => argument === '-m')).toHaveLength(1);
    for (const forbidden of ['--dangerously-bypass-approvals-and-sandbox', '--approve-for-me', '--search', '--oss',
      '--add-dir', '--profile', '-p', '--worktree', '-s', '--sandbox', 'danger-full-access']) {
      expect(plan.args).not.toContain(forbidden);
    }
  });

  it('leaves the reported model EMPTY on an ordinary run: codex names none, and the request is not a reply', async () => {
    const { result } = await runWithFake({ lines: successfulStream(), writes: [{ path: 'src/stats.js', contents: CORRECT_STATS }] });
    const agent = result.attempts[0].agent;
    expect(agent.completed).toBe(true);
    expect(agent.reportedModelID).toBe('');
    expect((agent.usage as Record<string, unknown>).identityState).toBe('unverifiable');
    const binding = { requestedModelID: 'gpt-5.6-sol' } as ProviderBinding;
    expect(executionIdentity(binding, agent.reportedModelID).executionIdentityVerdict).toBe('unverifiable');
  });

  it('refuses an attempt the tool reports as REROUTED, and records the model that actually served it', async () => {
    const { result, card } = await runWithFake({
      lines: [threadStarted, turnStarted, rerouteItem('gpt-5.6-sol', 'gpt-5.2'), agentMessage('m', 'done'), turnCompleted()],
      writes: [{ path: 'src/stats.js', contents: CORRECT_STATS }],
    });
    const agent = result.attempts[0].agent;
    expect(agent.failure?.kind).toBe('policyNotExpressible');
    expect(agent.failure?.detail).toContain('gpt-5.6-sol -> gpt-5.2');
    expect(agent.reportedModelID).toBe('gpt-5.2');
    expect(card.status).toBe('envelopeFailure');
    const binding = { requestedModelID: 'gpt-5.6-sol' } as ProviderBinding;
    expect(executionIdentity(binding, agent.reportedModelID).executionIdentityVerdict).toBe('substituted');
  });

  it('reads the reroute line the CLI writes, and nothing that merely resembles it', () => {
    expect(readCodexReroute('model rerouted: gpt-5.5 -> gpt-substitute-9 (HighRiskCyberActivity)'))
      .toEqual({ requested: 'gpt-5.5', served: 'gpt-substitute-9', reason: 'HighRiskCyberActivity' });
    expect(readCodexReroute('Your account was flagged … routed to gpt-5.2 as a fallback')).toBeUndefined();
  });

  it('refuses an attempt that delegated to another agent', async () => {
    const { result } = await runWithFake({
      lines: [threadStarted, { type: 'item.completed', item: { id: 'c1', type: 'collab_tool_call', status: 'completed' } }, turnCompleted()],
    });
    expect(result.attempts[0].agent.failure?.kind).toBe('policyNotExpressible');
    expect(result.attempts[0].agent.failure?.detail).toContain('delegated');
  });

  it('refuses an attempt that ran a withheld tool — web search — rather than assuming the switch held', async () => {
    const { result } = await runWithFake({
      lines: [threadStarted, { type: 'item.completed', item: { id: 'w1', type: 'web_search', query: 'q' } }, turnCompleted()],
    });
    expect(result.attempts[0].agent.failure?.kind).toBe('policyNotExpressible');
    expect(result.attempts[0].agent.failure?.detail).toContain('web_search');
  });
});

// 5 ─────────────────────────────────────────────────────────────────────────────────────────────
describe('5 · a policy this CLI cannot express is refused before anything is spent', () => {
  it('refuses a case that withholds a tool, without starting a process', async () => {
    const { driver, calls } = injected({});
    const outcome = await driver.run(bareRequest({ tools: { ...ALL_TOOLS, commandExecution: false } }));
    expect(outcome.failure?.kind).toBe('policyNotExpressible');
    expect(outcome.failure?.detail).toContain('command execution');
    expect(calls).toHaveLength(0);
  });

  it('refuses an executable allow-list it cannot enforce', () => {
    expect(planFor({ tools: { ...ALL_TOOLS, allowedExecutables: ['node'] } }).unexpressed.join(' ')).toContain('allow-list');
  });

  it('refuses a frozen sampling setting rather than dropping it', () => {
    const plan = planFor({ temperatureMilli: 200, seed: 7 });
    expect(plan.unexpressed.join(' ')).toContain('temperature');
    expect(plan.unexpressed.join(' ')).toContain('seed');
  });

  it('refuses networkPolicy denied through the shared shortfall check, and unrestricted in the plan', () => {
    const driver = new CodexWorkspaceDriver({ requestedModelID: 'm', executablePath: '/fake/codex' });
    expect(driverShortfalls(driver, ALL_TOOLS, 'denied').join(' ')).toContain('network');
    expect(driverShortfalls(driver, ALL_TOOLS, 'providerOnly')).toEqual([]);
    expect(planFor({ networkPolicy: 'unrestricted' }).unexpressed.join(' ')).toContain('unrestricted');
  });

  it('declares only what the installed CLI can do', () => {
    expect(CODEX_WORKSPACE_CAPABILITIES.reportsModelIdentity).toBe(false);
    expect(CODEX_WORKSPACE_CAPABILITIES.expressesNetworkPolicy).toBe(false);
    expect(CODEX_WORKSPACE_CAPABILITIES.expressesToolPolicy).toBe(false);
    expect(CODEX_WORKSPACE_CAPABILITIES.rootsToDirectory).toBe(true);
  });

  it('refuses to run under a CLI version its flags were not verified against', async () => {
    const { driver, calls } = injected({}, { preflight: { ...SUBSCRIPTION, version: '0.156.0' } });
    const outcome = await driver.run(bareRequest());
    expect(outcome.failure?.kind).toBe('policyNotExpressible');
    expect(outcome.failure?.detail).toContain('0.156.0');
    expect(calls).toHaveLength(0);
  });

  it('refuses an OPENAI_* or CODEX_* name in the environment: it could redirect requests or change who pays', async () => {
    const { driver, calls } = injected({});
    const outcome = await driver.run(bareRequest({ environment: { PATH: '/usr/bin', CODEX_HOME: '/elsewhere' } }));
    expect(outcome.failure?.kind).toBe('policyNotExpressible');
    expect(outcome.failure?.detail).toContain('CODEX_HOME');
    expect(calls).toHaveLength(0);
  });
});

// 6 ─────────────────────────────────────────────────────────────────────────────────────────────
describe('6 · a provider failure is named as one, never as the model\'s', () => {
  it('maps a failed turn with a server error to transport', async () => {
    const { driver } = injected({
      stdout: lines([threadStarted, turnFailed(500, 'upstream exploded')]), exitCode: 1,
      failure: { kind: 'exitFailure', detail: 'exit 1' },
    });
    const outcome = await driver.run(bareRequest());
    expect(outcome.failure?.kind).toBe('transport');
    expect(outcome.failure?.detail).toContain('HTTP 500');
  });

  it('maps a refused model (HTTP 400) to transport with the service\'s own words, not to a quality result', async () => {
    const { driver } = injected({
      stdout: lines([threadStarted, turnFailed(400, "The 'x' model is not supported when using Codex with a ChatGPT account.")]),
      exitCode: 1, failure: { kind: 'exitFailure', detail: 'exit 1' },
    });
    const outcome = await driver.run(bareRequest());
    expect(outcome.failure?.kind).toBe('transport');
    expect(outcome.failure?.detail).toContain('not supported when using Codex');
  });

  it('reports a clean exit with no turn.completed as malformed rather than scraping it', async () => {
    const { driver } = injected({ stdout: lines([threadStarted, turnStarted]) });
    expect((await driver.run(bareRequest())).failure?.kind).toBe('malformedOutput');
  });

  it('reports a missing executable as notInstalled without spawning', async () => {
    const driver = new CodexWorkspaceDriver({ requestedModelID: 'm', findExecutable: () => undefined });
    expect((await driver.run(bareRequest())).failure?.kind).toBe('notInstalled');
  });
});

// 7 ─────────────────────────────────────────────────────────────────────────────────────────────
describe('7 · a rate limit is a throttle, not a failed task', () => {
  it('maps HTTP 429 to rateLimited', async () => {
    const { driver } = injected({
      stdout: lines([threadStarted, turnFailed(429, 'Too Many Requests')]), exitCode: 1,
      failure: { kind: 'exitFailure', detail: 'exit 1' },
    });
    expect((await driver.run(bareRequest())).failure?.kind).toBe('rateLimited');
  });

  it('maps the plan\'s usage-limit message to rateLimited, even without a status', async () => {
    const { driver } = injected({
      stdout: lines([threadStarted, { type: 'error', message: "You've hit your usage limit. Try again in 3 hours." },
        turnFailed(undefined, "You've hit your usage limit.")]),
      exitCode: 1, failure: { kind: 'exitFailure', detail: 'exit 1' },
    });
    expect((await driver.run(bareRequest())).failure?.kind).toBe('rateLimited');
  });

  it('is scored as a throttle by the shared scorer', async () => {
    const { card } = await runWithFake({ lines: [threadStarted, turnFailed(429, 'Too Many Requests')], exitCode: 1 });
    expect(card.status).toBe('runtimeError');
    expect(card.providerThrottled).toBe(true);
  });
});

// 8 ─────────────────────────────────────────────────────────────────────────────────────────────
describe('8 · authentication, and the billing basis it decides', () => {
  it('maps HTTP 401 to notAuthenticated', async () => {
    const { driver } = injected({
      stdout: lines([threadStarted, turnFailed(401, 'token expired')]), exitCode: 1,
      failure: { kind: 'exitFailure', detail: 'exit 1' },
    });
    expect((await driver.run(bareRequest())).failure?.kind).toBe('notAuthenticated');
  });

  it('refuses an API-key session before anything is sent: a metered session cannot run as subscription', async () => {
    const { driver, calls } = injected({}, {
      preflight: { version: CODEX_CLI_VERSION_VERIFIED_AGAINST, auth: { storedAuthMode: 'apikey', apiKeyStored: true, chatgptTokensStored: false, status: 'ok' } },
    });
    const outcome = await driver.run(bareRequest());
    expect(outcome.failure?.kind).toBe('notAuthenticated');
    expect(outcome.failure?.detail).toContain('API key');
    expect(calls).toHaveLength(0);
  });

  it('refuses when the authentication state could not be read at all', async () => {
    const { driver, calls } = injected({}, { preflight: { version: CODEX_CLI_VERSION_VERIFIED_AGAINST } });
    expect((await driver.run(bareRequest())).failure?.kind).toBe('notAuthenticated');
    expect(calls).toHaveLength(0);
  });

  it('makes the CLI itself refuse any login but ChatGPT', () => {
    expect(planFor().args).toContain('forced_login_method="chatgpt"');
  });

  it('never hands the child a provider key, whatever this machine holds', async () => {
    const { recordPath } = await runWithFake({
      lines: [threadStarted, turnCompleted()],
      environmentSource: {
        PATH: process.env.PATH, HOME: process.env.HOME, USER: 'someone',
        OPENAI_API_KEY: 'sk-should-never-arrive', CODEX_API_KEY: 'should-never-arrive', ANTHROPIC_API_KEY: 'no',
      } as NodeJS.ProcessEnv,
    });
    const names = readRecord(recordPath).environmentNames;
    expect(names).not.toContain('OPENAI_API_KEY');
    expect(names).not.toContain('CODEX_API_KEY');
    expect(names).not.toContain('ANTHROPIC_API_KEY');
    expect(names).toContain('HOME');
  });
});

// 9 ─────────────────────────────────────────────────────────────────────────────────────────────
describe('9 · a deadline is an unfinished measurement, and says so', () => {
  it('maps a timeout to timeout and keeps the command that was running when the deadline hit', async () => {
    const transcript = new TranscriptBuilder(0, () => 0);
    const { driver } = injected({
      stdout: lines([threadStarted, turnStarted, commandStarted('item_0', 'node test/stats.test.js')]),
      exitCode: null, signal: 'SIGTERM', failure: { kind: 'timeout', detail: 'deadline' },
    });
    const outcome = await driver.run({ ...bareRequest(), transcript });
    expect(outcome.failure?.kind).toBe('timeout');
    const commands = outcome.events.filter((event) => event.kind === 'commandExecuted');
    expect(commands).toHaveLength(1);
    expect(commands[0].executable).toBe('node');
    // It never finished, so it has no exit status — which is the truth.
    expect(commands[0].exitCode).toBeUndefined();
  });

  it('maps a cancellation to cancelled', async () => {
    const { driver } = injected({ failure: { kind: 'cancelled', detail: 'paused' }, exitCode: null });
    expect((await driver.run(bareRequest())).failure?.kind).toBe('cancelled');
  });
});

// 10 ────────────────────────────────────────────────────────────────────────────────────────────
describe('10 · the final response is the last agent message, captured once', () => {
  it('records it as the answer of record and emits exactly one finalResponse', async () => {
    const { result } = await runWithFake({ lines: successfulStream(), writes: [{ path: 'src/stats.js', contents: CORRECT_STATS }] });
    const attempt = result.attempts[0];
    expect(attempt.agent.finalMessage).toBe('Fixed the divisor in `mean`; all five checks pass.');
    const finals = attempt.transcript.events.filter((event) => event.kind === 'finalResponse');
    expect(finals).toHaveLength(1);
    expect(finals[0].provenance).toBe('agentReported');
  });

  it('leaves it absent when the tool never answered', async () => {
    const { result } = await runWithFake({ lines: [threadStarted, turnCompleted()] });
    expect(result.attempts[0].agent.finalMessage).toBeUndefined();
  });
});

// 11 ────────────────────────────────────────────────────────────────────────────────────────────
describe('11 · token usage is mapped explicitly, with the raw block kept', () => {
  it('reads input as the TOTAL, cached as a subset, and derives the fresh remainder', () => {
    const state = newCodexStreamState();
    eventsFromCodexEvent(turnCompleted({ input_tokens: 6021, cached_input_tokens: 2400, cache_write_input_tokens: 21 }), state);
    const usage = codexWorkspaceUsage(state, { reportedModelID: '', requestedModelID: 'gpt-5.6-sol' });
    expect(usage?.inputTokens).toBe(6021);
    expect(usage?.cacheReadInputTokens).toBe(2400);
    expect(usage?.cacheCreationInputTokens).toBe(21);
    expect(usage?.freshInputTokens).toBe(6021 - 2400 - 21);
    // Codex's output INCLUDES its reasoning, so the visible remainder is derived.
    expect(usage?.visibleOutputTokens).toBe(300 - 120);
    expect(usage?.reasoningTokens).toBe(120);
    expect(usage?.outputTokenSemantics).toBe('reasoningIncludedInOutput');
    expect(usage?.rawUsage).toEqual(state.usage);
    // Codex reports no cost and no allowance. Absent, never zero.
    expect(usage?.subscriptionIncludedUsageMicroUSD).toBeUndefined();
  });

  it('reproduces the live proof\'s own total, which a double-counted reasoning figure would not', () => {
    // The first live workspace turn: input 67791, output 1413, reasoning 117, telemetry total 69204.
    const state = newCodexStreamState();
    eventsFromCodexEvent(turnCompleted({
      input_tokens: 67791, cached_input_tokens: 56832, cache_write_input_tokens: 0, output_tokens: 1413, reasoning_output_tokens: 117,
    }), state);
    const usage = codexWorkspaceUsage(state, { reportedModelID: '', requestedModelID: 'gpt-5.6-sol' })!;
    expect((usage.inputTokens ?? 0) + (usage.visibleOutputTokens ?? 0) + (usage.reasoningTokens ?? 0)).toBe(69204);
    expect(usage.freshInputTokens).toBe(10959);
  });

  it('carries the usage through a real run onto the attempt', async () => {
    const { result } = await runWithFake({ lines: successfulStream(), writes: [{ path: 'src/stats.js', contents: CORRECT_STATS }] });
    const usage = result.attempts[0].agent.usage as Record<string, unknown>;
    expect(usage.inputTokens).toBe(6021);
    expect(typeof usage.observedFirstOutputMilliseconds).toBe('number');
  });

  it('records no usage rather than zeros when the tool reported none', async () => {
    const { driver } = injected({ stdout: lines([threadStarted]), failure: { kind: 'timeout', detail: 'x' } });
    expect((await driver.run(bareRequest())).usage).toBeUndefined();
  });
});

// 12 ────────────────────────────────────────────────────────────────────────────────────────────
describe('12 · the applied effort comes from the tool\'s own telemetry, and only from there', () => {
  it('records what the telemetry says, beside the request, and never as identity', async () => {
    const observation: OTLPTurnObservation = {
      correlationKey: '[REDACTED:conversation.id:1]', correlated: true, recordCount: 3,
      turnReasoningEffort: 'medium', authMode: 'Chatgpt', sandboxPolicy: 'workspace-write', approvalPolicy: 'never',
      turnTTFTMilliseconds: 3069,
    };
    const seen: string[] = [];
    const otlp: OTLPTurnSource = {
      endpoint: 'http://127.0.0.1:4318',
      observe: async (thread) => { seen.push(thread); return observation; },
    };
    const { driver, calls } = injected({ stdout: lines([threadStarted, agentMessage('m', 'ok'), turnCompleted()]) }, { otlp });
    const outcome = await driver.run(bareRequest());
    expect(seen).toEqual([threadStarted.thread_id]);
    const usage = outcome.usage as Record<string, unknown>;
    expect(usage.providerReportedEffort).toBe('medium');
    expect(usage.providerReportedAuthMode).toBe('Chatgpt');
    expect(usage.providerReportedTimeToFirstTokenMilliseconds).toBe(3069);
    expect(usage.otlpCorrelationKey).toBe('[REDACTED:conversation.id:1]');
    expect(outcome.reportedModelID).toBe('');
    expect(calls[0].args.some((argument) => argument.startsWith('otel='))).toBe(true);
  });

  it('records no effort at all when no collector was attached — the request is not the answer', async () => {
    const { driver } = injected({ stdout: lines([threadStarted, turnCompleted()]) });
    const usage = (await driver.run(bareRequest())).usage as Record<string, unknown>;
    expect(usage.providerReportedEffort).toBeUndefined();
  });
});

// 13 ────────────────────────────────────────────────────────────────────────────────────────────
describe('13 · the engine\'s filesystem diff is authoritative, whatever the stream claims', () => {
  it('records a real change the stream never mentioned', async () => {
    const { result } = await runWithFake({
      lines: [threadStarted, agentMessage('m', 'I changed nothing.'), turnCompleted()],
      writes: [{ path: 'src/stats.js', contents: CORRECT_STATS }],
    });
    expect(result.attempts[0].diff.changedPaths).toEqual(['src/stats.js']);
  });

  it('records NO change when the stream reports a patch that never landed', async () => {
    const { result } = await runWithFake({ lines: successfulStream(), writes: [] });
    const attempt = result.attempts[0];
    expect(attempt.transcript.events.some((event) => event.kind === 'fileWrite')).toBe(true);
    expect(attempt.diff.clean).toBe(true);
  });

  it('reconciles the absolute path the tool reports against the workspace, without upgrading it to evidence', async () => {
    const { result } = await runWithFake({ lines: successfulStream(), writes: [{ path: 'src/stats.js', contents: CORRECT_STATS }] });
    const write = result.attempts[0].transcript.events.find((event) => event.kind === 'fileWrite');
    expect(write?.provenance).toBe('agentReported');
    expect(write?.workspaceRelativePath).toBe('src/stats.js');
  });

  it('leaves the sealed fixture byte-for-byte identical', async () => {
    const before = snapshotTree(FIXTURE_SOURCE, { capturedAt: 'x' });
    await runWithFake({ lines: successfulStream(), writes: [{ path: 'src/stats.js', contents: CORRECT_STATS }] });
    expect(snapshotTree(FIXTURE_SOURCE, { capturedAt: 'x' }).treeDigest).toBe(before.treeDigest);
  });

  it('fails the attempt as a workspace escape when the pristine baseline changed', async () => {
    const { result, card } = await runWithFake({
      lines: [threadStarted, turnCompleted()],
      writes: [{ path: '../baseline/src/stats.js', contents: '// reached outside\n' }],
    });
    expect(result.attempts[0].harnessFault?.code).toBe('workspaceEscape');
    expect(card.status).toBe('safetyAbort');
  });
});

// 14 ────────────────────────────────────────────────────────────────────────────────────────────
describe('14 · engine verification is authoritative, whatever the stream claims', () => {
  it('fails a run that narrates green tests and changes nothing', async () => {
    const { result, card } = await runWithFake({ lines: successfulStream(), writes: [] });
    const attempt = result.attempts[0];
    expect(attempt.agent.completed).toBe(true);
    expect(attempt.verificationOutcomes[0].passed).toBe(false);
    expect(card.status).toBe('behavioralFailure');
  });

  it('passes the real fix, read off the tree', async () => {
    const { result, card } = await runWithFake({ lines: successfulStream(), writes: [{ path: 'src/stats.js', contents: CORRECT_STATS }] });
    expect(result.attempts[0].baselineOutcomes[0].passed).toBe(false);
    expect(result.attempts[0].verificationOutcomes[0].passed).toBe(true);
    expect(card.status).toBe('pass');
  });

  it('catches the shortcut — editing the test — as a scope failure', async () => {
    const { card } = await runWithFake({ lines: successfulStream(), writes: [{ path: 'test/stats.test.js', contents: 'process.exit(0);\n' }] });
    expect(card.status).toBe('scopeFailure');
  });
});

// 15 ────────────────────────────────────────────────────────────────────────────────────────────
describe('15 · everything the tool says is testimony, and only what the stream proves is recorded', () => {
  it('marks every event from the stream agentReported, and emits no engine-only kind', () => {
    const state = newCodexStreamState();
    const produced = successfulStream().flatMap((event) =>
      eventsFromCodexEvent(JSON.parse(JSON.stringify(event).split('__CWD__').join('/w')) as Record<string, unknown>, state));
    expect(produced.length).toBeGreaterThan(0);
    expect(produced.every((event) => event.provenance === 'agentReported')).toBe(true);
    for (const event of produced) {
      expect(['attemptStarted', 'attemptFinished', 'retryStarted', 'verificationRan', 'harnessFault', 'boundaryRefusal'])
        .not.toContain(event.kind);
    }
  });

  it('emits NO fileRead: codex reads through the shell, and a read is not guessed from `cat`', () => {
    const state = newCodexStreamState();
    const produced = [commandStarted('a', 'cat src/stats.js'), commandCompleted('a', 'cat src/stats.js', 'x', 0)]
      .flatMap((event) => eventsFromCodexEvent(event as Record<string, unknown>, state));
    expect(produced.some((event) => event.kind === 'fileRead')).toBe(false);
    expect(produced.some((event) => event.kind === 'commandExecuted' && event.payload.executable === 'cat')).toBe(true);
  });

  it('unwraps the CLI\'s own login-shell wrapper and nothing else', () => {
    expect(unwrapCodexShellCommand("/bin/zsh -lc 'node test/stats.test.js'")).toBe('node test/stats.test.js');
    expect(unwrapCodexShellCommand("/bin/bash -c 'npm test && echo ok'")).toBe('npm test && echo ok');
    expect(unwrapCodexShellCommand('node test/stats.test.js')).toBe('node test/stats.test.js');
  });

  it('attaches an exit status only where the string named exactly one executable', () => {
    const state = newCodexStreamState();
    const single = eventsFromCodexEvent(commandCompleted('a', 'node test/stats.test.js', '', 1) as Record<string, unknown>, state);
    expect(single.find((event) => event.kind === 'commandExecuted')?.payload.exitCode).toBe(1);
    const compound = eventsFromCodexEvent(commandCompleted('b', 'node x.js && cat y', '', 1) as Record<string, unknown>, state);
    const commands = compound.filter((event) => event.kind === 'commandExecuted');
    expect(commands.map((event) => event.payload.executable)).toEqual(['node', 'cat']);
    expect(commands.every((event) => event.payload.exitCode === undefined)).toBe(true);
    expect(compound.find((event) => event.kind === 'toolResult')?.payload.ok).toBe(false);
  });

  it('claims no write for a patch the tool reports as failed', () => {
    const state = newCodexStreamState();
    const produced = eventsFromCodexEvent(patchCompleted('p', '/w/src/stats.js', 'failed') as Record<string, unknown>, state);
    expect(produced.some((event) => event.kind === 'fileWrite')).toBe(false);
    expect(produced.find((event) => event.kind === 'toolResult')?.payload.ok).toBe(false);
  });

  it('keeps tool notes out of the transcript and a reroute out of the notes', () => {
    const state = newCodexStreamState();
    eventsFromCodexEvent({ type: 'error', message: 'Reconnecting... 1/5' }, state);
    eventsFromCodexEvent(rerouteItem('a', 'b') as Record<string, unknown>, state);
    expect(state.notes).toEqual(['Reconnecting... 1/5']);
    expect(state.reroutes).toEqual([{ requested: 'a', served: 'b', reason: 'HighRiskCyberActivity' }]);
  });
});
