// The Claude workspace driver, every branch of it, with NO request leaving this machine.
//
// TWO KINDS OF TEST, AND THE DIFFERENCE MATTERS.
//
//   A FAKE `claude` ON DISK, spawned for real. Used for everything that is a claim about the CHILD
//   PROCESS: the argument vector it actually received, the directory it actually ran in, and the
//   environment it actually got. An injected `run` function cannot test any of those, because it
//   replaces the very thing under test — a test that asserts `HOME` was withheld by reading an
//   object the test itself passed in has proved nothing about `spawn`.
//
//   AN INJECTED `run`, for everything that is a claim about READING what came back: a deadline, a
//   401, a malformed stream, a substituted model. Those need a controlled `CLIResult` and no process.
//
// The fake is a Node script written per test, so each one carries its own scripted stream and its
// own exit status, and it records what it was handed into a side-channel file OUTSIDE the workspace
// — outside deliberately, so writing the record cannot pollute the tree the engine diffs.

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CLIResult, CLIRunOptions } from '../../src/engine/cli-process';
import { BROKEN_SUM_MEAN } from '../../src/engine/workspace-catalog';
import {
  ToolPolicy, WorkspaceCase, fileInvariant, makeWorkspaceCase, workspaceCommand,
} from '../../src/engine/workspace-case';
import { driverShortfalls, workspaceEnvironment } from '../../src/engine/workspace-agent';
import { runWorkspaceCase } from '../../src/engine/workspace-execution';
import { scoreWorkspaceRun } from '../../src/engine/workspace-scoring';
import { TranscriptBuilder } from '../../src/engine/workspace-transcript';
import { snapshotTree } from '../../src/engine/workspace-tree';
import {
  CLAUDE_WORKSPACE_CAPABILITIES, ClaudeWorkspaceDriver, buildClaudeWorkspaceArguments, commandInvocations,
  eventsFromClaudeMessage, parseClaudeStreamLine, readSessionInit, shellSegments,
} from '../../src/engine/workspace-claude-driver';

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

// MARK: - The scripted stream a fake `claude` writes

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

const initLine = (cwd: string) => ({
  type: 'system', subtype: 'init', cwd, session_id: 's-1',
  tools: ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash'], mcp_servers: [],
  model: 'claude-haiku-4-5', permissionMode: 'dontAsk', slash_commands: [],
  apiKeySource: 'none', claude_code_version: '2.1.278', output_style: 'default', skills: [], plugins: [],
});

const assistantLine = (content: unknown[]) => ({
  type: 'assistant', parent_tool_use_id: null, session_id: 's-1', uuid: 'u-1',
  message: { id: 'm-1', type: 'message', role: 'assistant', model: 'claude-haiku-4-5', content, stop_reason: 'tool_use' },
});

const toolResultLine = (toolUseID: string, text: string, isError = false) => ({
  type: 'user', parent_tool_use_id: null, session_id: 's-1', uuid: 'u-2',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseID, content: text, is_error: isError }] },
});

const resultLine = (overrides: Record<string, unknown> = {}) => ({
  type: 'result', subtype: 'success', duration_ms: 4_210, duration_api_ms: 3_900, ttft_ms: 640,
  is_error: false, num_turns: 4, result: 'I fixed the divisor in `mean` and re-ran the tests; all five pass.',
  stop_reason: 'end_turn', session_id: 's-1', total_cost_usd: 0.012345,
  usage: {
    input_tokens: 7, cache_creation_input_tokens: 6_551, cache_read_input_tokens: 128,
    output_tokens: 452, output_tokens_details: { thinking_tokens: 81 },
  },
  modelUsage: { 'claude-haiku-4-5-20251001': { canonicalModel: 'claude-haiku-4-5', outputTokens: 452 } },
  permission_denials: [], uuid: 'r-1',
  ...overrides,
});

/**
 * Write a fake `claude` that records what it was handed and then prints a scripted stream.
 *
 * `writes` are applied relative to the process's own cwd, which is how a test proves the engine
 * diffs the tree the child actually worked in rather than the one it was told about.
 */
