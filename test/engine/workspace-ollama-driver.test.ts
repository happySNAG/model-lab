// The local workspace driver, Cernum's own agent loop over Ollama, with NO runtime and NO network: a
// scripted fake answers `/api/version`, `/api/tags`, `/api/show` and `/api/chat` behind an injected
// `fetch`, and the real `fetch` is replaced with one that fails the test if anything reaches it.
//
// THE RESPONSE SHAPES ARE OLLAMA'S DOCUMENTED ONES — `/api/tags` rows with `digest`, `size` and `details`;
// `/api/show` with `capabilities` and `model_info["<arch>.context_length"]`; `/api/chat` with
// `message.tool_calls[].function.{name,arguments}`, `prompt_eval_count`, `eval_count` and the durations
// in nanoseconds — the same shapes `ollama-http.ts` already parses for the prose path.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FetchLike } from '../../src/core/ollama-http';
import { BROKEN_SUM_MEAN } from '../../src/engine/workspace-catalog';
import { runWorkspaceCase } from '../../src/engine/workspace-execution';
import { scoreWorkspaceRun } from '../../src/engine/workspace-scoring';
import { TranscriptBuilder, terminationReasonFor } from '../../src/engine/workspace-transcript';
import { buildWorkspaceDriver, providersWithWorkspaceDriver } from '../../src/engine/host-factory';
import { buildWorkspaceBinding, resolveLocalPreRunIdentity } from '../../src/engine/workspace-binding';
import { costEligibilityFor } from '../../src/engine/cost-eligibility';
import { describeLocalModel } from '../../src/engine/model-description';
import { qualificationStaleness } from '../../src/engine/discovery-refresh';
import {
  LocalRuntimeClient, OLLAMA_WORKSPACE_CAPABILITIES, OLLAMA_WORKSPACE_DRIVER_ID, OllamaWorkspaceDriver, ollamaWorkspaceTools,
} from '../../src/engine/workspace-ollama-driver';

const FIXTURE_ROOT = path.resolve(__dirname, '../../fixtures');
const MODEL = 'qwen-coder-fixture:14b';
const DIGEST = 'sha256:1111111111111111111111111111111111111111111111111111111111111111';
const MACHINE = { machineKey: 'cmk1:fixture-machine-a', label: 'fixture-host-a', platform: 'darwin-arm64' };

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

const temporaries: string[] = [];
let realFetch: typeof fetch;
beforeEach(() => {
  // NO ACCIDENTAL NETWORK. Every request in this file goes through an injected fake; the global is a tripwire.
  realFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async () => { throw new Error('a test reached the real fetch'); }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const directory of temporaries.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});
function temporary(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaries.push(directory);
  return directory;
}

type ChatReply = Record<string, unknown>;
const call = (name: string, args: Record<string, unknown>) => ({ function: { name, arguments: args } });
const reply = (toolCalls: unknown[], content = '', counts = { prompt: 900, evaluated: 60 }, model = MODEL): ChatReply => ({
  model, created_at: '2026-09-22T12:00:00Z', done: true, done_reason: 'stop',
  message: { role: 'assistant', content, ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}) },
  prompt_eval_count: counts.prompt, eval_count: counts.evaluated,
  total_duration: 2_000_000_000, load_duration: 100_000_000,
});

