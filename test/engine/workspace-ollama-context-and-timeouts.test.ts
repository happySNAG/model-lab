// Cernum · the two defects that live Ollama qualification exposed the first time it ran against real
// weights, and the properties that must hold once they are fixed.
//
// Both defects were invisible until the volume holding the weights was mounted, because until then no
// workspace case had ever reached a real local runtime. Neither is about a model's ability:
//
//   1. THE WINDOW WAS NEVER ASKED FOR. The driver read each model's context length from `/api/show`
//      and sealed it onto every record, and then sent a chat request that never mentioned it. The
//      runtime therefore opened its OWN default window — 4_096 tokens on current Ollama, for a model
//      whose measured context is 262_144 — and a workspace conversation that outgrew it was truncated
//      from the front until the user turn fell off, at which point the runtime refused the request
//      for containing no user query.
//   2. THE HTTP CLIENT OUTRANKED THE CASE DEADLINE. The driver sent a non-streaming request through
//      the platform `fetch`, which applies its own 300_000 ms header deadline. No response header
//      arrives until a non-streaming generation is COMPLETE, so on a machine where a turn takes
//      longer than five minutes every attempt died as a transport error while the case's own
//      600_000 ms deadline still had time left on it.
//
// WHAT IS ASSERTED HERE, AND WHAT IS NOT. The ">300 s is survivable" property is asserted in two
// parts rather than by sleeping for five minutes: that the derivation yields a backstop well beyond
// the platform default, and that the client honours the backstop it is GIVEN rather than one of its
// own — demonstrated over a real loopback socket. Together those are the property; separately
// neither is, and neither is written as though it were.

import { afterEach, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  FetchLike, HTTP_BACKSTOP_GRACE_MILLISECONDS, httpBackstopTimeoutsFor, loopbackHTTPFetch,
} from '../../src/core/ollama-http';
import { streamedChatResponse } from './ollama-stream-fake';
import { BROKEN_SUM_MEAN } from '../../src/engine/workspace-catalog';
import { runWorkspaceCase } from '../../src/engine/workspace-execution';
import {
  LocalRuntimeClient, OLLAMA_WORKSPACE_CONTEXT_CEILING_TOKENS, OllamaWorkspaceDriver, ollamaWorkspaceContextWindow,
} from '../../src/engine/workspace-ollama-driver';
import { describeLocalModel } from '../../src/engine/model-description';
import { observationsFromLocalModels } from '../../src/engine/discovery-refresh';

const FIXTURE_ROOT = path.resolve(__dirname, '../../fixtures');
const MODEL = 'qwen-coder-fixture:14b';
const DIGEST = 'sha256:1111111111111111111111111111111111111111111111111111111111111111';
const MACHINE = { machineKey: 'cmk1:fixture-machine-a', label: 'fixture-host-a', platform: 'darwin-arm64' };

const temporaries: string[] = [];
const servers: http.Server[] = [];
afterEach(async () => {
  for (const directory of temporaries.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
});
function temporary(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaries.push(directory);
  return directory;
}

type ChatReply = Record<string, unknown>;
const call = (name: string, args: Record<string, unknown>) => ({ function: { name, arguments: args } });
const reply = (toolCalls: unknown[], content = ''): ChatReply => ({
  model: MODEL, created_at: '2026-09-22T12:00:00Z', done: true, done_reason: 'stop',
  message: { role: 'assistant', content, ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}) },
  prompt_eval_count: 900, eval_count: 60, total_duration: 2_000_000_000, load_duration: 100_000_000,
});