function fakeClaude(options: {
  recordPath: string;
  lines: unknown[];
  writes?: { path: string; contents: string }[];
  exitCode?: number;
  stderr?: string;
}): string {
  const directory = temporary('cernum-fake-claude-');
  const executable = path.join(directory, 'claude');
  const script = `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { stdin += chunk; });
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(options.recordPath)}, JSON.stringify({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    environmentNames: Object.keys(process.env).sort(),
    environment: process.env,
    stdin,
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
  argv: string[];
  cwd: string;
  environmentNames: string[];
  environment: Record<string, string>;
  stdin: string;
}

function readRecord(recordPath: string): ChildRecord {
  return JSON.parse(fs.readFileSync(recordPath, 'utf8')) as ChildRecord;
}

/** A case built from the same sealed fixture, with one thing changed. */
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
    source: {
      fixturePath: 'workspace/broken-sum',
      expectedTreeDigest: BROKEN_SUM_MEAN.source.expectedTreeDigest,
    },
    task: { instruction: BROKEN_SUM_MEAN.task.instruction, scope: { allowed: ['src/**'], forbidden: ['test/**'] } },
    execution: {
      timeoutMilliseconds: 60_000,
      maximumAttempts: overrides.maximumAttempts ?? 1,
      tools: { ...ALL_TOOLS, ...overrides.tools },
      networkPolicy: overrides.networkPolicy ?? 'providerOnly',
      environmentAllowlist: overrides.environmentAllowlist ?? [],
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
}) {
  const recordDirectory = temporary('cernum-record-');
  const recordPath = path.join(recordDirectory, 'child.json');
  const executablePath = fakeClaude({
    recordPath, lines: options.lines, writes: options.writes, exitCode: options.exitCode, stderr: options.stderr,
  });
  const workspaceCase = options.workspaceCase ?? variant({ id: 'ws.fake.default' });
  const driver = new ClaudeWorkspaceDriver({
    requestedModelID: options.requestedModelID ?? 'claude-haiku-4-5',
    executablePath,
  });
  const result = await runWorkspaceCase({
    case: workspaceCase,
    driver,
    fixtureRoot: FIXTURE_ROOT,
    sandboxRoot: temporary('cernum-ws-sandbox-'),
    environmentSource: options.environmentSource,
  });
  return { result, recordPath, card: scoreWorkspaceRun(workspaceCase, result), driver };
}

/** The stream a competent, honest run produces: read, edit, test, answer. */
function successfulStream(cwd: string): unknown[] {
  return [
    initLine(cwd),
    assistantLine([
      { type: 'thinking', thinking: 'The divisor looks wrong.' },
      { type: 'text', text: 'Let me read the test and the implementation.' },
      { type: 'tool_use', id: 'toolu_read', name: 'Read', input: { file_path: 'src/stats.js' } },
    ]),
    toolResultLine('toolu_read', 'function mean(values) { return sum(values) / (values.length + 1); }'),
    assistantLine([
      { type: 'tool_use', id: 'toolu_edit', name: 'Edit', input: { file_path: 'src/stats.js', old_string: 'x', new_string: 'y' } },
    ]),
    toolResultLine('toolu_edit', 'The file src/stats.js has been updated.'),
    assistantLine([
      { type: 'tool_use', id: 'toolu_bash', name: 'Bash', input: { command: 'node test/stats.test.js' } },
    ]),
    toolResultLine('toolu_bash', '5/5 passed'),
    resultLine(),
  ];
}

// 1 ─────────────────────────────────────────────────────────────────────────────────────────────
describe('1 · the argument vector is exactly what was decided, and nothing else', () => {
  it('sends the flags the installed CLI documents, in a shape a reader can check', () => {
    const plan = buildClaudeWorkspaceArguments({
      tools: ALL_TOOLS, networkPolicy: 'providerOnly', requestedModelID: 'claude-haiku-4-5',
    });
    expect(plan.args).toEqual([
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--safe-mode',
      '--restricted',
      '--permission-mode', 'dontAsk',
      '--permission-prompts', 'none',
      '--strict-mcp-config',
      '--setting-sources', '',
      '--disable-slash-commands',
      '--no-session-persistence',
      '--tools', 'Read,Glob,Grep,Write,Edit,Bash',
      '--allowedTools', 'Read,Glob,Grep,Write,Edit,Bash',
      '--model', 'claude-haiku-4-5',
    ]);
    expect(plan.unexpressed).toEqual([]);
  });

  it('never bypasses permissions, however this machine happens to be configured interactively', () => {
    const plan = buildClaudeWorkspaceArguments({ tools: ALL_TOOLS, networkPolicy: 'denied', requestedModelID: 'm' });
    expect(plan.args).not.toContain('--dangerously-skip-permissions');
    expect(plan.args).not.toContain('--allow-dangerously-skip-permissions');
    expect(plan.args).not.toContain('bypassPermissions');
    // `--bare` would switch Anthropic auth to an API key and bill a run recorded as subscription-included.
    expect(plan.args).not.toContain('--bare');
    // A fallback model is a silent substitution.
    expect(plan.args).not.toContain('--fallback-model');
  });

  it('names only the tools the case declares, so a forbidden capability is never handed over', () => {
    const readOnly = buildClaudeWorkspaceArguments({
      tools: { fileRead: true, fileWrite: false, commandExecution: false, allowedExecutables: [] },
      networkPolicy: 'providerOnly', requestedModelID: 'm',
    });
    expect(readOnly.toolNames).toEqual(['Read', 'Glob', 'Grep']);
    expect(readOnly.args[readOnly.args.indexOf('--tools') + 1]).toBe('Read,Glob,Grep');
    expect(readOnly.toolNames).not.toContain('Bash');
    expect(readOnly.toolNames).not.toContain('Write');

    const nothing = buildClaudeWorkspaceArguments({
      tools: { fileRead: false, fileWrite: false, commandExecution: false, allowedExecutables: [] },
      networkPolicy: 'providerOnly', requestedModelID: 'm',
    });
    // `--tools ""` is the CLI's documented way of saying "no tools at all".
    expect(nothing.args[nothing.args.indexOf('--tools') + 1]).toBe('');
    expect(nothing.args).not.toContain('--allowedTools');
  });

  it('expresses an executable allow-list as a Bash rule, and says what that rule cannot catch', () => {
    const plan = buildClaudeWorkspaceArguments({
      tools: { ...ALL_TOOLS, allowedExecutables: ['node', 'npm'] },
      networkPolicy: 'providerOnly', requestedModelID: 'm',
    });
    expect(plan.allowedToolRules).toContain('Bash(node *)');
    expect(plan.allowedToolRules).toContain('Bash(npm *)');
    expect(plan.notEnforceable.some((line) => line.includes('shells out'))).toBe(true);
  });

  it('refuses a frozen sampling setting rather than dropping it', () => {
    const plan = buildClaudeWorkspaceArguments({
      tools: ALL_TOOLS, networkPolicy: 'providerOnly', requestedModelID: 'm', temperatureMilli: 200, seed: 7,
    });
    expect(plan.unexpressed).toHaveLength(2);
    expect(plan.unexpressed.join(' ')).toContain('temperature');
    expect(plan.unexpressed.join(' ')).toContain('seed');
  });

  it('refuses an effort level this CLI silently ignores, before the request is sent', async () => {
    const driver = new ClaudeWorkspaceDriver({
      requestedModelID: 'm', effort: 'ultra' as never, executablePath: '/does/not/matter',
      run: async () => { throw new Error('the request must not be sent'); },
    });
    const outcome = await driver.run(bareRequest({ workspaceRoot: temporary('cernum-ws-') }));
    expect(outcome.failure?.kind).toBe('policyNotExpressible');
    expect(outcome.failure?.detail).toContain('effort');
  });

  it('the child process actually receives that vector, and the instruction on stdin', async () => {
    const { recordPath } = await runWithFake({ lines: [resultLine()] });
    const record = readRecord(recordPath);
    expect(record.argv.slice(0, 3)).toEqual(['-p', '--output-format', 'stream-json']);
    expect(record.argv).toContain('--verbose');
    expect(record.argv).toContain('--restricted');
    expect(record.argv).toContain('--safe-mode');
    expect(record.argv[record.argv.indexOf('--permission-mode') + 1]).toBe('dontAsk');
    // THE INSTRUCTION IS NOWHERE IN ARGV. argv is readable from the process table by every process
    // on this machine, and the instruction is the thing being measured.
    expect(record.argv.join(' ')).not.toContain('The test suite in this repository fails');
    expect(record.stdin).toContain('The test suite in this repository fails');
    expect(record.stdin).toContain('You may change only these paths: src/**');
  });
});

// 2 ─────────────────────────────────────────────────────────────────────────────────────────────
describe('2 · the child runs in the disposable workspace and nowhere else', () => {
  it('starts with cwd at the attempt workspace, not at the checkout it was launched from', async () => {
    const { recordPath, result } = await runWithFake({ lines: [resultLine()] });
    const record = readRecord(recordPath);
    const attempt = result.attempts[0];
    expect(attempt.harnessFault).toBeUndefined();
    expect(record.cwd).not.toBe(process.cwd());
    expect(record.cwd).toContain('cernum-ws-');
    // The `work` tree, specifically. Never `baseline`, which nothing is ever handed.
    expect(path.basename(record.cwd)).toBe('work');
    // Proof it really was that directory: the fixture's own files are in it.
    expect(fs.existsSync(path.join(record.cwd, 'src'))).toBe(false); // deleted with the attempt
  });

  it('passes no --add-dir, so the restricted confinement covers one directory', async () => {
    const { recordPath } = await runWithFake({ lines: [resultLine()] });
    expect(readRecord(recordPath).argv).not.toContain('--add-dir');
  });
});

// 3 ─────────────────────────────────────────────────────────────────────────────────────────────
describe('3 · HOME reaches the child only when the frozen case unlocked it', () => {
  it('withholds HOME from a case that does not name it', async () => {
    const { recordPath } = await runWithFake({
      workspaceCase: variant({ id: 'ws.fake.no-home', environmentAllowlist: [] }),
      lines: [resultLine()],
      environmentSource: { PATH: process.env.PATH, HOME: '/Users/somebody' } as NodeJS.ProcessEnv,
    });
    expect(readRecord(recordPath).environmentNames).not.toContain('HOME');
  });

  it('grants HOME to a case that names it, and grants nothing else with it', async () => {
    const { recordPath } = await runWithFake({
      workspaceCase: variant({ id: 'ws.fake.home', environmentAllowlist: ['HOME'] }),
      lines: [resultLine()],
      environmentSource: {
        PATH: process.env.PATH, HOME: '/Users/somebody', USER: 'somebody', EDITOR: 'vim',
      } as NodeJS.ProcessEnv,
    });
    const record = readRecord(recordPath);
    expect(record.environment.HOME).toBe('/Users/somebody');
    expect(record.environmentNames).not.toContain('USER');
    expect(record.environmentNames).not.toContain('EDITOR');
  });

  it('is the CASE that decides, not the driver: the driver adds nothing to the environment it is given', async () => {
    const { recordPath } = await runWithFake({
      workspaceCase: variant({ id: 'ws.fake.env-exact', environmentAllowlist: ['HOME'] }),
      lines: [resultLine()],
      // A PATH with `node` on it and nothing else of this machine: the fake is a Node script, and
      // a test that could not start it would prove nothing about what it was handed.
      environmentSource: { PATH: path.dirname(process.execPath), HOME: '/Users/somebody', LANG: 'en_GB.UTF-8' } as NodeJS.ProcessEnv,
    });
    const record = readRecord(recordPath);
    // Exactly the allow-list's intersection with what was on offer, plus the TMPDIR the runner points
    // at its own scratch directory. No CLAUDE_* variable, no injected token, nothing else.
    //
    // `__CF_USER_TEXT_ENCODING` IS THE OPERATING SYSTEM'S, NOT CERNUM'S, and it is named here rather
    // than filtered out of sight. macOS's CoreFoundation adds it to every process it starts; it
    // carries a user id and a text encoding, no authority and no secret, and nothing this engine
    // does can stop it arriving. A test that quietly dropped it would be a test that also dropped
    // the next variable something else started injecting.
    const OS_INJECTED = ['__CF_USER_TEXT_ENCODING'];
    expect(record.environmentNames.filter((name) => name !== 'TMPDIR' && !OS_INJECTED.includes(name)).sort())
      .toEqual(['HOME', 'LANG', 'PATH']);
    expect(record.environmentNames.some((name) => name.startsWith('CLAUDE'))).toBe(false);
  });
});

// 4 ─────────────────────────────────────────────────────────────────────────────────────────────
describe('4 · no credential of any kind reaches the agent child process', () => {
  it('withholds every provider key on this machine, whatever the case asked for', async () => {
    const { recordPath } = await runWithFake({
      workspaceCase: variant({ id: 'ws.fake.creds', environmentAllowlist: ['HOME'] }),
      lines: [resultLine()],
      environmentSource: {
        PATH: process.env.PATH,
        HOME: '/Users/somebody',
        ANTHROPIC_API_KEY: 'sk-ant-should-never-arrive',
        ANTHROPIC_AUTH_TOKEN: 'should-never-arrive',
        OPENAI_API_KEY: 'sk-openai-should-never-arrive',
        AWS_SECRET_ACCESS_KEY: 'should-never-arrive',
        GITHUB_TOKEN: 'ghp_should_never_arrive',
      } as NodeJS.ProcessEnv,
    });
    const record = readRecord(recordPath);
    for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'GITHUB_TOKEN']) {
      expect(record.environmentNames).not.toContain(name);
    }
    expect(JSON.stringify(record.environment)).not.toContain('should-never-arrive');
    expect(JSON.stringify(record.environment)).not.toContain('should_never_arrive');
  });

  it('refuses at authoring time a case that tries to unlock one', () => {
    expect(() => workspaceEnvironment({
      allowlist: ['ANTHROPIC_API_KEY'], temporaryDirectory: '/tmp/x',
      source: { ANTHROPIC_API_KEY: 'sk' } as NodeJS.ProcessEnv,
    })).toThrow(/credential-shaped/);
  });
});

// 5 ─────────────────────────────────────────────────────────────────────────────────────────────
describe('5 · everything the provider says is testimony, and is labelled as such', () => {
  it('marks every event derived from the stream `agentReported`, with no exception', () => {
    const messages = [
      initLine('/tmp/work'),
      assistantLine([
        { type: 'thinking', thinking: 'thinking out loud' },
        { type: 'text', text: 'narration' },
        { type: 'tool_use', id: 'a', name: 'Read', input: { file_path: 'src/stats.js' } },
        { type: 'tool_use', id: 'b', name: 'Write', input: { file_path: 'src/stats.js', content: 'x' } },
        { type: 'tool_use', id: 'c', name: 'Bash', input: { command: 'node test/stats.test.js && npm run lint' } },
        { type: 'tool_use', id: 'd', name: 'Grep', input: { pattern: 'mean' } },
      ]),
      toolResultLine('a', 'contents'),
      resultLine(),
    ];
    const produced = messages.flatMap((message) => eventsFromClaudeMessage(message as Record<string, unknown>));
    expect(produced.length).toBeGreaterThan(0);
    expect(produced.every((event) => event.provenance === 'agentReported')).toBe(true);
    // Not one engine-only kind, ever.
    for (const event of produced) {
      expect(['attemptStarted', 'attemptFinished', 'retryStarted', 'verificationRan', 'harnessFault', 'boundaryRefusal'])
        .not.toContain(event.kind);
    }
  });

  it('keeps that labelling through a whole run, where the engine adds its own observed events', async () => {
    const { result } = await runWithFake({
      lines: successfulStream('__CWD__'),
      writes: [{ path: 'src/stats.js', contents: CORRECT_STATS }],
    });
    const events = result.attempts[0].transcript.events;
    const fromProvider = events.filter((event) => ['message', 'toolCall', 'toolResult', 'fileRead', 'fileWrite', 'finalResponse'].includes(event.kind));
    expect(fromProvider.length).toBeGreaterThan(0);
    expect(fromProvider.every((event) => event.provenance === 'agentReported')).toBe(true);
    // The command the model asked for is testimony; the command the ENGINE ran is evidence.
    const commands = events.filter((event) => event.kind === 'commandExecuted');
    expect(commands.every((event) => event.provenance === 'agentReported')).toBe(true);
    const verifications = events.filter((event) => event.kind === 'verificationRan');
    expect(verifications.length).toBeGreaterThan(0);
    expect(verifications.every((event) => event.provenance === 'engineObserved')).toBe(true);
  });
});

// 6 ─────────────────────────────────────────────────────────────────────────────────────────────
describe('6 · a driver cannot forge an engine-only event', () => {
  it('drops a reported `verificationRan` and records the attempt as faulted instead', () => {
    const transcript = new TranscriptBuilder(0, () => 0);
    const event = transcript.emit('verificationRan', 'agentReported', 0, 'the tests passed, honestly', { ok: true });
    expect(event.kind).toBe('harnessFault');
    expect(event.provenance).toBe('engineObserved');
    expect(event.reason).toBe('forgedEngineEvent');
    const built = transcript.build();
    expect(built.summary.verificationRunCount).toBe(0);
    expect(built.summary.harnessFaultCount).toBe(1);
  });

  it('is what the translator is written to make impossible in the first place', () => {
    // Belt and braces: the translator has no branch that can produce another provenance, and the
    // builder would refuse it if it grew one.
    const events = eventsFromClaudeMessage(assistantLine([{ type: 'text', text: 'hello' }]) as Record<string, unknown>);
    expect(events.map((event) => event.provenance)).toEqual(['agentReported']);
  });
});

// 7 ─────────────────────────────────────────────────────────────────────────────────────────────
describe('7 · the final response is captured explicitly, once', () => {
  it('records the result message as the answer of record, not as the last narration', async () => {
    const { result } = await runWithFake({
      lines: successfulStream('__CWD__'),
      writes: [{ path: 'src/stats.js', contents: CORRECT_STATS }],
    });
    const attempt = result.attempts[0];
    expect(attempt.agent.finalMessage).toBe('I fixed the divisor in `mean` and re-ran the tests; all five pass.');
    const finals = attempt.transcript.events.filter((event) => event.kind === 'finalResponse');
    expect(finals).toHaveLength(1);
    expect(finals[0].provenance).toBe('agentReported');
    expect(finals[0].detail).toContain('fixed the divisor');
    // The narration before it is a `message`, and is not the answer.
    const lastMessage = [...attempt.transcript.events].reverse().find((event) => event.kind === 'message');
    expect(lastMessage?.detail).not.toBe(attempt.agent.finalMessage);
  });

  it('leaves it absent rather than inventing one when the tool stopped without answering', async () => {
    const { result } = await runWithFake({ lines: [initLine('__CWD__'), resultLine({ result: '' })] });
    expect(result.attempts[0].agent.finalMessage).toBeUndefined();
    expect(result.attempts[0].transcript.summary.finalResponseCount).toBe(0);
  });
});

// 8 ─────────────────────────────────────────────────────────────────────────────────────────────
describe('8 · tool calls and their results are parsed', () => {
  it('names each tool, digests its arguments, and never records them verbatim', () => {
    const events = eventsFromClaudeMessage(assistantLine([
      { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'src/stats.js', secret: 'sk-live-abcdef' } },
    ]) as Record<string, unknown>);
    const call = events.find((event) => event.kind === 'toolCall');
    expect(call?.payload.toolName).toBe('Read');
    expect(call?.payload.callID).toBe('toolu_1');
    expect(call?.payload.argumentsDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(events)).not.toContain('sk-live-abcdef');
  });

  it('pairs a result back to its call, and records whether the tool called it an error', () => {
    const ok = eventsFromClaudeMessage(toolResultLine('toolu_1', 'the file has been updated') as Record<string, unknown>);
    expect(ok[0].kind).toBe('toolResult');
    expect(ok[0].payload.callID).toBe('toolu_1');
    expect(ok[0].payload.ok).toBe(true);

    const failed = eventsFromClaudeMessage(toolResultLine('toolu_2', 'permission denied', true) as Record<string, unknown>);
    expect(failed[0].payload.ok).toBe(false);
    expect(failed[0].detail).toContain('permission denied');
  });

  it('counts them on the transcript summary of a real run', async () => {
    const { result } = await runWithFake({
      lines: successfulStream('__CWD__'),
      writes: [{ path: 'src/stats.js', contents: CORRECT_STATS }],
    });
    const summary = result.attempts[0].transcript.summary;
    expect(summary.toolCallCount).toBe(3);
    expect(summary.toolsUsed).toEqual(['Bash', 'Edit', 'Read']);
  });
});

// 9 ─────────────────────────────────────────────────────────────────────────────────────────────
describe('9 · command events are parsed out of the shell string this CLI reports', () => {
  it('splits a chained command on the operators that appear outside quotes', () => {
    expect(shellSegments('node test/stats.test.js && npm run lint')).toEqual(['node test/stats.test.js', 'npm run lint']);
    expect(shellSegments('grep "a && b" src')).toEqual(['grep "a && b" src']);
    expect(shellSegments("echo 'x; y' ; ls")).toEqual(["echo 'x; y'", 'ls']);
    expect(shellSegments('cat f | wc -l')).toEqual(['cat f', 'wc -l']);
  });

  it('keeps a redirection\'s & inside its command, so 2>&1 names no executable called "1"', () => {
    // THE REGRESSION. `node test/x.js 2>&1` was split at its `&` into `node test/x.js 2>` and `1`,
    // and the transcript reported an executable named `1`.
    expect(shellSegments('node test/stats.test.js 2>&1')).toEqual(['node test/stats.test.js 2>&1']);
    expect(commandInvocations('node test/stats.test.js 2>&1').map((entry) => entry.executable)).toEqual(['node']);
    expect(commandInvocations('node test/a.js 2>&1 | tail -5').map((entry) => entry.executable)).toEqual(['node', 'tail']);
    // Every descriptor-duplicating and both-stream form stays one command.
    for (const command of ['node a.js >&2', 'cat <&3', 'node a.js &>out.log', 'node a.js &>>out.log', 'node a.js 1>&2 2>&1']) {
      expect(shellSegments(command), command).toEqual([command]);
    }
    // And the separators it must still split on are still split on.
    expect(shellSegments('sleep 1 & node a.js')).toEqual(['sleep 1', 'node a.js']);
    expect(shellSegments('node a.js |& grep ok')).toEqual(['node a.js', 'grep ok']);
    expect(shellSegments('node a.js && node b.js 2>&1 || echo failed')).toEqual(['node a.js', 'node b.js 2>&1', 'echo failed']);
    expect(shellSegments("echo 'a & b' & ls")).toEqual(["echo 'a & b'", 'ls']);
  });

  it('names the executable of each segment, skipping leading environment assignments', () => {
    expect(commandInvocations('NODE_ENV=test node test/stats.test.js'))
      .toEqual([{ executable: 'node', argv: ['test/stats.test.js'] }]);
    expect(commandInvocations('node a.js && node b.js').map((entry) => entry.executable)).toEqual(['node', 'node']);
    expect(commandInvocations('   ')).toEqual([]);
  });

  it('emits one `commandExecuted` per named executable, with no exit status it did not see', () => {
    const events = eventsFromClaudeMessage(assistantLine([
      { type: 'tool_use', id: 'c', name: 'Bash', input: { command: 'node test/stats.test.js && npm run lint' } },
    ]) as Record<string, unknown>);
    const commands = events.filter((event) => event.kind === 'commandExecuted');
    expect(commands.map((event) => event.payload.executable)).toEqual(['node', 'npm']);
    // NOT zero. The tool had not run it yet, and an unknown status must not read as a pass.
    expect(commands.every((event) => event.payload.exitCode === undefined)).toBe(true);
  });

  it('feeds the case executable allow-list from what was named, and counts observed commands apart', async () => {
    const { result } = await runWithFake({
      lines: successfulStream('__CWD__'),
      writes: [{ path: 'src/stats.js', contents: CORRECT_STATS }],
    });
    const summary = result.attempts[0].transcript.summary;
    expect(summary.executablesInvoked).toContain('node');
    // The engine watched only its own verification run exit; the model's command it did not.
    expect(summary.observedCommandCount).toBe(0);
    expect(summary.commandCount).toBe(1);
  });
});

// 10 ────────────────────────────────────────────────────────────────────────────────────────────
describe('10 · file events are parsed where the tool names a path, and not where it does not', () => {
  it('reports a read and a write when the tool names the file', () => {
    const read = eventsFromClaudeMessage(assistantLine([
      { type: 'tool_use', id: 'a', name: 'Read', input: { file_path: 'src/stats.js' } },
    ]) as Record<string, unknown>);
    expect(read.find((event) => event.kind === 'fileRead')?.payload.path).toBe('src/stats.js');

    const write = eventsFromClaudeMessage(assistantLine([
      { type: 'tool_use', id: 'b', name: 'Write', input: { file_path: 'src/stats.js', content: 'abc' } },
    ]) as Record<string, unknown>);
    const event = write.find((entry) => entry.kind === 'fileWrite');
    expect(event?.payload.path).toBe('src/stats.js');
    expect(event?.payload.byteCount).toBe(3);
  });

  it('does NOT invent a path for Grep or Glob, which name a pattern and not a file', () => {
    const events = eventsFromClaudeMessage(assistantLine([
      { type: 'tool_use', id: 'g', name: 'Grep', input: { pattern: 'mean', output_mode: 'content' } },
      { type: 'tool_use', id: 'h', name: 'Glob', input: { pattern: '**/*.js' } },
    ]) as Record<string, unknown>);
    expect(events.filter((event) => event.kind === 'fileRead')).toHaveLength(0);
    expect(events.filter((event) => event.kind === 'toolCall')).toHaveLength(2);
  });
});

// 11 ────────────────────────────────────────────────────────────────────────────────────────────
describe('11 · usage is read through the parser the prose adapter already proved', () => {
  it('records the TOTAL input, the decomposition, the thinking tokens and the allowance', async () => {
    const { result } = await runWithFake({
      lines: successfulStream('__CWD__'),
      writes: [{ path: 'src/stats.js', contents: CORRECT_STATS }],
    });
    const usage = result.attempts[0].agent.usage!;
    // 7 fresh + 6,551 cache-creation + 128 cache-read. Reading the fresh remainder alone understated
    // this by ~950x on the prose side, and that correction is inherited rather than re-made.
    expect(usage.inputTokens).toBe(6_686);
    expect(usage.freshInputTokens).toBe(7);
    expect(usage.cacheCreationInputTokens).toBe(6_551);
    expect(usage.cacheReadInputTokens).toBe(128);
    expect(usage.visibleOutputTokens).toBe(452);
    expect(usage.reasoningTokens).toBe(81);
    // `total_cost_usd` on a subscription run is a LIST VALUATION of allowance, never a charge.
    expect(usage.subscriptionIncludedUsageMicroUSD).toBe(12_345);
    expect(usage.providerReportedTimeToFirstTokenMilliseconds).toBe(640);
    expect(usage.providerReportedDurationMilliseconds).toBe(4_210);
    expect(usage.observedFirstOutputMilliseconds).toBeTypeOf('number');
  });

  it('records an absence as an absence when the tool counted nothing', async () => {
    const { result } = await runWithFake({
      lines: [initLine('__CWD__'), resultLine({ usage: {}, modelUsage: {}, total_cost_usd: undefined })],
    });
    const usage = result.attempts[0].agent.usage!;
    expect(usage.inputTokens).toBeUndefined();
    expect(usage.visibleOutputTokens).toBeUndefined();
    expect(usage.subscriptionIncludedUsageMicroUSD).toBeUndefined();
  });
});

// 12 ────────────────────────────────────────────────────────────────────────────────────────────
describe('12 · the identity contract is the same one the prose path uses', () => {
  it('verifies a dated build against the alias that was requested', async () => {
    const { result } = await runWithFake({
      lines: [initLine('__CWD__'), resultLine()],
      requestedModelID: 'claude-haiku-4-5',
    });
    expect(result.attempts[0].agent.reportedModelID).toBe('claude-haiku-4-5-20251001');
    expect(result.attempts[0].agent.usage!.identityState).toBe('verified');
  });

  it('records a substitution rather than accepting it', async () => {
    const { result } = await runWithFake({
      lines: [initLine('__CWD__'), resultLine({
        modelUsage: { 'claude-sonnet-5': { canonicalModel: 'claude-sonnet-5', outputTokens: 900 } },
      })],
      requestedModelID: 'claude-haiku-4-5',
    });
    expect(result.attempts[0].agent.usage!.identityState).toBe('substituted');
    expect(result.attempts[0].agent.reportedModelID).toBe('claude-sonnet-5');
  });

  it('never copies the request back when the tool named nobody', async () => {
    const { result } = await runWithFake({
      lines: [initLine('__CWD__'), resultLine({ modelUsage: {} })],
      requestedModelID: 'claude-haiku-4-5',
    });
    expect(result.attempts[0].agent.usage!.identityState).toBe('unverifiable');
    expect(result.attempts[0].agent.reportedModelID).toBe('');
  });

  it('records every participant, including a model the tool used for its own housekeeping', async () => {
    const { result } = await runWithFake({
      lines: [initLine('__CWD__'), resultLine({
        modelUsage: {
          'claude-haiku-4-5-20251001': { canonicalModel: 'claude-haiku-4-5', outputTokens: 452 },
          'claude-3-5-haiku-20241022': { canonicalModel: 'claude-3-5-haiku', outputTokens: 12 },
        },
      })],
    });
    expect(result.attempts[0].agent.usage!.participantIDs)
      .toEqual(['claude-haiku-4-5-20251001', 'claude-3-5-haiku-20241022']);
  });
});

// 13 ────────────────────────────────────────────────────────────────────────────────────────────
describe('13 · a deadline is an unfinished measurement, and says so', () => {
  it('maps a timeout to `deadlineExceeded` and keeps everything reported up to it', async () => {
    const driver = new ClaudeWorkspaceDriver({
      requestedModelID: 'claude-haiku-4-5',
      executablePath: '/fake/claude',
      run: async (options: CLIRunOptions): Promise<CLIResult> => {
        options.onChunk?.(JSON.stringify(assistantLine([{ type: 'text', text: 'still working' }])) + '\n', 5);
        return {
          stdout: '', stderr: '', exitCode: null, signal: 'SIGKILL', elapsedMilliseconds: 60_000,
          failure: { kind: 'timeout', detail: 'the deadline passed' },
        };
      },
    });
    const transcript = new TranscriptBuilder(0, () => 0);
    const outcome = await driver.run(bareRequest({ workspaceRoot: temporary('cernum-ws-'), transcript }));
    expect(outcome.failure?.kind).toBe('timeout');
    expect(outcome.completed).toBe(false);
    // The narration that arrived before the deadline is still there.
    expect(outcome.events.filter((event) => event.kind === 'message')).toHaveLength(1);

    const { terminationReasonFor } = await import('../../src/engine/workspace-transcript');
    expect(terminationReasonFor(outcome.failure?.kind)).toBe('deadlineExceeded');
  });

  it('scores a timed-out attempt as `timeout`, with no metric pretending to be a reading', async () => {
    const workspaceCase = variant({ id: 'ws.fake.timeout' });
    const driver = new ClaudeWorkspaceDriver({
      requestedModelID: 'claude-haiku-4-5', executablePath: '/fake/claude',
      run: async (): Promise<CLIResult> => ({
        stdout: '', stderr: '', exitCode: null, signal: 'SIGKILL', elapsedMilliseconds: 60_000,
        failure: { kind: 'timeout', detail: 'the deadline passed' },
      }),
    });
    const result = await runWorkspaceCase({
      case: workspaceCase, driver, fixtureRoot: FIXTURE_ROOT, sandboxRoot: temporary('cernum-ws-sandbox-'),
    });
    expect(result.attempts[0].terminationReason).toBe('deadlineExceeded');
    const card = scoreWorkspaceRun(workspaceCase, result);
    expect(card.status).toBe('timeout');
    expect(card.metricsMilli.taskSuccess.valueMilli).toBeUndefined();
    expect(card.metricsMilli.taskSuccess.unavailableReason).toContain('timeout');
  });
});

// 14 ────────────────────────────────────────────────────────────────────────────────────────────
describe('14 · a provider refusal is never scored as a model failure', () => {
  const refusalCase = () => variant({ id: 'ws.fake.refusal' });

  async function withResult(cliResult: Partial<CLIResult>) {
    const workspaceCase = refusalCase();
    const driver = new ClaudeWorkspaceDriver({
      requestedModelID: 'claude-haiku-4-5', executablePath: '/fake/claude',
      run: async (): Promise<CLIResult> => ({
        stdout: '', stderr: '', exitCode: 0, signal: null, elapsedMilliseconds: 10, ...cliResult,
      }),
    });
    const result = await runWorkspaceCase({
      case: workspaceCase, driver, fixtureRoot: FIXTURE_ROOT, sandboxRoot: temporary('cernum-ws-sandbox-'),
    });
    return { result, card: scoreWorkspaceRun(workspaceCase, result) };
  }

  it('reads the documented envelope before the exit code, so a 404 is not an opaque transport fault', async () => {
    const { result } = await withResult({
      stdout: JSON.stringify(resultLine({
        is_error: true, api_error_status: 404, terminal_reason: 'api_error', modelUsage: {},
        result: 'model: claude-nope not found',
      })) + '\n',
      exitCode: 1,
      failure: { kind: 'exitFailure', detail: 'exit 1' },
    });
    expect(result.attempts[0].agent.failure?.kind).toBe('transport');
    expect(result.attempts[0].agent.failure?.detail).toContain('404');
    expect(result.attempts[0].agent.failure?.detail).toContain('api_error');
  });

  it('flags a 429 as the provider declining, so the campaign aborts rather than recording a failure', async () => {
    const { result, card } = await withResult({
      stdout: JSON.stringify(resultLine({ is_error: true, api_error_status: 429, terminal_reason: 'rate_limit', modelUsage: {}, result: 'rate limited' })) + '\n',
      exitCode: 1, failure: { kind: 'exitFailure', detail: 'exit 1' },
    });
    expect(result.attempts[0].agent.failure?.kind).toBe('rateLimited');
    expect(result.attempts[0].terminationReason).toBe('providerDeclined');
    expect(card.providerThrottled).toBe(true);
    expect(card.status).toBe('runtimeError');
  });

  it('flags a 401 as an expired session, never as a wrong answer', async () => {
    const { result, card } = await withResult({
      stdout: JSON.stringify(resultLine({ is_error: true, api_error_status: 401, terminal_reason: 'auth', modelUsage: {}, result: 'please log in' })) + '\n',
      exitCode: 1, failure: { kind: 'exitFailure', detail: 'exit 1' },
    });
    expect(result.attempts[0].agent.failure?.kind).toBe('notAuthenticated');
    expect(card.providerThrottled).toBe(true);
  });

  it('refuses to scrape an unrecognised format rather than guessing at it', async () => {
    const { result, card } = await withResult({ stdout: 'Claude Code is thinking about it.\n' });
    expect(result.attempts[0].agent.failure?.kind).toBe('malformedOutput');
    expect(card.status).toBe('runtimeError');
  });

  it('catches an effort level the CLI warned it was ignoring, which makes the binding false', async () => {
    const { result, card } = await withResult({
      stdout: JSON.stringify(resultLine()) + '\n',
      stderr: "Warning: Unknown --effort value 'ultra' — ignoring it and using the default effort.\n",
    });
    expect(result.attempts[0].agent.failure?.kind).toBe('policyNotExpressible');
    expect(card.status).toBe('envelopeFailure');
  });

  it('refuses when the tool reports a working directory that is not the workspace', async () => {
    const { result, card } = await withResult({
      stdout: [JSON.stringify(initLine('/Users/somebody/some-other-project')), JSON.stringify(resultLine())].join('\n') + '\n',
    });
    expect(result.attempts[0].agent.failure?.kind).toBe('policyNotExpressible');
    expect(result.attempts[0].agent.failure?.detail).toContain('some-other-project');
    expect(card.status).toBe('envelopeFailure');
  });

  it('reports a missing CLI as not installed rather than as a model that could not do it', async () => {
    const driver = new ClaudeWorkspaceDriver({
      requestedModelID: 'claude-haiku-4-5', findExecutable: () => undefined,
    });
    const outcome = await driver.run(bareRequest({ workspaceRoot: temporary('cernum-ws-') }));
    expect(outcome.failure?.kind).toBe('notInstalled');
  });
});

// 15 ────────────────────────────────────────────────────────────────────────────────────────────
describe('15 · nothing the driver does can reach the fixture or anything outside the workspace', () => {
  it('leaves the sealed fixture byte-for-byte identical after a run that rewrote its copy', async () => {
    const before = snapshotTree(FIXTURE_SOURCE, { capturedAt: 'x' });
    expect(before.treeDigest).toBe(BROKEN_SUM_MEAN.source.expectedTreeDigest);

    await runWithFake({
      lines: successfulStream('__CWD__'),
      writes: [
        { path: 'src/stats.js', contents: CORRECT_STATS },
        { path: 'src/extra.js', contents: '// scratch\n' },
      ],
    });

    const after = snapshotTree(FIXTURE_SOURCE, { capturedAt: 'x' });
    expect(after.treeDigest).toBe(before.treeDigest);
  });

  it('fails the attempt as a workspace escape when something outside the work tree changed', async () => {
    // The fake writes into `../baseline`, which nothing is ever handed. The engine re-digests that
    // copy after the attempt, so this is caught by observation rather than by a claim.
    const { result, card } = await runWithFake({
      lines: [initLine('__CWD__'), resultLine()],
      writes: [{ path: '../baseline/src/stats.js', contents: '// reached outside\n' }],
    });
    expect(result.attempts[0].harnessFault?.code).toBe('workspaceEscape');
    expect(result.attempts[0].terminationReason).toBe('workspaceEscape');
    expect(card.status).toBe('safetyAbort');
  });
});

// 16 ────────────────────────────────────────────────────────────────────────────────────────────
describe('16 · the verdict comes from the tree, never from what Claude said about it', () => {
  it('scores a run that narrates a complete fix and changes nothing exactly as one that does nothing', async () => {
    const { result, card } = await runWithFake({
      // Every tool call, every confident result, and not one byte written.
      lines: successfulStream('__CWD__'),
      writes: [],
    });
    const attempt = result.attempts[0];
    expect(attempt.agent.completed).toBe(true);
    expect(attempt.agent.finalMessage).toContain('all five pass');
    // The engine's own reading disagrees, and the engine's reading is the one that counts.
    expect(attempt.diff.clean).toBe(true);
    expect(attempt.verificationOutcomes[0].passed).toBe(false);
    expect(card.status).toBe('behavioralFailure');
    expect(card.metricsMilli.taskSuccess.valueMilli).toBe(0);
  });

  it('scores the real patch when there is one, and reads it off the tree rather than off the stream', async () => {
    const { result, card } = await runWithFake({
      lines: successfulStream('__CWD__'),
      writes: [{ path: 'src/stats.js', contents: CORRECT_STATS }],
    });
    const attempt = result.attempts[0];
    expect(attempt.diff.changedPaths).toEqual(['src/stats.js']);
    expect(attempt.patch.text).toContain('values.length');
    expect(attempt.baselineOutcomes[0].passed).toBe(false);
    expect(attempt.verificationOutcomes[0].passed).toBe(true);
    expect(card.status).toBe('pass');
    expect(card.transitions[0].transition).toBe('fixed');
  });

  it('catches the shortcut — editing the test — as a scope failure even when every check then passes', async () => {
    const { result, card } = await runWithFake({
      lines: successfulStream('__CWD__'),
      writes: [{ path: 'test/stats.test.js', contents: 'process.exit(0);\n' }],
    });
    expect(result.attempts[0].scope.clean).toBe(false);
    expect(card.status).toBe('scopeFailure');
  });
});

// 17 ────────────────────────────────────────────────────────────────────────────────────────────
describe('17 · the declared capabilities are the installed CLI\'s, not the harness\'s wishes', () => {
  it('does not claim a network control this CLI has no switch for', () => {
    expect(CLAUDE_WORKSPACE_CAPABILITIES.expressesNetworkPolicy).toBe(false);
    const driver = new ClaudeWorkspaceDriver({ requestedModelID: 'm', executablePath: '/fake/claude' });
    const shortfalls = driverShortfalls(driver, ALL_TOOLS, 'denied');
    expect(shortfalls).toHaveLength(1);
    expect(shortfalls[0]).toContain('no network switch');
  });

  it('runs a case that only DECLARES provider-only access, and records the gap on every attempt', async () => {
    const driver = new ClaudeWorkspaceDriver({ requestedModelID: 'm', executablePath: '/fake/claude' });
    expect(driverShortfalls(driver, ALL_TOOLS, 'providerOnly')).toEqual([]);
    const { result } = await runWithFake({ lines: [initLine('__CWD__'), resultLine()] });
    const notEnforced = result.attempts[0].agent.notEnforceable.join(' ');
    expect(notEnforced).toContain('no network switch');
    expect(notEnforced).toContain('does not confine Bash');
    expect(result.attempts[0].agent.activeIsolation.join(' ')).toContain('--restricted');
  });

  it('records what the CLI itself said its session was, beside what Cernum asked for', async () => {
    const { result } = await runWithFake({ lines: successfulStream('__CWD__') });
    const isolation = result.attempts[0].agent.activeIsolation.join('\n');
    expect(isolation).toContain('permission mode dontAsk');
    expect(isolation).toContain('version 2.1.278');
    expect(isolation).toContain('0 MCP server(s)');
  });

  it('reads the init message without mistaking another system message for one', () => {
    expect(readSessionInit(initLine('/tmp/x') as Record<string, unknown>)?.cwd).toBe('/tmp/x');
    expect(readSessionInit({ type: 'system', subtype: 'compact_boundary' })).toBeUndefined();
    expect(readSessionInit(resultLine() as unknown as Record<string, unknown>)).toBeUndefined();
  });

  it('ignores a line that is not a JSON object rather than calling the stream malformed', () => {
    expect(parseClaudeStreamLine('')).toBeUndefined();
    expect(parseClaudeStreamLine('Warning: something')).toBeUndefined();
    expect(parseClaudeStreamLine('[1,2]')).toBeUndefined();
    expect(parseClaudeStreamLine('{"type":"result"}')).toEqual({ type: 'result' });
  });
});

// MARK: - A minimal request, for the tests that exercise the driver alone

function bareRequest(overrides: { workspaceRoot: string; transcript?: TranscriptBuilder }) {
  return {
    caseID: 'ws.bare', caseVersion: '1', caseDigest: 'cwc1:x', attemptIndex: 0, maximumAttempts: 1,
    instruction: 'do the thing',
    workspaceRoot: overrides.workspaceRoot,
    scope: { allowed: [], forbidden: [] },
    tools: ALL_TOOLS,
    networkPolicy: 'providerOnly' as const,
    environment: { PATH: process.env.PATH ?? '' },
    timeoutMilliseconds: 1_000,
    transcript: overrides.transcript ?? new TranscriptBuilder(0, () => 0),
  };
}