/** A fake runtime: listing, show, and a scripted sequence of chat replies. Records every request. */
function fakeRuntime(options: {
  chats: ChatReply[]; digest?: string; digestAfter?: string; capabilities?: string[] | null; contextLength?: number;
  unreachable?: boolean; missing?: boolean;
}) {
  const requests: { url: string; body?: Record<string, unknown> }[] = [];
  let tagsCalls = 0;
  let chatIndex = 0;
  const respond = (status: number, value: unknown) => ({ status, text: async () => JSON.stringify(value) });
  const fetchImpl: FetchLike = async (url, init) => {
    const body = init.body === undefined ? undefined : JSON.parse(init.body) as Record<string, unknown>;
    requests.push({ url, body });
    if (options.unreachable) throw new Error('connect ECONNREFUSED 127.0.0.1:11434');
    const route = new URL(url).pathname;
    if (route === '/api/version') return respond(200, { version: '0.12.3' });
    if (route === '/api/tags') {
      tagsCalls += 1;
      const digest = tagsCalls > 1 && options.digestAfter !== undefined ? options.digestAfter : (options.digest ?? DIGEST);
      return respond(200, { models: options.missing ? [] : [{ name: MODEL, model: MODEL, digest, size: 9_000_000_000,
        details: { family: 'qwen', parameter_size: '14B', quantization_level: 'Q4_K_M' } }] });
    }
    if (route === '/api/show') {
      return respond(200, { ...(options.capabilities === null ? {} : { capabilities: options.capabilities ?? ['completion', 'tools'] }),
        model_info: { 'qwen.context_length': options.contextLength ?? 32_768 } });
    }
    if (route === '/api/chat') {
      const next = options.chats[Math.min(chatIndex, options.chats.length - 1)];
      chatIndex += 1;
      return respond(200, next);
    }
    return respond(404, { error: 'not found' });
  };
  return { fetchImpl, requests };
}

function driverWith(runtime: ReturnType<typeof fakeRuntime>, overrides: { expectedDigest?: string; maximumTurns?: number } = {}) {
  return new OllamaWorkspaceDriver({
    requestedModelID: MODEL, expectedDigest: overrides.expectedDigest ?? DIGEST, fetch: runtime.fetchImpl,
    machine: MACHINE, maximumTurns: overrides.maximumTurns,
  });
}

async function runCase(runtime: ReturnType<typeof fakeRuntime>, overrides: { expectedDigest?: string } = {}) {
  const driver = driverWith(runtime, overrides);
  const result = await runWorkspaceCase({
    case: BROKEN_SUM_MEAN, driver, fixtureRoot: FIXTURE_ROOT, sandboxRoot: temporary('cernum-ws-sandbox-'),
    environmentSource: { PATH: process.env.PATH, HOME: process.env.HOME, USER: 'someone' } as NodeJS.ProcessEnv,
  });
  return { result, card: scoreWorkspaceRun(BROKEN_SUM_MEAN, result) };
}

/** A competent local model: read, run the check, fix, re-check, finish. */
function competent(): ChatReply[] {
  return [
    reply([call('list_files', {})]),
    reply([call('read_file', { path: 'src/stats.js' })]),
    reply([call('run_check', { check_id: BROKEN_SUM_MEAN.verification.commands[0].id })]),
    reply([call('write_file', { path: 'src/stats.js', content: CORRECT_STATS })]),
    reply([call('run_check', { check_id: BROKEN_SUM_MEAN.verification.commands[0].id })]),
    reply([], 'Fixed the divisor in mean(); the check passes.'),
  ];
}

// 13 ────────────────────────────────────────────────────────────────────────────────────────────
describe('13 · the driver exists for ollama, and declares a sealed-checks-only command surface', () => {
  it('is built by the registry with the frozen digest, and refused without one', async () => {
    expect(providersWithWorkspaceDriver()).toContain('ollama');
    const driver = buildWorkspaceDriver({ provider: 'ollama', requestedModelID: MODEL, effort: 'none', localModelDigest: DIGEST });
    expect(driver?.driverID).toBe(OLLAMA_WORKSPACE_DRIVER_ID);
    expect(driver?.driverID).toBe('driver.ollama.workspace');
    expect(OLLAMA_WORKSPACE_CAPABILITIES.commandExecutionScope).toBe('sealedChecksOnly');
    const noDigest = new OllamaWorkspaceDriver({ requestedModelID: MODEL, expectedDigest: '', fetch: fakeRuntime({ chats: [] }).fetchImpl });
    const refused = await noDigest.run({
      caseID: 'c', caseVersion: '1', caseDigest: 'x', attemptIndex: 0, maximumAttempts: 1, instruction: 'i',
      workspaceRoot: temporary('cernum-ws-'), scope: { allowed: [], forbidden: [] },
      tools: { fileRead: true, fileWrite: true, commandExecution: false, allowedExecutables: [] }, networkPolicy: 'providerOnly',
      environment: {}, timeoutMilliseconds: 1_000, transcript: new TranscriptBuilder(0, () => 0),
    });
    expect(refused.failure?.kind).toBe('policyNotExpressible');
    expect(refused.failure?.detail).toContain('no weights digest');
  });

  it('never offers a free-form command tool — only run_check, and only with visible checks', () => {
    const all = { fileRead: true, fileWrite: true, commandExecution: true, allowedExecutables: [] };
    const names = ollamaWorkspaceTools(all, [{ id: 'stats-tests', kind: 'test' }]).map((tool) => tool.function.name);
    expect(names).toEqual(['list_files', 'read_file', 'write_file', 'replace_in_file', 'run_check']);
    expect(names.some((name) => /shell|bash|exec|command/.test(name))).toBe(false);
    expect(ollamaWorkspaceTools(all, []).map((tool) => tool.function.name)).not.toContain('run_check');
  });
});

