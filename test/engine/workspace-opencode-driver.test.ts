// The OpenCode workspace driver, held to the same host contracts as the Claude and Codex ones, with NO
// request leaving this machine.
//
// WHERE THE STREAMS COME FROM. The `step_start`, `text` and `step_finish` lines are the CAPTURED bytes in
// `fixtures/opencode-run-json.ts` — the one live OpenCode reply this repository holds. The `tool_use` lines
// are built to the SDK's DECLARED `ToolPart` type (`@opencode-ai/sdk` 1.18.31, `types.gen.d.ts`), because
// no captured reply carries a tool call; the driver says so on every attempt and this file says so here.
//
// TWO KINDS OF TEST, as on the other two drivers: a fake `opencode` on disk, spawned for real, for every
// claim about the CHILD PROCESS — argv, cwd, environment, stdin — and an injected `run` for every claim
// about READING what came back.

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CLIResult, CLIRunOptions } from '../../src/engine/cli-process';
import { BROKEN_SUM_MEAN } from '../../src/engine/workspace-catalog';
import { ToolPolicy, WorkspaceCase, fileInvariant, makeWorkspaceCase, workspaceCommand } from '../../src/engine/workspace-case';
import { driverShortfalls } from '../../src/engine/workspace-agent';
import { runWorkspaceCase } from '../../src/engine/workspace-execution';
import { scoreWorkspaceRun } from '../../src/engine/workspace-scoring';
import { TranscriptBuilder, terminationReasonFor } from '../../src/engine/workspace-transcript';
import { buildWorkspaceDriver, providersWithWorkspaceDriver } from '../../src/engine/host-factory';
import { ProviderBindingError, validateBinding } from '../../src/engine/provider';
import { buildWorkspaceBinding } from '../../src/engine/workspace-binding';
import { publishedPriceFor, snapshotFor } from '../../src/engine/opencode-pricing';
import { costEligibilityFor } from '../../src/engine/cost-eligibility';
import { MATRIX_IDENTITY_LIMITATIONS } from '../../src/engine/workspace-matrix-admission';
import { WorkspaceRoutingHost } from '../../src/engine/workspace-host';
import { SpendTracker } from '../../src/engine/spending';
import {
  OPENCODE_WORKSPACE_CAPABILITIES, OPENCODE_WORKSPACE_CLI_VERSION_VERIFIED_AGAINST, OPENCODE_WORKSPACE_DRIVER_ID,
  OPENCODE_WORKSPACE_IDENTITY_LIMITATION, OpenCodeWorkspaceDriver, buildOpenCodeWorkspaceArguments,
  classifyOpenCodeWorkspaceError, eventsFromOpenCodeEvent, newOpenCodeStreamState, openCodeWorkspaceUsage,
  parseOpenCodeStreamLine,
} from '../../src/engine/workspace-opencode-driver';
import { OPENCODE_BIG_PICKLE_CAPTURED_STDOUT, capturedLine } from './fixtures/opencode-run-json';
import { FIXTURE_ANTHROPIC_KEY } from '../secret-fixtures';

const FIXTURE_ROOT = path.resolve(__dirname, '../../fixtures');
const MODEL = 'opencode/big-pickle';