/** Records every chat request AND the transport backstops it was sent with. */
function recordingRuntime(options: { contextLength?: number | null; chats?: ChatReply[] } = {}) {
  const chatBodies: Record<string, unknown>[] = [];
  const backstops: { headers?: number; body?: number }[] = [];
  const chats = options.chats ?? [reply([], 'done')];
  let chatIndex = 0;
  const respond = (status: number, value: unknown) => ({ status, text: async () => JSON.stringify(value) });
  const fetchImpl: FetchLike = async (url, init) => {
    const route = new URL(url).pathname;
    const body = init.body === undefined ? undefined : JSON.parse(init.body) as Record<string, unknown>;
    if (route === '/api/version') return respond(200, { version: '0.34.0' });
    if (route === '/api/tags') {
      return respond(200, { models: [{ name: MODEL, model: MODEL, digest: DIGEST, size: 9_000_000_000,
        details: { family: 'qwen', parameter_size: '14B', quantization_level: 'Q4_K_M' } }] });
    }
    if (route === '/api/show') {
      // `contextLength: null` is a runtime that published no context length at all.
      return respond(200, { capabilities: ['completion', 'tools'],
        model_info: options.contextLength === null ? {} : { 'qwen.context_length': options.contextLength ?? 262_144 } });
    }
    if (route === '/api/chat') {
      chatBodies.push(body ?? {});
      backstops.push({ headers: init.headersTimeoutMilliseconds, body: init.bodyTimeoutMilliseconds });
      const next = chats[Math.min(chatIndex, chats.length - 1)];
      chatIndex += 1;
      const message = (next.message ?? {}) as Record<string, unknown>;
      return streamedChatResponse({
        model: MODEL,
        content: typeof message.content === 'string' ? message.content : '',
        toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls : [],
        promptEvalCount: next.prompt_eval_count as number, evalCount: next.eval_count as number,
        totalDuration: next.total_duration as number, loadDuration: next.load_duration as number,
      });
    }
    return respond(404, { error: 'not found' });
  };
  return { fetchImpl, chatBodies, backstops };
}

async function runOnce(runtime: ReturnType<typeof recordingRuntime>, overrides: { contextCeilingTokens?: number } = {}) {
  const driver = new OllamaWorkspaceDriver({
    requestedModelID: MODEL, expectedDigest: DIGEST, fetch: runtime.fetchImpl, machine: MACHINE,
    contextCeilingTokens: overrides.contextCeilingTokens,
  });
  return runWorkspaceCase({
    case: BROKEN_SUM_MEAN, driver, fixtureRoot: FIXTURE_ROOT, sandboxRoot: temporary('cernum-ws-ctx-'),
    environmentSource: { PATH: process.env.PATH, HOME: process.env.HOME, USER: 'someone' } as NodeJS.ProcessEnv,
  });
}