// 14 ────────────────────────────────────────────────────────────────────────────────────────────
describe('14 · 16 · 17 · local discovery is authoritative; local classification; context metadata', () => {
  it('resolves identity from THIS machine\'s listing only, verified by digest', () => {
    const identity = resolveLocalPreRunIdentity([{ modelID: MODEL, runtimeDigest: DIGEST }], MODEL);
    expect(identity).toMatchObject({ state: 'verified', verifiedModelID: MODEL, resolvedFrom: 'localRuntimeDigest' });
    expect(identity.evidence).toContain(DIGEST);
    expect(resolveLocalPreRunIdentity([], MODEL).resolvedFrom).toBe('nothing');
    expect(resolveLocalPreRunIdentity([{ modelID: MODEL, runtimeDigest: '' }], MODEL).state).toBe('unverifiable');
  });

  it('classifies a local route as local — no admission, no price, no authorization', () => {
    const binding = buildWorkspaceBinding({ candidate: `ollama:${MODEL}`, provider: 'ollama', modelID: MODEL, effort: 'none',
      timeoutMilliseconds: 60_000, identity: resolveLocalPreRunIdentity([{ modelID: MODEL, runtimeDigest: DIGEST }], MODEL),
      localModelDigest: DIGEST });
    expect(binding).toMatchObject({ executionClass: 'localRuntime', billingBasis: 'local', pricing: null, authorizationMode: 'none',
      identityState: 'verified', localModelDigest: DIGEST });
    expect(costEligibilityFor({ provider: 'ollama', modelID: MODEL }).eligibility).toBe('local');
  });

  it('refuses a local binding whose digest is not the one its identity was resolved from', () => {
    expect(() => buildWorkspaceBinding({ candidate: 'x', provider: 'ollama', modelID: MODEL, effort: 'none', timeoutMilliseconds: 60_000,
      identity: resolveLocalPreRunIdentity([{ modelID: MODEL, runtimeDigest: DIGEST }], MODEL), localModelDigest: 'sha256:other' }))
      .toThrow(/weights digest/);
  });

  it('records context, digest and runtime as the runtime reported them, in the structured description', () => {
    const description = describeLocalModel({ modelID: MODEL, runtimeDigest: DIGEST, capabilities: ['completion', 'tools'], contextLengthTokens: 32_768 },
      { machine: MACHINE.machineKey, observedAt: '2026-09-22T12:00:00Z', runtimeVersion: '0.12.3', endpoint: 'http://127.0.0.1:11434' });
    expect(description.contextWindowTokens).toMatchObject({ state: 'known', value: 32_768 });
    expect(description.modelDigest).toMatchObject({ state: 'known', value: DIGEST });
    expect(description.toolUse).toMatchObject({ state: 'known', value: true });
    expect(description.locality).toBe('local');
    expect(description.billingClass).toMatchObject({ state: 'known', value: 'local' });
  });
});

