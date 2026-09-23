// Cernum · the STREAMING Ollama workspace driver, and the runtime probe that runs before a case.
//
// WHAT THIS FILE IS FOR. A local qualification pass could not tell these four situations apart:
// a model generating slowly, a runtime that never started the request, another model occupying the
// runtime, and a socket that died ten minutes before anyone noticed. All four looked the same —
// silence, then one `timeout` — because `/api/chat` was requested with `stream: false`, which writes
// NOTHING until it writes EVERYTHING. That made every timing figure from that pass provisional.
//
// WHAT THIS FILE DOES NOT CLAIM. Nothing here is evidence about a defect in Ollama. The standalone
// repro of the suspected upstream failure was never reliable, and no test pretends otherwise. What
// is asserted is narrower and entirely about Cernum: that the driver now OBSERVES a generation while
// it happens, measures time to first token or honestly records that there was none, lets Cernum's
// own deadline and cancellation interrupt an ACTIVE stream, reads the runtime's state before it
// begins, and keeps every earlier guarantee — the window, the ceiling, the digest, loopback — intact.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { FetchLike, loopbackHTTPFetch } from '../../src/core/ollama-http';
import { BROKEN_SUM_MEAN } from '../../src/engine/workspace-catalog';
import { runWorkspaceCase } from '../../src/engine/workspace-execution';
import { TranscriptBuilder } from '../../src/engine/workspace-transcript';
import {
  LocalRuntimeClient, OLLAMA_FAILURE_FOR_STREAM_OUTCOME, OLLAMA_STREAM_OUTCOMES,
  OLLAMA_WORKSPACE_CONTEXT_CEILING_TOKENS, OllamaWorkspaceDriver,
} from '../../src/engine/workspace-ollama-driver';
import { byteStreamOf, streamedChatNDJSON, streamedChatResponse } from './ollama-stream-fake';

const FIXTURE_ROOT = path.resolve(__dirname, '../../fixtures');
const MODEL = 'qwen-coder-fixture:14b';
const OTHER_MODEL = 'another-fixture:8b';
const DIGEST = 'sha256:1111111111111111111111111111111111111111111111111111111111111111';
const MACHINE = { machineKey: 'cmk1:fixture-machine-a', label: 'fixture-host-a', platform: 'darwin-arm64' };
const ENDPOINT = 'http://127.0.0.1:11434';