const temporaries: string[] = [];
afterEach(() => { for (const directory of temporaries.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
function temporary(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaries.push(directory);
  return directory;
}

const ALL_TOOLS: ToolPolicy = { fileRead: true, fileWrite: true, commandExecution: true, allowedExecutables: [] };

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

// MARK: - Stream lines

const SESSION = 'ses_000000000000FIXTUREfixture';
const toolUse = (callID: string, tool: string, input: Record<string, unknown>, status: 'running' | 'completed' | 'error',
                 output = '') => ({
  type: 'tool_use', timestamp: 1789929250100, sessionID: SESSION,
  part: {
    id: `prt_${callID}`, sessionID: SESSION, messageID: 'msg_x', type: 'tool', callID, tool,
    state: status === 'completed' ? { status, input, output, title: tool, metadata: {}, time: { start: 1, end: 2 } }
      : status === 'error' ? { status, input, error: output, time: { start: 1, end: 2 } }
        : { status, input, time: { start: 1 } },
  },
});
const stepFinish = (id: string, tokens: { input: number; output: number; reasoning: number; read: number; write: number }, cost = 0) => ({
  type: 'step_finish', timestamp: 1789929250630, sessionID: SESSION,
  part: { id, reason: 'stop', messageID: 'msg_x', sessionID: SESSION, type: 'step-finish',
    tokens: { total: tokens.input + tokens.output + tokens.reasoning + tokens.read, input: tokens.input, output: tokens.output,
      reasoning: tokens.reasoning, cache: { write: tokens.write, read: tokens.read } }, cost },
});
const errorEvent = (name: string, message: string, statusCode?: number) => ({
  type: 'error', timestamp: 1, sessionID: SESSION, error: { name, data: { message, ...(statusCode === undefined ? {} : { statusCode }) } },
});

function workingStream(): unknown[] {
  return [
    JSON.parse(capturedLine('step_start')),
    toolUse('call_1', 'read', { filePath: 'src/stats.js' }, 'completed', 'function mean(values) {…}'),
    toolUse('call_2', 'bash', { command: 'node test/stats.test.js' }, 'completed', '2/5 passed'),
    toolUse('call_3', 'edit', { filePath: 'src/stats.js', oldString: 'values.length + 1', newString: 'values.length' }, 'completed', 'ok'),
    stepFinish('prt_step_1', { input: 6141, output: 120, reasoning: 40, read: 1792, write: 0 }),
    JSON.parse(capturedLine('step_start')),
    JSON.parse(capturedLine('text')),
    JSON.parse(capturedLine('step_finish')),
  ];
}

function fakeOpenCode(options: {
  recordPath: string; lines: unknown[]; writes?: { path: string; contents: string }[]; exitCode?: number;
  stderr?: string; version?: string;
}): string {
  const directory = temporary('cernum-fake-opencode-');
  const executable = path.join(directory, 'opencode');
  const script = `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
if (process.argv[2] === '--version') { process.stdout.write(${JSON.stringify(`${options.version ?? OPENCODE_WORKSPACE_CLI_VERSION_VERIFIED_AGAINST}\n`)}); process.exit(0); }
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { stdin += chunk; });
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(options.recordPath)}, JSON.stringify({
    argv: process.argv.slice(2), cwd: process.cwd(), environment: process.env, stdin,
  }));
  for (const write of ${JSON.stringify(options.writes ?? [])}) {
    const target = path.resolve(process.cwd(), write.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, write.contents);
  }
  for (const line of ${JSON.stringify(options.lines)}) process.stdout.write(JSON.stringify(line) + '\\n');
  ${options.stderr === undefined ? '' : `process.stderr.write(${JSON.stringify(options.stderr)});`}
  process.exit(${options.exitCode ?? 0});
});
`;
  fs.writeFileSync(executable, script, { mode: 0o755 });
  return executable;
}

function variant(overrides: { id?: string; tools?: Partial<ToolPolicy>; networkPolicy?: WorkspaceCase['execution']['networkPolicy'] } = {}): WorkspaceCase {
  return makeWorkspaceCase({
    id: overrides.id ?? 'ws.fake.opencode',
    version: '1',
    suiteID: BROKEN_SUM_MEAN.suiteID,
    suiteVersion: BROKEN_SUM_MEAN.suiteVersion,
    dimensions: ['multiFileEditing'],
    source: { fixturePath: 'workspace/broken-sum', expectedTreeDigest: BROKEN_SUM_MEAN.source.expectedTreeDigest },
    task: { instruction: BROKEN_SUM_MEAN.task.instruction, scope: { allowed: ['src/**'], forbidden: ['test/**'] } },
    execution: {
      timeoutMilliseconds: 60_000, maximumAttempts: 1,
      tools: { ...ALL_TOOLS, ...overrides.tools },
      networkPolicy: overrides.networkPolicy ?? 'providerOnly',
      environmentAllowlist: ['HOME', 'USER'],
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
  lines: unknown[]; writes?: { path: string; contents: string }[]; exitCode?: number; stderr?: string;
  version?: string; environmentSource?: NodeJS.ProcessEnv; workspaceCase?: WorkspaceCase;
}) {
  const recordPath = path.join(temporary('cernum-record-'), 'child.json');
  const executablePath = fakeOpenCode({ recordPath, ...options });
  const workspaceCase = options.workspaceCase ?? variant();
  const driver = new OpenCodeWorkspaceDriver({ requestedModelID: MODEL, effort: 'none', executablePath });
  const result = await runWorkspaceCase({
    case: workspaceCase, driver, fixtureRoot: FIXTURE_ROOT, sandboxRoot: temporary('cernum-ws-sandbox-'),
    environmentSource: options.environmentSource
      ?? { PATH: process.env.PATH, HOME: process.env.HOME, USER: process.env.USER ?? 'someone' } as NodeJS.ProcessEnv,
  });
  const record = fs.existsSync(recordPath)
    ? JSON.parse(fs.readFileSync(recordPath, 'utf8')) as { argv: string[]; cwd: string; environment: Record<string, string>; stdin: string }
    : undefined;
  return { result, record, card: scoreWorkspaceRun(workspaceCase, result) };
}

function injected(result: Partial<CLIResult>, version = OPENCODE_WORKSPACE_CLI_VERSION_VERIFIED_AGAINST) {
  const calls: CLIRunOptions[] = [];
  const driver = new OpenCodeWorkspaceDriver({
    requestedModelID: MODEL, effort: 'none', executablePath: '/fake/opencode',
    version: async () => version,
    run: async (options) => { calls.push(options); return { stdout: '', stderr: '', exitCode: 0, signal: null, elapsedMilliseconds: 10, ...result }; },
  });
  return { driver, calls };
}

function bareRequest(overrides: { environment?: Record<string, string>; tools?: ToolPolicy } = {}) {
  const root = temporary('cernum-ws-');
  return {
    caseID: 'ws.bare', caseVersion: '1', caseDigest: 'cwc1:x', attemptIndex: 0, maximumAttempts: 1,
    instruction: 'do the thing', workspaceRoot: root, scope: { allowed: [], forbidden: [] },
    tools: overrides.tools ?? ALL_TOOLS, networkPolicy: 'providerOnly' as const,
    environment: overrides.environment ?? { PATH: process.env.PATH ?? '', TMPDIR: temporary('cernum-scratch-') },
    timeoutMilliseconds: 1_000, transcript: new TranscriptBuilder(0, () => 0),
  };
}

const text = (events: unknown[]) => events.map((event) => JSON.stringify(event)).join('\n') + '\n';

// 1 ─────────────────────────────────────────────────────────────────────────────────────────────
describe('1 · the driver exists, and only as a workspace driver for opencodeCLI', () => {
  it('is built by the registry under its own identity, and declares what it can and cannot do', () => {
    const driver = buildWorkspaceDriver({ provider: 'opencodeCLI', requestedModelID: MODEL, effort: 'none' });
    expect(driver?.driverID).toBe(OPENCODE_WORKSPACE_DRIVER_ID);
    expect(driver?.driverID).toBe('driver.opencode-cli.workspace');
    expect(providersWithWorkspaceDriver()).toContain('opencodeCLI');
    expect(OPENCODE_WORKSPACE_CAPABILITIES.reportsModelIdentity).toBe(false);
    expect(OPENCODE_WORKSPACE_CAPABILITIES.expressesNetworkPolicy).toBe(false);
    expect(OPENCODE_WORKSPACE_CAPABILITIES.commandExecutionScope).toBe('modelChosen');
    // Every sealed catalogue case asks for all three tools and providerOnly: nothing is refused for shape.
    expect(driverShortfalls(driver!, BROKEN_SUM_MEAN.execution.tools, BROKEN_SUM_MEAN.execution.networkPolicy)).toEqual([]);
  });

  it('refuses before spawning when the CLI is not installed', async () => {
    const driver = new OpenCodeWorkspaceDriver({ requestedModelID: MODEL, findExecutable: () => undefined });
    const result = await driver.run(bareRequest());
    expect(result.failure?.kind).toBe('notInstalled');
    expect(terminationReasonFor(result.failure?.kind)).toBe('driverUnavailable');
  });
});

// 2 ─────────────────────────────────────────────────────────────────────────────────────────────
describe('2 · the exact requested model is what is sent, and the instruction goes on stdin', () => {
  it('names the model with --model, roots to the workspace, sends nothing extra, and never --auto', async () => {
    const { record, result } = await runWithFake({ lines: workingStream(), writes: [{ path: 'src/stats.js', contents: CORRECT_STATS }] });
    expect(record).toBeDefined();
    const argv = record!.argv;
    expect(argv[0]).toBe('run');
    expect(argv[argv.indexOf('--model') + 1]).toBe(MODEL);
    expect(argv).toContain('--pure');
    expect(argv).not.toContain('--auto');
    expect(argv).not.toContain('--variant');
    const unprivate = (value: string) => value.replace(/^\/private/, '');
    expect(unprivate(argv[argv.indexOf('--dir') + 1])).toBe(unprivate(record!.cwd));
    expect(path.basename(record!.cwd)).toBe('work');
    expect(record!.stdin).toContain(BROKEN_SUM_MEAN.task.instruction.slice(0, 40));
    expect(argv.join(' ')).not.toContain(BROKEN_SUM_MEAN.task.instruction.slice(0, 40));
    expect(result.attempts[0].agent.failure).toBeUndefined();
  });

  it('pins small_model to the requested model so no housekeeping request reaches another one', () => {
    const plan = buildOpenCodeWorkspaceArguments({ tools: ALL_TOOLS, networkPolicy: 'providerOnly', requestedModelID: MODEL,
      workspaceRoot: '/w', scratchDirectory: '/s', caseID: 'c' });
    expect(plan.configuration.model).toBe(MODEL);
    expect(plan.configuration.small_model).toBe(MODEL);
    expect(plan.args).toContain('--title');
  });

  it('refuses an identifier that is not provider/model, rather than letting a config default answer', async () => {
    const plan = buildOpenCodeWorkspaceArguments({ tools: ALL_TOOLS, networkPolicy: 'providerOnly', requestedModelID: 'big-pickle',
      workspaceRoot: '/w', scratchDirectory: '/s', caseID: 'c' });
    expect(plan.unexpressed.join(' ')).toContain('provider/model');
  });
});

// 3 ─────────────────────────────────────────────────────────────────────────────────────────────
describe('3 · identity stays UNVERIFIABLE: nothing in the request, the stream or the listing is copied into it', () => {
  it('reports no model for a --format json stream, even though the model was named in argv', async () => {
    const { result } = await runWithFake({ lines: workingStream(), writes: [{ path: 'src/stats.js', contents: CORRECT_STATS }] });
    const attempt = result.attempts[0];
    expect(attempt.agent.reportedModelID).toBe('');
    expect((attempt.agent.usage as { identityState?: string }).identityState).toBe('unverifiable');
    expect(attempt.agent.notEnforceable).toContain(OPENCODE_WORKSPACE_IDENTITY_LIMITATION);
    expect(OPENCODE_WORKSPACE_IDENTITY_LIMITATION).toContain('cannot DETECT substitution');
  });

  it('keeps a substitution VISIBLE and refuses the attempt, should a stream ever name another model', async () => {
    const substituted = { type: 'message.updated', properties: { info: { role: 'assistant', providerID: 'opencode', modelID: 'other-model' } } };
    const { driver } = injected({ stdout: text([...workingStream(), substituted]) });
    const result = await driver.run(bareRequest());
    expect(result.failure?.kind).toBe('policyNotExpressible');
    expect(result.reportedModelID).toBe('opencode/other-model');
    expect(result.failure?.detail).toContain('opencode/other-model');
  });
});

// 4 ─────────────────────────────────────────────────────────────────────────────────────────────
describe('4 · admission boundaries: OpenCode gets its OWN sealed limitation, and a binding is still refused without one', () => {
  it('seals OpenCode\'s limitation, not Codex\'s, in a matrix admission', () => {
    expect(MATRIX_IDENTITY_LIMITATIONS.opencodeCLI).toBe(OPENCODE_WORKSPACE_IDENTITY_LIMITATION);
    expect(MATRIX_IDENTITY_LIMITATIONS.codexCLI).not.toBe(OPENCODE_WORKSPACE_IDENTITY_LIMITATION);
  });

  it('refuses a workspace binding for an unproven, unadmitted OpenCode route', () => {
    expect(() => buildWorkspaceBinding({
      candidate: 'opencodeCLI:opencode/big-pickle', provider: 'opencodeCLI', modelID: MODEL, effort: 'none',
      timeoutMilliseconds: 60_000, identity: { state: 'unverifiable', verifiedModelID: '', evidence: 'nothing', resolvedFrom: 'nothing' },
    })).toThrow(/has not been proven callable/);
  });
});

// 5 ─────────────────────────────────────────────────────────────────────────────────────────────
describe('5 · JSON parsing: the captured envelope and the declared tool parts', () => {
  it('reads the captured envelope\'s tokens, text and finish exactly', () => {
    const state = newOpenCodeStreamState();
    for (const line of OPENCODE_BIG_PICKLE_CAPTURED_STDOUT.split('\n')) {
      const event = parseOpenCodeStreamLine(line);
      if (event) eventsFromOpenCodeEvent(event, state);
    }
    const usage = openCodeWorkspaceUsage(state, MODEL, '');
    expect(usage?.freshInputTokens).toBe(6141);
    expect(usage?.cacheReadInputTokens).toBe(1792);
    // Every input-side token, the quantity a charge is computed from: 6141 + 1792 + 0.
    expect(usage?.inputTokens).toBe(7933);
    expect(usage?.visibleOutputTokens).toBe(3);
    expect(usage?.reasoningTokens).toBe(0);
    expect(usage?.numTurns).toBe(1);
    expect((usage?.rawUsage as Record<string, unknown>).openCodeReportedCostUnitUnverified).toBe(0);
    expect([...state.textByPartID.values()].join('')).toBe('ok');
  });

  it('turns declared tool parts into agentReported tool calls, file events and commands — once per call', () => {
    const state = newOpenCodeStreamState();
    const planned = [
      toolUse('c1', 'read', { filePath: 'src/stats.js' }, 'running'),
      toolUse('c1', 'read', { filePath: 'src/stats.js' }, 'completed', 'contents'),
      toolUse('c2', 'bash', { command: 'node test/stats.test.js && echo done' }, 'completed', 'ok'),
      toolUse('c3', 'write', { filePath: 'src/new.js', content: 'x' }, 'error', 'denied'),
    ].flatMap((event) => eventsFromOpenCodeEvent(event as never, state));
    expect(planned.every((event) => event.provenance === 'agentReported')).toBe(true);
    expect(planned.filter((event) => event.kind === 'toolCall')).toHaveLength(3);
    expect(planned.find((event) => event.kind === 'fileRead')?.payload.path).toBe('src/stats.js');
    expect(planned.filter((event) => event.kind === 'commandExecuted').map((event) => event.payload.executable)).toEqual(['node', 'echo']);
    expect(planned.find((event) => event.kind === 'fileWrite')?.payload.path).toBe('src/new.js');
    expect(planned.filter((event) => event.kind === 'toolResult').map((event) => event.payload.ok)).toEqual([true, true, false]);
  });

  it('refuses a clean exit with no step-finish as malformed, never scraping', async () => {
    const { driver } = injected({ stdout: 'hello, I fixed it\n' });
    expect((await driver.run(bareRequest())).failure?.kind).toBe('malformedOutput');
  });
});

// 6/7 ───────────────────────────────────────────────────────────────────────────────────────────
describe('6 · 7 · the patch is judged from the tree and the verdict from Cernum\'s own sealed checks', () => {
  it('passes a correct edit on the engine\'s verification, whatever the agent said', async () => {
    const { result, card } = await runWithFake({ lines: workingStream(), writes: [{ path: 'src/stats.js', contents: CORRECT_STATS }] });
    const attempt = result.attempts[0];
    expect(attempt.diff.changedPaths).toEqual(['src/stats.js']);
    expect(attempt.verificationOutcomes[0].passed).toBe(true);
    // The verifier ran under Cernum's OS sandbox, not the agent's say-so.
    expect(attempt.verificationOutcomes[0].executionSandbox).toMatch(/^cernum-seatbelt-1:/);
    expect(card.status).toBe('pass');
  });

  it('fails an agent that CLAIMS success and changes nothing', async () => {
    const { card, result } = await runWithFake({ lines: workingStream() });
    expect(result.attempts[0].agent.failure).toBeUndefined();
    expect(result.attempts[0].verificationOutcomes[0].passed).toBe(false);
    expect(card.status).not.toBe('pass');
  });

  it('records a scope violation in test/ from the tree, not from the stream', async () => {
    const { result } = await runWithFake({ lines: workingStream(),
      writes: [{ path: 'src/stats.js', contents: CORRECT_STATS }, { path: 'test/stats.test.js', contents: '// gutted' }] });
    expect(result.attempts[0].scope.clean).toBe(false);
  });
});

// 8/9 ───────────────────────────────────────────────────────────────────────────────────────────
describe('8 · 9 · a provider decline and an exhausted allowance are the provider\'s, never the model\'s', () => {
  it('reads ProviderAuthError and a 403 as notAuthenticated — a decline, not a transport fault', async () => {
    const { driver } = injected({ stdout: text([errorEvent('ProviderAuthError', 'no credential for opencode')]), exitCode: 1,
      failure: { kind: 'exitFailure', detail: 'exit 1' } });
    const result = await driver.run(bareRequest());
    expect(result.failure?.kind).toBe('notAuthenticated');
    expect(terminationReasonFor(result.failure?.kind)).toBe('providerDeclined');
    expect(classifyOpenCodeWorkspaceError({ name: 'APIError', message: 'forbidden', statusCode: 403 })).toBe('notAuthenticated');
  });

  it('reads a 429 and a free-tier allowance message as rateLimited', async () => {
    const { driver } = injected({ stdout: text([errorEvent('APIError', 'Rate limit exceeded for free tier, try again in 60s', 429)]),
      exitCode: 1, failure: { kind: 'exitFailure', detail: 'exit 1' } });
    const result = await driver.run(bareRequest());
    expect(result.failure?.kind).toBe('rateLimited');
    expect(terminationReasonFor(result.failure?.kind)).toBe('providerDeclined');
    expect(classifyOpenCodeWorkspaceError({ name: 'APIError', message: 'You have exceeded your usage limit' })).toBe('rateLimited');
  });

  it('reads the envelope\'s error BEFORE the exit code', async () => {
    const { driver } = injected({ stdout: text([errorEvent('APIError', 'model not available', 404)]), exitCode: 1,
      failure: { kind: 'exitFailure', detail: 'exit 1' } });
    const result = await driver.run(bareRequest());
    expect(result.failure?.detail).toContain('HTTP 404');
  });
});

// 10 ────────────────────────────────────────────────────────────────────────────────────────────
describe('10 · free-cost classification: a published $0 is a list price, and only a signed observation is free', () => {
  const confirmation = {
    provider: 'opencodeCLI' as const, modelID: MODEL, accountBasis: 'the OpenCode Zen credential on this machine',
    observedBillingRecord: 'OpenCode Zen account usage page, statement for September 2026, line for big-pickle: $0.00',
    observedAt: '2026-09-21T10:00:00Z', confirmedBy: 'the repository owner',
  };
  const identity = { state: 'requestAcceptedIdentityUnverifiable' as const, verifiedModelID: '', evidence: 'admitted', resolvedFrom: 'identityAdmission' as const };

  it('classifies the free pool as metered until a confirmation names the exact route', () => {
    expect(costEligibilityFor({ provider: 'opencodeCLI', modelID: MODEL }).eligibility).toBe('metered');
    expect(costEligibilityFor({ provider: 'opencodeCLI', modelID: MODEL, confirmations: [confirmation] }).eligibility).toBe('free_confirmed');
  });

  it('refuses a metered workspace binding without a confirmation, and admits it with one — carrying the basis', () => {
    const pricing = snapshotFor(publishedPriceFor(MODEL)!);
    expect(() => buildWorkspaceBinding({ candidate: 'oc', provider: 'opencodeCLI', modelID: MODEL, effort: 'none',
      timeoutMilliseconds: 60_000, identity, pricing })).toThrow(/unboundedMeteredWorkspaceBinding|cannot be computed/);
    const binding = buildWorkspaceBinding({ candidate: 'oc', provider: 'opencodeCLI', modelID: MODEL, effort: 'none',
      timeoutMilliseconds: 60_000, identity, pricing, zeroMarginalCost: confirmation, now: new Date('2026-09-22T00:00:00Z') });
    expect(binding.billingBasis).toBe('meteredAPI');
    expect(binding.zeroMarginalCostBasis?.observedAt).toBe(confirmation.observedAt);
    expect(binding.pricing?.source).toContain('PUBLISHED LIST PRICE');
  });

  it('refuses a confirmation that cites a price list, and one that has aged out', () => {
    const pricing = snapshotFor(publishedPriceFor(MODEL)!);
    expect(() => buildWorkspaceBinding({ candidate: 'oc', provider: 'opencodeCLI', modelID: MODEL, effort: 'none', timeoutMilliseconds: 60_000,
      identity, pricing, zeroMarginalCost: { ...confirmation, observedBillingRecord: 'the published list price in models.json' } }))
      .toThrow(/PUBLISHED PRICE/);
    expect(() => buildWorkspaceBinding({ candidate: 'oc', provider: 'opencodeCLI', modelID: MODEL, effort: 'none', timeoutMilliseconds: 60_000,
      identity, pricing, zeroMarginalCost: confirmation, now: new Date('2026-12-01T00:00:00Z') })).toThrow(/expires after 30/);
  });

  it('lets a confirmed-free route through the spend gate without a dollar ceiling, and nothing else metered', async () => {
    const pricing = snapshotFor(publishedPriceFor(MODEL)!);
    const binding = buildWorkspaceBinding({ candidate: 'oc', provider: 'opencodeCLI', modelID: MODEL, effort: 'none',
      timeoutMilliseconds: 60_000, identity, pricing, zeroMarginalCost: confirmation, now: new Date('2026-09-22T00:00:00Z') });
    const host = new WorkspaceRoutingHost({ spend: new SpendTracker(undefined) });
    expect((await host.authorizeAttempt({ case: BROKEN_SUM_MEAN, binding })).allowed).toBe(true);
    const withoutBasis = { ...binding, zeroMarginalCostBasis: undefined };
    const refused = await host.authorizeAttempt({ case: BROKEN_SUM_MEAN, binding: withoutBasis });
    expect(refused.allowed).toBe(false);
    if (!refused.allowed) expect(refused.code).toBe('spending.notAuthorized');
  });

  it('refuses a binding whose basis names another route', () => {
    const pricing = snapshotFor(publishedPriceFor(MODEL)!);
    const binding = buildWorkspaceBinding({ candidate: 'oc', provider: 'opencodeCLI', modelID: MODEL, effort: 'none',
      timeoutMilliseconds: 60_000, identity, pricing, zeroMarginalCost: confirmation, now: new Date('2026-09-22T00:00:00Z') });
    expect(() => validateBinding({ ...binding, zeroMarginalCostBasis: { ...binding.zeroMarginalCostBasis!, modelID: 'opencode/other' } }))
      .toThrow(ProviderBindingError);
  });
});

// 11 ────────────────────────────────────────────────────────────────────────────────────────────
describe('11 · stale evidence is refused: a CLI other than the verified version is never driven', () => {
  it('refuses to send anything under an unverified opencode version', async () => {
    const { driver, calls } = injected({ stdout: text(workingStream()) }, '1.19.0');
    const result = await driver.run(bareRequest());
    expect(result.failure?.kind).toBe('policyNotExpressible');
    expect(result.failure?.detail).toContain('1.19.0');
    expect(calls).toHaveLength(0);
  });
});

// 12 ────────────────────────────────────────────────────────────────────────────────────────────
describe('12 · no API key leaks to the child, and OPENCODE_* names cannot arrive from the environment', () => {
  it('hands the child the allow-list plus Cernum\'s own non-credential configuration, and no provider key', async () => {
    const { record } = await runWithFake({
      lines: workingStream(), writes: [{ path: 'src/stats.js', contents: CORRECT_STATS }],
      environmentSource: { PATH: process.env.PATH, HOME: process.env.HOME, USER: 'someone', ANTHROPIC_API_KEY: FIXTURE_ANTHROPIC_KEY,
        OPENAI_API_KEY: 'sk-cernum-test', OPENCODE_API_KEY: 'oc-cernum-test' } as NodeJS.ProcessEnv,
    });
    const environment = record!.environment;
    expect(JSON.stringify(environment)).not.toContain(FIXTURE_ANTHROPIC_KEY);
    expect(environment.OPENAI_API_KEY).toBeUndefined();
    expect(environment.OPENCODE_API_KEY).toBeUndefined();
    const configuration = JSON.parse(environment.OPENCODE_CONFIG_CONTENT) as { permission: Record<string, string>; tools: Record<string, boolean> };
    expect(configuration.permission).toMatchObject({ edit: 'allow', bash: 'allow', webfetch: 'deny', external_directory: 'deny' });
    expect(configuration.tools.webfetch).toBe(false);
    expect(configuration.tools.websearch).toBe(false);
    expect(environment.XDG_CONFIG_HOME).toContain('cernum-opencode-empty-config');
    // The empty config directory is scratch, outside the tree being measured.
    expect(environment.XDG_CONFIG_HOME.startsWith(record!.cwd)).toBe(false);
  });

  it('refuses an attempt whose environment carries any OPENCODE_* name', async () => {
    const { driver, calls } = injected({ stdout: text(workingStream()) });
    const result = await driver.run(bareRequest({ environment: { PATH: '/usr/bin', OPENCODE_AUTH_CONTENT: '{}' } }));
    expect(result.failure?.kind).toBe('policyNotExpressible');
    expect(result.failure?.detail).toContain('OPENCODE_AUTH_CONTENT');
    expect(calls).toHaveLength(0);
  });

  it('turns bash off in the configuration when the case forbids command execution', () => {
    const plan = buildOpenCodeWorkspaceArguments({ tools: { ...ALL_TOOLS, commandExecution: false }, networkPolicy: 'providerOnly',
      requestedModelID: MODEL, workspaceRoot: '/w', scratchDirectory: '/s', caseID: 'c' });
    expect((plan.configuration.permission as Record<string, string>).bash).toBe('deny');
    expect((plan.configuration.tools as Record<string, boolean>).bash).toBe(false);
  });

  it('refuses a tool the configuration withholds if the stream shows it ran anyway', async () => {
    const { driver } = injected({ stdout: text([...workingStream(), toolUse('c9', 'webfetch', { url: 'https://example.com' }, 'completed', 'x')]) });
    const result = await driver.run(bareRequest());
    expect(result.failure?.kind).toBe('policyNotExpressible');
    expect(result.failure?.detail).toContain('webfetch');
  });
});