// 15/19 ─────────────────────────────────────────────────────────────────────────────────────────
describe('15 · 19 · the digest is bound before and after, and a changed digest stales qualification', () => {
  it('refuses before the first turn when the installed weights are not the frozen ones', async () => {
    const runtime = fakeRuntime({ chats: competent(), digest: 'sha256:2222' });
    const { result } = await runCase(runtime);
    expect(result.attempts[0].agent.failure?.kind).toBe('policyNotExpressible');
    expect(result.attempts[0].agent.failure?.detail).toContain('Different weights are a different model');
    expect(runtime.requests.some((request) => request.url.endsWith('/api/chat'))).toBe(false);
  });

  it('refuses an attempt whose weights changed mid-run', async () => {
    const runtime = fakeRuntime({ chats: competent(), digestAfter: 'sha256:3333' });
    const { result } = await runCase(runtime);
    expect(result.attempts[0].agent.failure?.detail).toContain('digest changed during the attempt');
  });

  it('marks a qualification stale when the runtime digest moved', () => {
    const staleness = qualificationStaleness(
      { routeKey: `ollama:${MODEL}`, qualifiedAt: '2026-09-20T00:00:00Z', driverID: OLLAMA_WORKSPACE_DRIVER_ID, runtimeDigest: DIGEST },
      { routeKey: `ollama:${MODEL}`, provider: 'ollama', modelID: MODEL, listed: true, runtimeDigest: 'sha256:4444', observedAt: '2026-09-22T00:00:00Z' },
      { driverID: OLLAMA_WORKSPACE_DRIVER_ID, now: new Date('2026-09-22T00:00:00Z') });
    expect(staleness.valid).toBe(false);
    expect(staleness.reasons).toContain('staleRuntimeDigestChanged');
  });
});

// 18 ────────────────────────────────────────────────────────────────────────────────────────────
describe('18 · an unavailable local runtime is the machine\'s fault, never the model\'s', () => {
  it('reports a refused connection as notInstalled (driverUnavailable), having measured nothing', async () => {
    const { result } = await runCase(fakeRuntime({ chats: [], unreachable: true }));
    const attempt = result.attempts[0];
    expect(attempt.agent.failure?.kind).toBe('notInstalled');
    expect(attempt.agent.failure?.detail).toContain('LOCAL RUNTIME UNAVAILABLE');
    expect(attempt.terminationReason).toBe('driverUnavailable');
    expect(terminationReasonFor('notInstalled')).toBe('driverUnavailable');
  });

  it('reports a model that is not installed the same way', async () => {
    const { result } = await runCase(fakeRuntime({ chats: [], missing: true }));
    expect(result.attempts[0].agent.failure?.detail).toContain('does not have');
  });

  it('refuses a model the runtime says cannot use tools', async () => {
    const { result } = await runCase(fakeRuntime({ chats: [], capabilities: ['completion'] }));
    expect(result.attempts[0].agent.failure?.detail).toContain('and not tools');
  });

  it('refuses a non-loopback endpoint outright: a local model must stay local', () => {
    expect(() => new LocalRuntimeClient('http://192.168.1.20:11434')).toThrow(/not loopback/);
    expect(() => new LocalRuntimeClient('https://api.example.com')).toThrow();
  });
});