/** A loopback server that delays its RESPONSE HEADERS by `delayMilliseconds`. */
function delayedHeaderServer(delayMilliseconds: number): Promise<string> {
  const server = http.createServer((_request, response) => {
    setTimeout(() => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ version: 'delayed' }));
    }, delayMilliseconds);
  });
  servers.push(server);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
  }));
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
describe('the measured context window is what the request asks for', () => {
  it('sends num_ctx derived from the context length the runtime published', async () => {
    const runtime = recordingRuntime({ contextLength: 16_384 });
    await runOnce(runtime);

    expect(runtime.chatBodies.length).toBeGreaterThan(0);
    for (const body of runtime.chatBodies) {
      const options = body.options as Record<string, unknown>;
      // 16_384 is below the harness ceiling, so it passes through exactly as measured.
      expect(options.num_ctx).toBe(16_384);
    }
  });

  it('bounds the request by the harness ceiling without altering what was MEASURED', async () => {
    const runtime = recordingRuntime({ contextLength: 262_144 });
    const result = await runOnce(runtime);

    const options = runtime.chatBodies[0].options as Record<string, unknown>;
    expect(options.num_ctx).toBe(OLLAMA_WORKSPACE_CONTEXT_CEILING_TOKENS);
    // The record keeps the runtime's own number AND the window actually opened. Neither replaces the other.
    const usage = result.attempts[0].agent.usage as Record<string, unknown>;
    expect(usage.localModelContextLengthTokens).toBe(262_144);
    expect(usage.localModelContextWindowRequestedTokens).toBe(OLLAMA_WORKSPACE_CONTEXT_CEILING_TOKENS);
  });

  it('honours an operator ceiling raised for a machine with the memory for it', async () => {
    const runtime = recordingRuntime({ contextLength: 262_144 });
    await runOnce(runtime, { contextCeilingTokens: 131_072 });

    const options = runtime.chatBodies[0].options as Record<string, unknown>;
    expect(options.num_ctx).toBe(131_072);
  });

  it('INVENTS NOTHING when the runtime published no context length', async () => {
    const runtime = recordingRuntime({ contextLength: null });
    const result = await runOnce(runtime);

    // No num_ctx key at all — not a zero, not a guessed default. The runtime decides, and the record
    // says the length was never known rather than carrying a number nobody measured.
    for (const body of runtime.chatBodies) {
      expect(Object.keys(body.options as Record<string, unknown>)).not.toContain('num_ctx');
    }
    const usage = result.attempts[0].agent.usage as Record<string, unknown>;
    expect(usage.localModelContextLengthTokens).toBeUndefined();
    expect(usage.localModelContextWindowRequestedTokens).toBeUndefined();
  });

  it('computes the window without inventing one, as a pure function', () => {
    expect(ollamaWorkspaceContextWindow(undefined)).toBeUndefined();
    expect(ollamaWorkspaceContextWindow(0)).toBeUndefined();
    expect(ollamaWorkspaceContextWindow(-1)).toBeUndefined();
    expect(ollamaWorkspaceContextWindow(Number.NaN)).toBeUndefined();
    expect(ollamaWorkspaceContextWindow(8_192)).toBe(8_192);
    expect(ollamaWorkspaceContextWindow(262_144)).toBe(OLLAMA_WORKSPACE_CONTEXT_CEILING_TOKENS);
    expect(ollamaWorkspaceContextWindow(262_144, 65_536)).toBe(65_536);
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
describe('the HTTP backstops are derived from the case deadline, and never outrank it', () => {
  it('derives header and body backstops from the deadline, finite and strictly later', () => {
    const { headersTimeoutMilliseconds, bodyTimeoutMilliseconds } = httpBackstopTimeoutsFor(600_000);
    expect(headersTimeoutMilliseconds).toBe(600_000 + HTTP_BACKSTOP_GRACE_MILLISECONDS);
    expect(bodyTimeoutMilliseconds).toBe(600_000 + HTTP_BACKSTOP_GRACE_MILLISECONDS);

    // STRICTLY LATER than the caller's own deadline: the caller stays authoritative.
    expect(headersTimeoutMilliseconds).toBeGreaterThan(600_000);
    // FINITE. A backstop that never fires is not a backstop.
    expect(Number.isFinite(headersTimeoutMilliseconds)).toBe(true);
    expect(Number.isFinite(bodyTimeoutMilliseconds)).toBe(true);
  });

  it('is patient well past the 300 s platform default that killed legitimate generations', () => {
    // The first half of the ">300 s is survivable" property: for a 600_000 ms case, the client is
    // told to wait 615_000 ms. The platform default that caused the defect is 300_000 ms.
    const { headersTimeoutMilliseconds, bodyTimeoutMilliseconds } = httpBackstopTimeoutsFor(BROKEN_SUM_MEAN.execution.timeoutMilliseconds);
    expect(BROKEN_SUM_MEAN.execution.timeoutMilliseconds).toBeGreaterThan(300_000);
    expect(headersTimeoutMilliseconds).toBeGreaterThan(300_000);
    expect(bodyTimeoutMilliseconds).toBeGreaterThan(300_000);
  });

  it('sends the derived backstops on every chat request the driver makes', async () => {
    const runtime = recordingRuntime({ chats: [reply([call('list_files', {})]), reply([], 'done')] });
    await runOnce(runtime);

    expect(runtime.backstops.length).toBeGreaterThan(0);
    for (const sent of runtime.backstops) {
      expect(sent.headers).toBeGreaterThan(300_000);
      expect(sent.body).toBeGreaterThan(300_000);
      // Derived from the remaining case deadline, so never beyond the case's own budget plus grace.
      expect(sent.headers).toBeLessThanOrEqual(BROKEN_SUM_MEAN.execution.timeoutMilliseconds + HTTP_BACKSTOP_GRACE_MILLISECONDS);
    }
  });

  it('a zero or nonsense deadline still yields a finite backstop, never an infinite one', () => {
    for (const deadline of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const { headersTimeoutMilliseconds, bodyTimeoutMilliseconds } = httpBackstopTimeoutsFor(deadline);
      expect(Number.isFinite(headersTimeoutMilliseconds)).toBe(true);
      expect(Number.isFinite(bodyTimeoutMilliseconds)).toBe(true);
      expect(headersTimeoutMilliseconds).toBe(HTTP_BACKSTOP_GRACE_MILLISECONDS);
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
describe('the client honours the backstop it is GIVEN, over a real loopback socket', () => {
  it('a slow response INSIDE the backstop is delivered, not killed by a deadline of the client\'s own', async () => {
    // The second half of the ">300 s is survivable" property. A real socket, real headers delayed
    // past the point a fixed internal cap would have fired had one been applied at this scale.
    const endpoint = await delayedHeaderServer(700);
    const client = new LocalRuntimeClient(endpoint, loopbackHTTPFetch());
    await expect(client.version()).resolves.toBe('delayed');
  });

  it('a response BEYOND the backstop is refused rather than waited on forever', async () => {
    const endpoint = await delayedHeaderServer(5_000);
    const fetchImpl = loopbackHTTPFetch();
    const controller = new AbortController();
    await expect(fetchImpl(`${endpoint}/api/version`, {
      method: 'GET', signal: controller.signal, headersTimeoutMilliseconds: 250, bodyTimeoutMilliseconds: 250,
    })).rejects.toThrow(/no response headers within 250 ms/);
  });

  it('CANCELLATION still wins immediately, and is not weakened by the backstops', async () => {
    const endpoint = await delayedHeaderServer(5_000);
    const fetchImpl = loopbackHTTPFetch();
    const controller = new AbortController();
    const pending = fetchImpl(`${endpoint}/api/version`, {
      method: 'GET', signal: controller.signal, headersTimeoutMilliseconds: 600_000, bodyTimeoutMilliseconds: 600_000,
    });
    controller.abort();
    // The abort lands at once despite a ten-minute backstop: the caller outranks the client.
    await expect(pending).rejects.toThrow(/aborted/i);
  });

  it('an already-aborted signal never opens a socket at all', async () => {
    const endpoint = await delayedHeaderServer(5_000);
    const fetchImpl = loopbackHTTPFetch();
    const controller = new AbortController();
    controller.abort();
    await expect(fetchImpl(`${endpoint}/api/version`, {
      method: 'GET', signal: controller.signal, headersTimeoutMilliseconds: 600_000,
    })).rejects.toThrow(/aborted/i);
  });

  it('the case deadline still refuses a runtime that answers beyond it', async () => {
    // The driver's own AbortController, set from the sealed case deadline, is what ends this — the
    // backstop is fifteen seconds further out and never gets the chance to fire. Under streaming the
    // deadline is an OUTCOME rather than an exception, and it names which kind of silence this was:
    // the stream never opened, so no token could have arrived.
    const endpoint = await delayedHeaderServer(5_000);
    const client = new LocalRuntimeClient(endpoint, loopbackHTTPFetch());
    const outcome = await client.chatStream({ model: MODEL, messages: [] }, 200);
    expect(outcome.outcome).toBe('noFirstTokenBeforeDeadline');
    expect(outcome.firstTokenMilliseconds).toBeUndefined();
    expect(outcome.firstTokenUnavailableReason).toMatch(/no token/i);
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
describe('the fixes do not loosen the trust boundary', () => {
  it('the client still refuses a non-loopback endpoint', () => {
    for (const endpoint of ['http://192.168.1.10:11434', 'http://example.com:11434', 'http://0.0.0.0:11434']) {
      expect(() => new LocalRuntimeClient(endpoint, loopbackHTTPFetch())).toThrow(/not loopback/);
    }
  });

  it('the node:http transport itself refuses a non-loopback URL, independently of the client', async () => {
    const fetchImpl = loopbackHTTPFetch();
    await expect(fetchImpl('http://example.com/api/version', {
      method: 'GET', signal: new AbortController().signal,
    })).rejects.toThrow(/not loopback/);
  });

  it('a non-http scheme is still refused', () => {
    expect(() => new LocalRuntimeClient('https://127.0.0.1:11434', loopbackHTTPFetch())).toThrow(/is not http/);
  });

  it('the weights digest is still checked, and a changed one still refuses the attempt', async () => {
    const runtime = recordingRuntime({ contextLength: 16_384 });
    const driver = new OllamaWorkspaceDriver({
      requestedModelID: MODEL, expectedDigest: 'sha256:aaaa', fetch: runtime.fetchImpl, machine: MACHINE,
    });
    const result = await runWorkspaceCase({
      case: BROKEN_SUM_MEAN, driver, fixtureRoot: FIXTURE_ROOT, sandboxRoot: temporary('cernum-ws-digest-'),
      environmentSource: { PATH: process.env.PATH, HOME: process.env.HOME, USER: 'someone' } as NodeJS.ProcessEnv,
    });

    expect(result.attempts[0].agent.failure?.kind).toBe('policyNotExpressible');
    expect(result.attempts[0].agent.failure?.detail).toMatch(/weights digest/);
    // Nothing was sent: a digest mismatch is decided before the first chat.
    expect(runtime.chatBodies).toHaveLength(0);
  });

  it('the machine and digest still reach the record, so qualification stays bound to both', async () => {
    const runtime = recordingRuntime({ contextLength: 16_384 });
    const result = await runOnce(runtime);

    const usage = result.attempts[0].agent.usage as Record<string, unknown>;
    expect(usage.executionMachine).toBe(MACHINE.machineKey);
    expect(usage.localModelDigest).toBe(DIGEST);
    expect(usage.localRuntimeVersion).toBe('0.34.0');
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────
// The execution ceiling is a property of THIS HARNESS ON THIS MACHINE, not of the model. A model's
// native maximum is what routing compares, qualifies and reports; the ceiling is what one run chose
// to open. If the two were ever confused, a 262_144-token model would be permanently recorded as a
// 32_768-token model the moment it ran here once — and every later comparison against a frontier
// route would be made against a number the model never had.
describe('routing and qualification see the MODEL\'s maximum, never this harness\'s ceiling', () => {
  it('describes a local model by its measured context, not by the window a run opened', async () => {
    const runtime = recordingRuntime({ contextLength: 262_144 });
    const result = await runOnce(runtime);

    // The run really was bounded — otherwise this proves nothing.
    expect((runtime.chatBodies[0].options as Record<string, unknown>).num_ctx).toBe(OLLAMA_WORKSPACE_CONTEXT_CEILING_TOKENS);

    const usage = result.attempts[0].agent.usage as Record<string, unknown>;
    const description = describeLocalModel(
      { modelID: MODEL, runtimeDigest: DIGEST, capabilities: ['completion', 'tools'],
        contextLengthTokens: usage.localModelContextLengthTokens as number },
      { machine: MACHINE.machineKey, observedAt: '2026-09-22T12:00:00Z', runtimeVersion: '0.34.0', endpoint: 'http://127.0.0.1:11434' });

    expect(description.contextWindowTokens).toMatchObject({ state: 'known', value: 262_144 });
    expect(description.contextWindowTokens).not.toMatchObject({ value: OLLAMA_WORKSPACE_CONTEXT_CEILING_TOKENS });
  });

  it('carries the measured context into route observations, so qualification compares the real one', async () => {
    const runtime = recordingRuntime({ contextLength: 262_144 });
    const result = await runOnce(runtime);
    const usage = result.attempts[0].agent.usage as Record<string, unknown>;

    const [observation] = observationsFromLocalModels(
      [{ modelID: MODEL, runtimeDigest: DIGEST, contextLengthTokens: usage.localModelContextLengthTokens as number }],
      '2026-09-22T12:00:00Z', '0.34.0');

    expect(observation.contextWindowTokens).toBe(262_144);
    expect(observation.contextWindowTokens).not.toBe(OLLAMA_WORKSPACE_CONTEXT_CEILING_TOKENS);
  });

  it('keeps the requested window OUT of the routing-facing description entirely', async () => {
    const runtime = recordingRuntime({ contextLength: 262_144 });
    const result = await runOnce(runtime);
    const usage = result.attempts[0].agent.usage as Record<string, unknown>;

    // The requested window is on the EXECUTION record, where a run is described…
    expect(usage.localModelContextWindowRequestedTokens).toBe(OLLAMA_WORKSPACE_CONTEXT_CEILING_TOKENS);

    // …and nowhere in the description or the observation, which are what routing reads. Neither
    // carries a field for it, and neither has the ceiling as a value anywhere.
    const description = describeLocalModel(
      { modelID: MODEL, runtimeDigest: DIGEST, contextLengthTokens: usage.localModelContextLengthTokens as number },
      { machine: MACHINE.machineKey, observedAt: '2026-09-22T12:00:00Z', runtimeVersion: '0.34.0', endpoint: 'http://127.0.0.1:11434' });
    const [observation] = observationsFromLocalModels(
      [{ modelID: MODEL, runtimeDigest: DIGEST, contextLengthTokens: usage.localModelContextLengthTokens as number }],
      '2026-09-22T12:00:00Z', '0.34.0');

    for (const routingFacing of [description, observation] as unknown as Record<string, unknown>[]) {
      expect(Object.keys(routingFacing)).not.toContain('localModelContextWindowRequestedTokens');
      expect(Object.keys(routingFacing)).not.toContain('contextCeilingTokens');
      expect(JSON.stringify(routingFacing)).not.toContain(String(OLLAMA_WORKSPACE_CONTEXT_CEILING_TOKENS));
    }
  });
});