const temporaries: string[] = [];
const servers: http.Server[] = [];
let realFetch: typeof fetch;
beforeEach(() => {
  // NO ACCIDENTAL NETWORK. Every request in this file goes through an injected fake or a loopback
  // server this file started; the global is a tripwire.
  realFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async () => { throw new Error('a test reached the real fetch'); }) as unknown as typeof fetch;
});
afterEach(async () => {
  vi.useRealTimers();
  globalThis.fetch = realFetch;
  for (const directory of temporaries.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
});
function temporary(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaries.push(directory);
  return directory;
}

const call = (name: string, args: Record<string, unknown>) => ({ function: { name, arguments: args } });

interface RuntimeOptions {
  /** One entry per chat turn. The last is reused if the model asks for more turns than were scripted. */
  turns?: Parameters<typeof streamedChatResponse>[0][];
  /** Replaces the chat handler entirely, for HTTP failures and empty streams. */
  chat?: (init: { signal: AbortSignal }) => unknown;
  running?: unknown[] | 'unsupported' | 'unreachable';
  contextLength?: number | null;
  capabilities?: string[];
  digest?: string;
}

/** A fake runtime whose `/api/chat` STREAMS, and which records every URL it was asked for. */
function fakeRuntime(options: RuntimeOptions = {}) {
  const urls: string[] = [];
  const chatBodies: Record<string, unknown>[] = [];
  const cancellations: number[] = [];
  let turnIndex = 0;
  const respond = (status: number, value: unknown) => ({ status, text: async () => JSON.stringify(value) });
  const fetchImpl: FetchLike = async (url, init) => {
    urls.push(url);
    const route = new URL(url).pathname;
    if (route === '/api/version') return respond(200, { version: '0.34.0' });
    if (route === '/api/tags') {
      return respond(200, { models: [{ name: MODEL, model: MODEL, digest: options.digest ?? DIGEST, size: 9_000_000_000,
        details: { family: 'qwen', parameter_size: '14B', quantization_level: 'Q4_K_M' } }] });
    }
    if (route === '/api/show') {
      return respond(200, { capabilities: options.capabilities ?? ['completion', 'tools'],
        model_info: options.contextLength === null ? {} : { 'qwen.context_length': options.contextLength ?? 262_144 } });
    }
    if (route === '/api/ps') {
      if (options.running === 'unsupported') return respond(404, { error: 'not found' });
      if (options.running === 'unreachable') throw new Error('connect ECONNREFUSED 127.0.0.1:11434');
      return respond(200, { models: options.running ?? [] });
    }
    if (route === '/api/chat') {
      chatBodies.push(init.body === undefined ? {} : JSON.parse(init.body) as Record<string, unknown>);
      if (options.chat !== undefined) return options.chat({ signal: init.signal }) as ReturnType<FetchLike> extends Promise<infer T> ? T : never;
      const scripted = options.turns ?? [{ model: MODEL, content: 'done', promptEvalCount: 900, evalCount: 60 }];
      const turn = scripted[Math.min(turnIndex, scripted.length - 1)];
      turnIndex += 1;
      const at = turnIndex;
      return streamedChatResponse({ ...turn, signal: init.signal, onCancelled: () => cancellations.push(at) });
    }
    return respond(404, { error: 'not found' });
  };
  return { fetchImpl, urls, chatBodies, cancellations };
}

function driverWith(runtime: ReturnType<typeof fakeRuntime>, overrides: Partial<{ expectedDigest: string; contextCeilingTokens: number }> = {}) {
  return new OllamaWorkspaceDriver({
    requestedModelID: MODEL, expectedDigest: overrides.expectedDigest ?? DIGEST, fetch: runtime.fetchImpl,
    machine: MACHINE, contextCeilingTokens: overrides.contextCeilingTokens, endpoint: ENDPOINT,
  });
}

async function runCase(runtime: ReturnType<typeof fakeRuntime>, overrides: Parameters<typeof driverWith>[1] = {}) {
  return runWorkspaceCase({
    case: BROKEN_SUM_MEAN, driver: driverWith(runtime, overrides), fixtureRoot: FIXTURE_ROOT,
    sandboxRoot: temporary('cernum-ws-stream-'),
    environmentSource: { PATH: process.env.PATH, HOME: process.env.HOME, USER: 'someone' } as NodeJS.ProcessEnv,
  });
}

const client = (runtime: ReturnType<typeof fakeRuntime>) => new LocalRuntimeClient(ENDPOINT, runtime.fetchImpl);

// 1 · 2 ─────────────────────────────────────────────────────────────────────────────────────────
describe('1 · 2 · the parser reads EVENTS, not network chunks', () => {
  it('reassembles a turn delivered as many chunks, none of which is a whole JSON event', async () => {
    // Seven bytes per chunk: every event in this stream straddles several, and several events share one.
    const runtime = fakeRuntime({ turns: [{ model: MODEL, content: 'the fix is in place', chunkBytes: 7,
      promptEvalCount: 111, evalCount: 22 }] });
    const outcome = await client(runtime).chatStream({ model: MODEL, messages: [] }, 10_000);

    expect(outcome.outcome).toBe('completed');
    expect(outcome.content).toBe('the fix is in place');
    expect(outcome.eventCount).toBeGreaterThan(1);
  });

  it('carries a JSON event split across two transport chunks, and a split multi-byte character with it', async () => {
    const text = streamedChatNDJSON({ model: MODEL, content: 'héllo wörld — ünicode', promptEvalCount: 5, evalCount: 6 });
    // ONE BYTE AT A TIME. Every event boundary and every multi-byte character is cut in half.
    const stream = byteStreamOf(text, { chunkBytes: 1 });
    const runtime = fakeRuntime({ chat: () => ({ status: 200, text: async () => text, body: stream }) });
    const outcome = await client(runtime).chatStream({ model: MODEL, messages: [] }, 10_000);

    expect(outcome.outcome).toBe('completed');
    expect(outcome.content).toBe('héllo wörld — ünicode');
  });

  it('never double-counts a usage figure, however the stream was cut', async () => {
    for (const chunkBytes of [1, 3, 13, 4_096]) {
      const runtime = fakeRuntime({ turns: [{ model: MODEL, content: 'one two three', chunkBytes,
        promptEvalCount: 1_234, evalCount: 77, totalDuration: 9e9 }] });
      const outcome = await client(runtime).chatStream({ model: MODEL, messages: [] }, 10_000);
      expect(outcome.promptEvalCount).toBe(1_234);
      expect(outcome.evalCount).toBe(77);
      expect(outcome.totalDurationNanoseconds).toBe(9e9);
    }
  });

  it('reads a terminal event that arrives without a closing newline', async () => {
    const text = streamedChatNDJSON({ model: MODEL, content: 'x', evalCount: 3 }).replace(/\n$/, '');
    const runtime = fakeRuntime({ chat: () => ({ status: 200, text: async () => text, body: byteStreamOf(text, { chunkBytes: 5 }) }) });
    const outcome = await client(runtime).chatStream({ model: MODEL, messages: [] }, 10_000);
    expect(outcome.outcome).toBe('completed');
    expect(outcome.evalCount).toBe(3);
  });
});

// 3 · 4 ─────────────────────────────────────────────────────────────────────────────────────────
describe('3 · 4 · time to first token is MEASURED, or it is absent with a reason', () => {
  it('times the first token from the request, not the end of the turn', async () => {
    // 200 ms of silence, then tokens. Under the non-streaming driver the only observable was the
    // END of the turn, so this figure would have been the whole turn's length.
    const runtime = fakeRuntime({ turns: [{ model: MODEL, content: 'a b c d e f', chunkBytes: 4_096,
      delayMilliseconds: [200, 5, 5], evalCount: 6 }] });
    const outcome = await client(runtime).chatStream({ model: MODEL, messages: [] }, 10_000);

    expect(outcome.outcome).toBe('completed');
    expect(outcome.firstTokenMilliseconds).toBeGreaterThanOrEqual(180);
    // …and well before the turn ended, which is the whole point of measuring it.
    expect(outcome.firstTokenMilliseconds!).toBeLessThan(outcome.streamEndedAt - outcome.streamStartedAt + 1);
    expect(outcome.firstTokenUnavailableReason).toBeUndefined();
  });

  it('does not count the opening of a stream as a token', async () => {
    // An event with no content, no thinking and no tool call is the runtime clearing its throat.
    const text = `${JSON.stringify({ model: MODEL, message: { role: 'assistant', content: '' }, done: false })}\n`
      + streamedChatNDJSON({ model: MODEL, content: 'later', evalCount: 1 });
    const runtime = fakeRuntime({ chat: () => ({ status: 200, text: async () => text,
      body: byteStreamOf(text, { chunkPerLine: true, delayMilliseconds: [0, 120] }) }) });
    const outcome = await client(runtime).chatStream({ model: MODEL, messages: [] }, 10_000);

    expect(outcome.firstEventMilliseconds).toBeLessThan(outcome.firstTokenMilliseconds!);
    expect(outcome.firstTokenMilliseconds).toBeGreaterThanOrEqual(100);
  });

  it('INVENTS NO TTFT when no token ever arrived, and says why instead', async () => {
    const runtime = fakeRuntime({ turns: [{ model: MODEL, content: '', evalCount: 0 }] });
    const outcome = await client(runtime).chatStream({ model: MODEL, messages: [] }, 10_000);

    expect(outcome.outcome).toBe('completed');
    expect(outcome.firstTokenMilliseconds).toBeUndefined();
    expect(outcome.firstTokenUnavailableReason).toContain('without the runtime ever emitting');
  });

  it('puts the attempt\'s first token on the record, and the reason on a record that has none', async () => {
    const withToken = await runCase(fakeRuntime({ turns: [{ model: MODEL, content: 'finished', evalCount: 4,
      chunkBytes: 4_096, delayMilliseconds: [60] }] }));
    const usage = withToken.attempts[0].agent.usage as Record<string, unknown>;
    expect(usage.observedFirstOutputMilliseconds as number).toBeGreaterThanOrEqual(50);
    expect(usage.localFirstTokenUnavailableReason).toBeUndefined();

    const withoutToken = await runCase(fakeRuntime({ turns: [{ model: MODEL, content: '' }] }));
    const silent = withoutToken.attempts[0].agent.usage as Record<string, unknown>;
    expect(silent.observedFirstOutputMilliseconds).toBeUndefined();
    expect(String(silent.localFirstTokenUnavailableReason).length).toBeGreaterThan(0);
  });
});

// 5 · 6 · 7 ─────────────────────────────────────────────────────────────────────────────────────
describe('5 · 6 · 7 · the terminal event is where the counts and the durations come from', () => {
  it('captures prompt_eval_count, eval_count and every duration the terminal event carried', async () => {
    const runtime = fakeRuntime({ turns: [{ model: MODEL, content: 'ok', chunkBytes: 9,
      promptEvalCount: 3_006, evalCount: 201, totalDuration: 197_418_506_434, loadDuration: 2_427_581,
      promptEvalDuration: 120_000_000_000, evalDuration: 77_000_000_000, doneReason: 'stop' }] });
    const outcome = await client(runtime).chatStream({ model: MODEL, messages: [] }, 10_000);

    expect(outcome).toMatchObject({
      outcome: 'completed', done: true, doneReason: 'stop',
      promptEvalCount: 3_006, evalCount: 201, totalDurationNanoseconds: 197_418_506_434,
      loadDurationNanoseconds: 2_427_581, promptEvalDurationNanoseconds: 120_000_000_000,
      evalDurationNanoseconds: 77_000_000_000,
    });
  });

  it('leaves a figure the terminal event omitted ABSENT, never zero', async () => {
    const runtime = fakeRuntime({ turns: [{ model: MODEL, content: 'ok' }] });
    const outcome = await client(runtime).chatStream({ model: MODEL, messages: [] }, 10_000);
    expect(outcome.promptEvalCount).toBeUndefined();
    expect(outcome.evalCount).toBeUndefined();
  });

  it('carries one telemetry row per streamed turn onto the record', async () => {
    const result = await runCase(fakeRuntime({ turns: [
      { model: MODEL, content: '', toolCalls: [call('list_files', {})], promptEvalCount: 800, evalCount: 12 },
      { model: MODEL, content: 'done', promptEvalCount: 900, evalCount: 30, totalDuration: 5e9 },
    ] }));
    const usage = result.attempts[0].agent.usage as Record<string, unknown>;
    const raw = usage.rawUsage as { streamedTurns: Record<string, unknown>[] };

    expect(raw.streamedTurns).toHaveLength(2);
    expect(raw.streamedTurns[0]).toMatchObject({ turn: 1, outcome: 'completed', done: true, evalCount: 12 });
    expect(raw.streamedTurns[1]).toMatchObject({ turn: 2, outcome: 'completed', evalCount: 30 });
    for (const row of raw.streamedTurns) {
      expect(row.streamOpenedAtMillisecondsIntoAttempt as number).toBeGreaterThanOrEqual(0);
      expect(row.streamClosedAtMillisecondsIntoAttempt as number).toBeGreaterThanOrEqual(row.streamOpenedAtMillisecondsIntoAttempt as number);
    }
    // Summed from the terminal events, each counted once.
    expect(usage.inputTokens).toBe(1_700);
    expect(usage.visibleOutputTokens).toBe(42);
    expect(usage.localStreamOutcome).toBe('completed');
  });
});

// 8 · 19 ────────────────────────────────────────────────────────────────────────────────────────
describe('8 · 19 · Cernum\'s deadline and cancellation interrupt an ACTIVE stream', () => {
  it('closes a stream that is open and silent when the deadline passes, and names that silence', async () => {
    const runtime = fakeRuntime({ turns: [{ model: MODEL, content: 'never arrives', hangAfterChunks: 0 }] });
    const outcome = await client(runtime).chatStream({ model: MODEL, messages: [] }, 250);

    expect(outcome.outcome).toBe('noFirstTokenBeforeDeadline');
    expect(outcome.firstTokenMilliseconds).toBeUndefined();
    // THE STREAM WAS CLOSED, not merely abandoned: no socket is left reading into nothing.
    expect(runtime.cancellations).toEqual([1]);
  });

  it('distinguishes a model that WAS generating when the deadline passed', async () => {
    // One event per chunk, 80 ms apart: tokens ARE arriving when the 300 ms deadline lands.
    const runtime = fakeRuntime({ turns: [{ model: MODEL, content: 'one two three four five six',
      chunkPerLine: true, delayMilliseconds: 80 }] });
    const outcome = await client(runtime).chatStream({ model: MODEL, messages: [] }, 300);

    expect(outcome.outcome).toBe('generationExceededDeadline');
    expect(outcome.firstTokenMilliseconds).toBeDefined();
    expect(outcome.detail).toContain('first token at');
  });

  it('stops on cancellation, and calls it cancellation rather than a timeout', async () => {
    const runtime = fakeRuntime({ turns: [{ model: MODEL, content: 'slow', hangAfterChunks: 0 }] });
    let cancel = false;
    const pending = client(runtime).chatStream({ model: MODEL, messages: [] }, 30_000, () => cancel);
    setTimeout(() => { cancel = true; }, 120);
    const outcome = await pending;

    expect(outcome.outcome).toBe('cancelledByCernum');
    expect(runtime.cancellations).toEqual([1]);
  });

});

// 18 ────────────────────────────────────────────────────────────────────────────────────────────
describe('18 · a generation longer than the platform\'s old 300 s ceiling survives inside a sealed deadline', () => {
  it('completes a 400 s generation under a 900 s deadline, with the first token timed at 310 s', async () => {
    // SIMULATED TIME, REAL CODE PATH. The clock is the only fake: the driver's own deadline timer,
    // the abort wiring and the NDJSON parser all run exactly as they do in life. A generation whose
    // first token lands at 310 s is one the platform's own 300 s header deadline used to kill.
    vi.useFakeTimers();
    const runtime = fakeRuntime({ turns: [{ model: MODEL, content: 'a long answer', chunkBytes: 4_096,
      delayMilliseconds: [310_000, 90_000], promptEvalCount: 3_000, evalCount: 400 }] });
    const pending = client(runtime).chatStream({ model: MODEL, messages: [] }, 900_000);
    await vi.advanceTimersByTimeAsync(500_000);
    const outcome = await pending;

    expect(outcome.outcome).toBe('completed');
    expect(outcome.firstTokenMilliseconds).toBeGreaterThanOrEqual(300_000);
    expect(outcome.evalCount).toBe(400);
  });

  it('and the same generation is cut off when the deadline is shorter than it', async () => {
    vi.useFakeTimers();
    const runtime = fakeRuntime({ turns: [{ model: MODEL, content: 'a long answer', chunkBytes: 4_096,
      delayMilliseconds: [310_000, 90_000], evalCount: 400 }] });
    const pending = client(runtime).chatStream({ model: MODEL, messages: [] }, 200_000);
    await vi.advanceTimersByTimeAsync(400_000);
    const outcome = await pending;

    expect(outcome.outcome).toBe('noFirstTokenBeforeDeadline');
    expect(outcome.evalCount).toBeUndefined();
  });
});

// 9 · 13 ────────────────────────────────────────────────────────────────────────────────────────
describe('9 · 13 · a broken stream, an empty one and a refused request are three different findings', () => {
  it('classifies a transport failure mid-stream as its own outcome, keeping what had arrived', async () => {
    const text = streamedChatNDJSON({ model: MODEL, content: 'partial answer here', evalCount: 9 });
    const runtime = fakeRuntime({ chat: () => ({ status: 200, text: async () => text,
      body: byteStreamOf(text, { chunkPerLine: true, failAfterChunks: 2 }) }) });
    const outcome = await client(runtime).chatStream({ model: MODEL, messages: [] }, 10_000);

    expect(outcome.outcome).toBe('streamTransportFailure');
    expect(outcome.detail).toContain('ECONNRESET');
    expect(outcome.eventCount).toBeGreaterThan(0);
    // The counts never arrived, so they are absent rather than partial.
    expect(outcome.evalCount).toBeUndefined();
    expect(OLLAMA_FAILURE_FOR_STREAM_OUTCOME.streamTransportFailure).toBe('transport');
  });

  it('calls an HTTP failure what it is: the runtime answered, and no model event was ever streamed', async () => {
    const runtime = fakeRuntime({ chat: () => ({ status: 500, text: async () => '{"error":"XML syntax error on line 4"}' }) });
    const outcome = await client(runtime).chatStream({ model: MODEL, messages: [] }, 10_000);

    expect(outcome.outcome).toBe('requestNeverReachedModel');
    expect(outcome.httpStatus).toBe(500);
    expect(outcome.detail).toContain('XML syntax error');
    expect(outcome.firstTokenUnavailableReason).toContain('streamed no model event');
  });

  it('calls a 200 that closes without a single event what it is, rather than a timeout', async () => {
    const runtime = fakeRuntime({ chat: () => ({ status: 200, text: async () => '', body: byteStreamOf('') }) });
    const outcome = await client(runtime).chatStream({ model: MODEL, messages: [] }, 10_000);

    expect(outcome.outcome).toBe('requestNeverReachedModel');
    expect(outcome.detail).toContain('without a single event');
  });

  it('reads an error event on the stream as the runtime\'s failure, placed by whether a model had run', async () => {
    const before = fakeRuntime({ chat: () => {
      const text = `${JSON.stringify({ error: 'unable to load model' })}\n`;
      return { status: 200, text: async () => text, body: byteStreamOf(text) };
    } });
    expect((await client(before).chatStream({ model: MODEL, messages: [] }, 10_000)).outcome).toBe('requestNeverReachedModel');

    const during = fakeRuntime({ chat: () => {
      const text = streamedChatNDJSON({ model: MODEL, content: 'half an answer', omitTerminalEvent: true })
        + `${JSON.stringify({ error: 'the runtime gave up' })}\n`;
      return { status: 200, text: async () => text, body: byteStreamOf(text) };
    } });
    const outcome = await client(during).chatStream({ model: MODEL, messages: [] }, 10_000);
    expect(outcome.outcome).toBe('streamTransportFailure');
    expect(outcome.detail).toContain('the runtime gave up');
  });

  it('rejects a malformed payload honestly instead of silently dropping it', async () => {
    const text = streamedChatNDJSON({ model: MODEL, content: 'good so far', omitTerminalEvent: true, trailingRaw: 'this is not json\n' });
    const runtime = fakeRuntime({ chat: () => ({ status: 200, text: async () => text, body: byteStreamOf(text, { chunkBytes: 11 }) }) });
    const outcome = await client(runtime).chatStream({ model: MODEL, messages: [] }, 10_000);

    expect(outcome.outcome).toBe('streamPayloadMalformed');
    expect(outcome.malformedEventCount).toBe(1);
    expect(OLLAMA_FAILURE_FOR_STREAM_OUTCOME.streamPayloadMalformed).toBe('malformedOutput');
  });

  it('keeps what the model HAD produced when a turn did not finish, marked as partial', async () => {
    // Under the non-streaming driver this evidence did not exist: an unfinished turn left nothing at
    // all on the record, because the whole reply was still inside the runtime when the clock ran out.
    const runtime = fakeRuntime({ turns: [{ model: MODEL, content: 'I will start by reading the file',
      chunkPerLine: true, delayMilliseconds: 40, hangAfterChunks: 3 }] });
    const driver = driverWith(runtime);
    const transcript = new TranscriptBuilder(0, () => 0);
    const result = await driver.run({
      caseID: 'c', caseVersion: '1', caseDigest: 'x', attemptIndex: 0, maximumAttempts: 1, instruction: 'fix it',
      workspaceRoot: temporary('cernum-ws-partial-'), scope: { allowed: [], forbidden: [] },
      tools: { fileRead: true, fileWrite: true, commandExecution: false, allowedExecutables: [] },
      networkPolicy: 'providerOnly', environment: {}, timeoutMilliseconds: 400, transcript,
    });

    expect(result.failure?.kind).toBe('timeout');
    expect(result.failure?.detail).toContain('generationExceededDeadline');
    const partial = result.events.find((event) => event.kind === 'message' && String(event.reason ?? '').startsWith('partialBefore:'));
    expect(partial).toBeDefined();
    expect(String(partial?.detail).length).toBeGreaterThan(0);
    expect(partial?.reason).toBe('partialBefore:generationExceededDeadline');
  });

  it('a stream that just ends, with no terminal event, is not reported as a completed turn', async () => {
    const runtime = fakeRuntime({ turns: [{ model: MODEL, content: 'unfinished', omitTerminalEvent: true }] });
    const outcome = await client(runtime).chatStream({ model: MODEL, messages: [] }, 10_000);

    expect(outcome.outcome).toBe('streamTransportFailure');
    expect(outcome.done).toBe(false);
    expect(outcome.detail).toContain('without the runtime\'s terminal done event');
  });

  it('every outcome has exactly one translation into the vocabulary all routes share', () => {
    for (const outcome of OLLAMA_STREAM_OUTCOMES) {
      expect(OLLAMA_FAILURE_FOR_STREAM_OUTCOME).toHaveProperty(outcome);
    }
    expect(OLLAMA_FAILURE_FOR_STREAM_OUTCOME.completed).toBeUndefined();
    // The two timing outcomes stay DISTINCT here while sharing a kind there. That is the point of
    // keeping both: the shared kind is comparable across routes, the outcome says what happened.
    expect(OLLAMA_FAILURE_FOR_STREAM_OUTCOME.noFirstTokenBeforeDeadline).toBe('timeout');
    expect(OLLAMA_FAILURE_FOR_STREAM_OUTCOME.generationExceededDeadline).toBe('timeout');
    expect(new Set(OLLAMA_STREAM_OUTCOMES).size).toBe(OLLAMA_STREAM_OUTCOMES.length);
  });
});

// 10 ────────────────────────────────────────────────────────────────────────────────────────────
describe('10 · a runtime that never answers is the machine\'s fault, and is said so before anything is sent', () => {
  it('reports an unreachable runtime as unavailable, having measured nothing', async () => {
    const runtime = fakeRuntime({ chat: () => { throw new Error('connect ECONNREFUSED 127.0.0.1:11434'); } });
    const outcome = await client(runtime).chatStream({ model: MODEL, messages: [] }, 10_000);

    expect(outcome.outcome).toBe('runtimeUnavailable');
    expect(outcome.eventCount).toBe(0);
    expect(outcome.firstTokenUnavailableReason).toContain('never answered with response headers');
  });

  it('a case against a runtime that is not there fails before the first chat, as driverUnavailable', async () => {
    const dead: FetchLike = async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:11434'); };
    const driver = new OllamaWorkspaceDriver({ requestedModelID: MODEL, expectedDigest: DIGEST, fetch: dead, machine: MACHINE });
    const result = await runWorkspaceCase({
      case: BROKEN_SUM_MEAN, driver, fixtureRoot: FIXTURE_ROOT, sandboxRoot: temporary('cernum-ws-dead-'),
      environmentSource: { PATH: process.env.PATH, HOME: process.env.HOME, USER: 'someone' } as NodeJS.ProcessEnv,
    });
    expect(result.attempts[0].agent.failure?.kind).toBe('notInstalled');
    expect(result.attempts[0].terminationReason).toBe('driverUnavailable');
  });
});

// 11 · 12 ───────────────────────────────────────────────────────────────────────────────────────
describe('11 · 12 · the runtime is asked what it is holding, once, before the case', () => {
  it('reads an idle runtime as idle — and an idle runtime is not an error', async () => {
    const runtime = fakeRuntime({ running: [] });
    const probe = await client(runtime).probe(MODEL, 2_000);

    expect(probe).toMatchObject({ residency: 'noModelResident', residentModels: [] });
    expect(probe.detail).toBeUndefined();
    expect(probe.elapsedMilliseconds).toBeGreaterThanOrEqual(0);
  });

  it('says when THIS model is already resident, and when another model holds the runtime', async () => {
    expect((await client(fakeRuntime({ running: [{ name: MODEL, size_vram: 9e9 }] })).probe(MODEL, 2_000)).residency)
      .toBe('thisModelResident');
    expect((await client(fakeRuntime({ running: [{ name: OTHER_MODEL, size_vram: 9e9 }] })).probe(MODEL, 2_000)).residency)
      .toBe('otherModelsResident');
    const both = await client(fakeRuntime({ running: [{ name: OTHER_MODEL }, { name: MODEL }] })).probe(MODEL, 2_000);
    expect(both.residency).toBe('thisAndOtherModelsResident');
    expect(both.residentModels).toEqual([OTHER_MODEL, MODEL].sort());
  });

  it('separates a runtime too old for the probe from one that will not answer it', async () => {
    expect((await client(fakeRuntime({ running: 'unsupported' })).probe(MODEL, 2_000)).residency).toBe('probeUnsupported');
    const unreachable = await client(fakeRuntime({ running: 'unreachable' })).probe(MODEL, 2_000);
    expect(unreachable.residency).toBe('probeUnavailable');
    expect(unreachable.detail).toContain('did not answer');
  });

  it('is BOUNDED: a runtime that never answers the probe does not hold the case open', async () => {
    const slow = fakeRuntime({ running: [] });
    const hanging: FetchLike = async (url, init) => {
      if (new URL(url).pathname !== '/api/ps') return slow.fetchImpl(url, init);
      return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    };
    const started = Date.now();
    const probe = await new LocalRuntimeClient(ENDPOINT, hanging).probe(MODEL, 300);

    expect(probe.residency).toBe('probeUnavailable');
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('puts the probe on the record and in the disclosure, without letting it decide anything', async () => {
    const runtime = fakeRuntime({ running: [{ name: OTHER_MODEL }], turns: [{ model: MODEL, content: 'done', evalCount: 2 }] });
    const result = await runCase(runtime);
    const attempt = result.attempts[0];
    const usage = attempt.agent.usage as Record<string, unknown>;

    expect(usage.localRuntimeResidencyBefore).toBe('otherModelsResident');
    expect(usage.localRuntimeResidentModelsBefore).toEqual([OTHER_MODEL]);
    expect(attempt.agent.activeIsolation.some((line) => line.includes('runtime state before this case: otherModelsResident'))).toBe(true);
    // A busy runtime is DISCLOSED, never a refusal: the case still ran.
    expect(attempt.agent.failure).toBeUndefined();
    expect(runtime.urls.some((url) => url.endsWith('/api/ps'))).toBe(true);
  });

  it('never polls: ONE probe per attempt, and then it gets on with the case', async () => {
    const runtime = fakeRuntime({ running: [], turns: [
      { model: MODEL, content: '', toolCalls: [call('list_files', {})] },
      { model: MODEL, content: 'done' },
    ] });
    const result = await runCase(runtime);
    // BROKEN_SUM_MEAN allows a second attempt, and this model fixes nothing, so it takes both. One
    // probe each is the property: the state is read once where a case begins, and never waited on.
    expect(runtime.urls.filter((url) => url.endsWith('/api/ps'))).toHaveLength(result.attempts.length);
    expect(runtime.urls.filter((url) => url.endsWith('/api/chat')).length).toBeGreaterThan(result.attempts.length);
  });
});

// 14 · 15 · 16 · 17 · 20 ────────────────────────────────────────────────────────────────────────
describe('14 · 15 · 16 · 17 · 20 · streaming changed the observation, and nothing else', () => {
  it('still asks for the measured window, now on a streamed request', async () => {
    const runtime = fakeRuntime({ contextLength: 16_384, turns: [{ model: MODEL, content: 'done' }] });
    await runCase(runtime);

    for (const body of runtime.chatBodies) {
      expect(body.stream).toBe(true);
      expect((body.options as Record<string, unknown>).num_ctx).toBe(16_384);
    }
  });

  it('still bounds the request by the harness ceiling, and still records the measured length beside it', async () => {
    const runtime = fakeRuntime({ contextLength: 262_144, turns: [{ model: MODEL, content: 'done' }] });
    const result = await runCase(runtime);

    expect((runtime.chatBodies[0].options as Record<string, unknown>).num_ctx).toBe(OLLAMA_WORKSPACE_CONTEXT_CEILING_TOKENS);
    const usage = result.attempts[0].agent.usage as Record<string, unknown>;
    expect(usage.localModelContextLengthTokens).toBe(262_144);
    expect(usage.localModelContextWindowRequestedTokens).toBe(OLLAMA_WORKSPACE_CONTEXT_CEILING_TOKENS);
  });

  it('still invents no window when the runtime published no context length', async () => {
    const runtime = fakeRuntime({ contextLength: null, turns: [{ model: MODEL, content: 'done' }] });
    await runCase(runtime);
    expect(Object.keys(runtime.chatBodies[0].options as Record<string, unknown>)).not.toContain('num_ctx');
  });

  it('still refuses weights that are not the frozen ones, before anything is streamed', async () => {
    const runtime = fakeRuntime({ digest: 'sha256:9999', turns: [{ model: MODEL, content: 'done' }] });
    const result = await runCase(runtime);

    expect(result.attempts[0].agent.failure?.kind).toBe('policyNotExpressible');
    expect(runtime.urls.some((url) => url.endsWith('/api/chat'))).toBe(false);
  });

  it('still reads the digest again after the last turn', async () => {
    const result = await runCase(fakeRuntime({ turns: [{ model: MODEL, content: 'done' }] }));
    expect(result.attempts[0].agent.activeIsolation.some((line) => line.includes('and after the last'))).toBe(true);
  });

  it('still refuses a non-loopback endpoint, on the streaming path as on every other', async () => {
    for (const endpoint of ['http://192.168.1.20:11434', 'http://example.com:11434', 'http://0.0.0.0:11434']) {
      expect(() => new LocalRuntimeClient(endpoint, loopbackHTTPFetch())).toThrow(/not loopback/);
    }
    expect(() => new LocalRuntimeClient('https://127.0.0.1:11434', loopbackHTTPFetch())).toThrow(/is not http/);
    // Defence in depth: the transport itself refuses, even handed a URL a client did not check.
    await expect(loopbackHTTPFetch()('http://example.com/api/chat', { method: 'POST', signal: new AbortController().signal }))
      .rejects.toThrow(/not loopback/);
  });

  it('sends nothing anywhere but loopback, and never touches the platform fetch', async () => {
    const runtime = fakeRuntime({ running: [{ name: MODEL }], turns: [
      { model: MODEL, content: '', toolCalls: [call('read_file', { path: 'src/stats.js' })] },
      { model: MODEL, content: 'done' },
    ] });
    await runCase(runtime);

    expect(runtime.urls.length).toBeGreaterThan(0);
    for (const url of runtime.urls) expect(url.startsWith('http://127.0.0.1:11434/')).toBe(true);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

// The streamed body over a REAL loopback socket, because the transport is half of this fix.
describe('the node:http transport delivers a body incrementally, over a real socket', () => {
  it('hands the response over at the HEADERS and yields each write as it lands', async () => {
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/x-ndjson' });
      response.write(`${JSON.stringify({ model: MODEL, message: { role: 'assistant', content: 'first' }, done: false })}\n`);
      setTimeout(() => {
        response.write(`${JSON.stringify({ model: MODEL, message: { role: 'assistant', content: ' second' }, done: true, eval_count: 2 })}\n`);
        response.end();
      }, 150);
    });
    servers.push(server);
    const endpoint = await new Promise<string>((resolve) => server.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
    }));

    const outcome = await new LocalRuntimeClient(endpoint, loopbackHTTPFetch()).chatStream({ model: MODEL, messages: [] }, 10_000);

    expect(outcome.outcome).toBe('completed');
    expect(outcome.content).toBe('first second');
    expect(outcome.evalCount).toBe(2);
    // The first token was observed BEFORE the second write, which is the property the whole fix rests on.
    expect(outcome.firstTokenMilliseconds!).toBeLessThan(140);
  });

  it('a stream cut off by the deadline mid-body is a deadline, not a completed turn', async () => {
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/x-ndjson' });
      response.write(`${JSON.stringify({ model: MODEL, message: { role: 'assistant', content: 'begun' }, done: false })}\n`);
      // …and never finishes.
    });
    servers.push(server);
    const endpoint = await new Promise<string>((resolve) => server.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
    }));

    const outcome = await new LocalRuntimeClient(endpoint, loopbackHTTPFetch()).chatStream({ model: MODEL, messages: [] }, 300);

    expect(outcome.outcome).toBe('generationExceededDeadline');
    expect(outcome.content).toBe('begun');
    expect(outcome.evalCount).toBeUndefined();
  });
});