// 20/21/22 ──────────────────────────────────────────────────────────────────────────────────────
describe('20 · 21 · 22 · machine provenance, the patch flow and the verifier flow', () => {
  it('fixes the case through Cernum\'s tools, runs the sealed check in a sandbox, and passes on the ENGINE\'s verification', async () => {
    const runtime = fakeRuntime({ chats: competent() });
    const { result, card } = await runCase(runtime);
    const attempt = result.attempts[0];
    expect(attempt.agent.failure).toBeUndefined();
    expect(attempt.diff.changedPaths).toEqual(['src/stats.js']);
    expect(attempt.verificationOutcomes[0].passed).toBe(true);
    expect(card.status).toBe('pass');

    // File effects are ENGINE-observed on this route; the tool calls are the model's requests.
    const events = attempt.transcript.events;
    expect(events.find((event) => event.kind === 'fileWrite')?.provenance).toBe('engineObserved');
    expect(events.find((event) => event.kind === 'fileRead')?.provenance).toBe('engineObserved');
    expect(events.filter((event) => event.kind === 'toolCall').every((event) => event.provenance === 'agentReported')).toBe(true);
    // The model-requested check ran under the sandbox, as an engine-observed command, twice.
    const checks = events.filter((event) => event.kind === 'commandExecuted' && event.reason === 'modelRequestedCheck');
    expect(checks).toHaveLength(2);
    expect(checks.every((event) => event.provenance === 'engineObserved')).toBe(true);
    // Hidden checks were never offered to the model.
    const offered = (runtime.requests.find((request) => request.url.endsWith('/api/chat'))?.body?.tools as { function: { name: string } }[])
      .map((tool) => tool.function.name);
    expect(offered).toContain('run_check');

    const usage = attempt.agent.usage as Record<string, unknown>;
    expect(usage.localModelDigest).toBe(DIGEST);
    expect(usage.localRuntimeVersion).toBe('0.12.3');
    expect(usage.executionMachine).toBe(MACHINE.machineKey);
    expect(usage.localModelContextLengthTokens).toBe(32_768);
    expect(usage.inputTokens).toBe(900 * 6);
    expect(usage.visibleOutputTokens).toBe(60 * 6);
    expect(usage.numTurns).toBe(6);
    expect(usage.identityState).toBe('verified');
    expect(attempt.agent.reportedModelID).toBe(MODEL);
  });

  it('leaves token counts ABSENT when the runtime omits them — never zero, never estimated', async () => {
    const bare = (calls: unknown[], content = '') => {
      const r = reply(calls, content);
      delete r.prompt_eval_count; delete r.eval_count;
      return r;
    };
    const { result } = await runCase(fakeRuntime({ chats: [bare([], 'done')] }));
    const usage = result.attempts[0].agent.usage as Record<string, unknown>;
    expect(usage.inputTokens).toBeUndefined();
    expect(usage.visibleOutputTokens).toBeUndefined();
  });

  it('confines every path: a write outside the workspace is refused by the engine and recorded', async () => {
    const runtime = fakeRuntime({ chats: [reply([call('write_file', { path: '../../escape.txt', content: 'x' })]), reply([], 'done')] });
    const { result } = await runCase(runtime);
    const attempt = result.attempts[0];
    expect(attempt.harnessFault).toBeUndefined();
    expect(attempt.transcript.events.some((event) => event.kind === 'boundaryRefusal')).toBe(true);
  });

  it('never lets the model run a check the case did not seal', async () => {
    const runtime = fakeRuntime({ chats: [reply([call('run_check', { check_id: 'rm -rf /' })]), reply([], 'done')] });
    const { result } = await runCase(runtime);
    const results = result.attempts[0].transcript.events.filter((event) => event.kind === 'toolResult');
    expect(results[0].detail).toContain('is not one of this case\'s visible checks');
    expect(result.attempts[0].transcript.events.some((event) => event.kind === 'commandExecuted' && event.reason === 'modelRequestedCheck')).toBe(false);
  });

  it('stops at the turn bound rather than looping forever', async () => {
    const runtime = fakeRuntime({ chats: [reply([call('list_files', {})])] });
    const driver = driverWith(runtime, { maximumTurns: 3 });
    const result = await runWorkspaceCase({
      case: BROKEN_SUM_MEAN, driver, fixtureRoot: FIXTURE_ROOT, sandboxRoot: temporary('cernum-ws-sandbox-'),
      environmentSource: { PATH: process.env.PATH, HOME: process.env.HOME, USER: 'someone' } as NodeJS.ProcessEnv,
    });
    expect(result.attempts[0].agent.failure?.detail).toContain('all 3 turns');
  });

  it('never reached the real network at any point in this file', () => {
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
