// Honest streaming telemetry: measure what arrived, when it arrived, and refuse to say more.
//
// The behaviour these tests exist to pin is negative as much as positive. Before this pass the live
// path computed a first-token time from the runtime's reported durations and split the token count
// between channels at four characters per token, and both landed in the evidence as `measured`.
// Neither was measured. So there are tests here that assert a value is UNAVAILABLE, and they matter
// more than the ones that assert a number: an unavailable-with-a-reason is a thing a reader can act
// on, and a plausible invention is not.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CancellationToken } from '../../src/core/adapter';
import { LiveExecutionAuthorization, OllamaHTTPTransport, FetchLike } from '../../src/core/ollama-http';
import {
  OllamaChatRequest, OllamaTransportFailure, chatRequestBody, chatStreamChunkFrom, chatStreamRequestBody, supportsStreaming,
} from '../../src/core/ollama';
import { summariseAttempt } from '../../src/engine/attempt-telemetry';
import { LiveHost } from '../../src/engine/live-host';
import { buildEngineCatalogue } from '../../src/engine/catalogue';
import { Campaign, CampaignConfiguration } from '../../src/engine/campaign';
import { SystemReading, GIB } from '../../src/engine/guards';
import { syntheticCandidate, SYNTHETIC_HARDWARE } from '../../src/engine/synthetic';

const AUTHORIZATION = LiveExecutionAuthorization.explicit(true, true)!;
const ENDPOINT = 'http://127.0.0.1:11434';

const REQUEST: OllamaChatRequest = {
  model: 'llama3.2:3b',
  messages: [{ role: 'user', content: 'hello' }],
  stopSequences: [],
  requireJSONFormat: false,
  thinkingMode: 'disabled',
  timeoutMilliseconds: 30_000,
};

// MARK: - Fake streams

interface Line { text: string; afterMilliseconds?: number }

/**
 * A `fetch` that hands back NDJSON one line at a time, on a real clock.
 *
 * Real delays rather than a fake clock, because the thing under test is that the arrival time is
 * read from the client's own clock at the moment bytes land. A fake clock would let a reconstruction
 * pass as an observation, which is exactly the defect being removed.
 */
function streamingFetch(lines: Line[], options: { status?: number; errorBody?: string; failAfter?: number } = {}): FetchLike {
  const encoder = new TextEncoder();
  return (async (_url: string, init: { signal: AbortSignal }) => {
    if (options.status !== undefined && options.status >= 300) {
      return { status: options.status, text: async () => options.errorBody ?? '', body: null };
    }
    let index = 0;
    return {
      status: 200,
      text: async () => lines.map((line) => line.text).join('\n'),
      body: {
        getReader: () => ({
          read: async () => {
            if (options.failAfter !== undefined && index === options.failAfter) {
              throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
            }
            if (index >= lines.length) return { done: true, value: undefined };
            const line = lines[index++];
            if (line.afterMilliseconds) await new Promise((resolve) => setTimeout(resolve, line.afterMilliseconds));
            // A real body reader rejects once the request is aborted. Honouring the signal here is
            // what makes the cancellation test a test of the transport rather than of the fake.
            if (init.signal.aborted) throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
            return { done: false, value: encoder.encode(line.text + '\n') };
          },
          cancel: async () => undefined,
        }),
      },
    };
  }) as unknown as FetchLike;
}

function chunk(fields: Record<string, unknown>): string {
  return JSON.stringify(fields);
}
function visible(text: string): string {
  return chunk({ model: 'llama3.2:3b', message: { role: 'assistant', content: text }, done: false });
}
function thinking(text: string): string {
  return chunk({ model: 'llama3.2:3b', message: { role: 'assistant', content: '', thinking: text }, done: false });
}
function done(fields: Record<string, unknown> = {}): string {
  return chunk({
    model: 'llama3.2:3b', message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop',
    total_duration: 2_000_000_000, load_duration: 30_000_000, prompt_eval_count: 12,
    prompt_eval_duration: 100_000_000, eval_count: 20, eval_duration: 1_000_000_000, ...fields,
  });
}

// MARK: - The wire

describe('the streaming request', () => {
  it('is the non-streaming request with streaming turned on, and nothing else changed', () => {
    const plain = JSON.parse(chatRequestBody(REQUEST)) as Record<string, unknown>;
    const streamed = JSON.parse(chatStreamRequestBody(REQUEST)) as Record<string, unknown>;
    expect(plain.stream).toBe(false);
    expect(streamed.stream).toBe(true);
    expect({ ...streamed, stream: false }).toEqual(plain);
  });

  it('refuses a line that does not decode rather than treating it as an empty chunk', () => {
    expect(() => chatStreamChunkFrom('{"model": "x", "message"')).toThrow(OllamaTransportFailure);
    expect(() => chatStreamChunkFrom('[]')).toThrow(/not a JSON object/);
  });

  it('separates the two channels a chunk can carry', () => {
    const parsed = chatStreamChunkFrom(chunk({ message: { content: 'answer', thinking: 'reasoning' }, done: false }));
    expect(parsed.contentDelta).toBe('answer');
    expect(parsed.thinkingDelta).toBe('reasoning');
    expect(parsed.done).toBe(false);
  });
});

describe('the streaming transport', () => {
  it('declares itself streamable, and reports each line as it lands', async () => {
    const transport = new OllamaHTTPTransport(ENDPOINT, AUTHORIZATION,
      streamingFetch([{ text: visible('Hel'), afterMilliseconds: 40 }, { text: visible('lo'), afterMilliseconds: 40 }, { text: done() }]));
    expect(supportsStreaming(transport)).toBe(true);

    const arrivals: number[] = [];
    const report = await transport.chatStream(REQUEST, new CancellationToken(), (_chunk, atMilliseconds) => arrivals.push(atMilliseconds));
    expect(report.content).toBe('Hello');
    expect(report.evalCount).toBe(20);
    expect(report.doneReason).toBe('stop');
    expect(arrivals).toHaveLength(3);
    // The first arrival is the FIRST line's, not the whole response's.
    expect(arrivals[0]).toBeGreaterThanOrEqual(30);
    expect(arrivals[1]).toBeGreaterThan(arrivals[0]);
  });

  it('treats a stream that stops before the runtime says done as incomplete', async () => {
    const transport = new OllamaHTTPTransport(ENDPOINT, AUTHORIZATION,
      streamingFetch([{ text: visible('half an ans') }]));
    await expect(transport.chatStream(REQUEST, new CancellationToken(), () => undefined))
      .rejects.toThrow(/ended before the runtime reported done/);
  });

  it('reports a mid-stream disconnect as a connection failure, not a short answer', async () => {
    const transport = new OllamaHTTPTransport(ENDPOINT, AUTHORIZATION,
      streamingFetch([{ text: visible('start') }, { text: visible('more') }], { failAfter: 1 }));
    await expect(transport.chatStream(REQUEST, new CancellationToken(), () => undefined))
      .rejects.toMatchObject({ kind: 'connectionFailed' });
  });

  it('reports a malformed line as a malformed response', async () => {
    const transport = new OllamaHTTPTransport(ENDPOINT, AUTHORIZATION,
      streamingFetch([{ text: visible('fine') }, { text: 'not json at all' }, { text: done() }]));
    await expect(transport.chatStream(REQUEST, new CancellationToken(), () => undefined))
      .rejects.toMatchObject({ kind: 'malformedResponse' });
  });

  it('abandons the stream when the caller cancels', async () => {
    const cancellation = new CancellationToken();
    const transport = new OllamaHTTPTransport(ENDPOINT, AUTHORIZATION,
      streamingFetch([{ text: visible('one'), afterMilliseconds: 20 }, { text: visible('two'), afterMilliseconds: 400 }, { text: done() }]));
    const pending = transport.chatStream(REQUEST, cancellation, (_chunk, _at) => { cancellation.cancel(); });
    await expect(pending).rejects.toMatchObject({ kind: 'cancelled' });
  });

  it('refuses a runtime that accepts a stream and then does not stream', async () => {
    const noBody = (async () => ({ status: 200, text: async () => done(), body: null })) as unknown as FetchLike;
    const transport = new OllamaHTTPTransport(ENDPOINT, AUTHORIZATION, noBody);
    await expect(transport.chatStream(REQUEST, new CancellationToken(), () => undefined))
      .rejects.toThrow(/no readable stream, so no arrival time could be observed/);
  });

  it('still reports a model that is not installed, from a streaming request', async () => {
    const transport = new OllamaHTTPTransport(ENDPOINT, AUTHORIZATION,
      streamingFetch([], { status: 404, errorBody: "model 'ghost:1b' not found" }));
    await expect(transport.chatStream(REQUEST, new CancellationToken(), () => undefined))
      .rejects.toMatchObject({ kind: 'modelNotFound', model: 'ghost:1b' });
  });
});

// MARK: - What the telemetry is allowed to claim

describe('token counts are the runtime\'s, or they are unavailable', () => {
  it('gives a visible-only answer the runtime\'s own completion count', () => {
    const telemetry = summariseAttempt(
      [{ channel: 'visible', atMilliseconds: 120 }, { channel: 'visible', atMilliseconds: 300 }],
      { evalTokenCount: 20, evalDurationNanoseconds: 1_000_000_000, doneReason: 'stop' }, 400);
    expect(telemetry.visibleTokenCount).toEqual({ measured: 20 });
    expect(telemetry.thinkingTokenCount).toEqual({ measured: 0 });
    expect(telemetry.completionTokenCount).toEqual({ measured: 20 });
    expect(telemetry.timeToFirstTokenMilliseconds).toEqual({ measured: 120 });
    expect(telemetry.thinkingOnly).toBe(false);
  });

  it('refuses to split one combined count between two active channels', () => {
    const telemetry = summariseAttempt(
      [{ channel: 'thinking', atMilliseconds: 90 }, { channel: 'visible', atMilliseconds: 500 }],
      { evalTokenCount: 64, evalDurationNanoseconds: 2_000_000_000, doneReason: 'stop' }, 600);
    expect(telemetry.visibleTokenCount).toEqual({
      unavailableReason: 'the runtime reported one combined completion token count and no per-channel split, and this engine does not estimate a token count from text length',
    });
    expect(telemetry.thinkingTokenCount).toEqual(telemetry.visibleTokenCount);
    // The combined figure IS reported, because the runtime reported it.
    expect(telemetry.completionTokenCount).toEqual({ measured: 64 });
    // And both arrival times are real observations, timed apart.
    expect(telemetry.firstThinkingTokenMilliseconds).toEqual({ measured: 90 });
    expect(telemetry.timeToFirstTokenMilliseconds).toEqual({ measured: 500 });
  });

  it('gives a thinking-only answer the whole completion count, and explains the empty reply', () => {
    const telemetry = summariseAttempt(
      [{ channel: 'thinking', atMilliseconds: 55 }],
      { evalTokenCount: 1024, evalDurationNanoseconds: 9_000_000_000, doneReason: 'length' }, 9_500);
    expect(telemetry.thinkingTokenCount).toEqual({ measured: 1024 });
    expect(telemetry.visibleTokenCount).toEqual({ measured: 0 });
    expect(telemetry.thinkingOnly).toBe(true);
    expect(telemetry.timeToFirstTokenMilliseconds).toEqual({
      unavailableReason: 'the stream carried no visible-answer token, so there was no first token to time',
    });
  });

  it('says so when the runtime reported no count at all', () => {
    const telemetry = summariseAttempt(
      [{ channel: 'thinking', atMilliseconds: 10 }, { channel: 'visible', atMilliseconds: 20 }], {}, 30);
    expect(telemetry.visibleTokenCount).toEqual({
      unavailableReason: 'the runtime reported no completion token count, and this engine does not estimate one from text length',
    });
    expect(telemetry.completionTokenCount).toEqual({ unavailableReason: 'the runtime reported no completion token count' });
  });

  it('keeps counting per event when the host really does count per event', () => {
    const telemetry = summariseAttempt(
      [{ channel: 'thinking', tokens: 7, atMilliseconds: 10 }, { channel: 'visible', tokens: 13, atMilliseconds: 20 }],
      { evalTokenCount: 20, evalDurationNanoseconds: 1_000_000_000 }, 30);
    expect(telemetry.thinkingTokenCount).toEqual({ measured: 7 });
    expect(telemetry.visibleTokenCount).toEqual({ measured: 13 });
  });

  it('reports no first-token time at all when nothing was watched', () => {
    const telemetry = summariseAttempt([], { evalTokenCount: 20, evalDurationNanoseconds: 1_000_000_000 }, 400);
    expect(telemetry.timeToFirstTokenMilliseconds).toEqual({
      unavailableReason: 'the adapter did not stream, so no token arrival time was observed',
    });
    expect(telemetry.streamed).toBe(false);
    expect(telemetry.visibleTokenCount).toEqual({
      unavailableReason: 'the adapter did not stream, so no token arrival time was observed',
    });
  });
});

// MARK: - The live host

const CATALOGUE = buildEngineCatalogue(['suite.model-lab.foundation'], 1);
const CASE_ID = [...CATALOGUE.cases.keys()][0];

function slot() {
  return {
    slotIndex: 0, slotKey: `llama3.2:3b|foundation|1|${CASE_ID}`, candidate: 'llama3.2:3b', modelID: 'llama3.2:3b',
    suite: 'foundation', block: 'foundation', pass: 1, caseID: CASE_ID, caseDigest: 'digest', comparabilityKey: 'key',
    scoringMode: 'automatic', maxOutputTokens: 512, inputBudgetTokens: 2048, status: 'planned' as const,
  };
}

function liveHost(fetchImpl: FetchLike, options: { stream?: boolean } = {}): LiveHost {
  return new LiveHost({
    endpoint: ENDPOINT,
    catalogue: CATALOGUE,
    stream: options.stream,
    transport: new OllamaHTTPTransport(ENDPOINT, AUTHORIZATION, fetchImpl),
  });
}

describe('the live host measures arrival instead of reconstructing it', () => {
  it('times the first VISIBLE token from the clock, not from a reported duration', async () => {
    const host = liveHost(streamingFetch([
      { text: thinking('let me see'), afterMilliseconds: 40 },
      { text: visible('The answer'), afterMilliseconds: 120 },
      { text: done() },
    ]));
    const outcome = await host.run({ slot: slot(), promptText: 'p', maxOutputTokens: 512 });
    expect(outcome.failure).toBeUndefined();
    expect(outcome.answerText).toBe('The answer');

    const events = outcome.streamEvents;
    expect(events.map((event) => event.channel)).toEqual(['thinking', 'visible']);
    // Not one of them carries a token count: the runtime publishes one combined figure at the end.
    expect(events.every((event) => event.tokens === undefined)).toBe(true);
    // The runtime SAID it spent 30ms loading and 100ms on the prompt. The reconstruction this pass
    // removed would have put the first token at ~130ms. The observation is the real ~160ms.
    expect(events[1].atMilliseconds).toBeGreaterThanOrEqual(150);
    expect(outcome.runtime.loadDurationNanoseconds).toBe(30_000_000);

    const telemetry = summariseAttempt(outcome.streamEvents, outcome.runtime, outcome.totalElapsedMilliseconds);
    expect(telemetry.streamed).toBe(true);
    expect('measured' in telemetry.timeToFirstTokenMilliseconds).toBe(true);
    expect((telemetry.timeToFirstTokenMilliseconds as { measured: number }).measured).toBeGreaterThanOrEqual(150);
  });

  it('records no arrival time at all when streaming is turned off', async () => {
    const nonStreaming = (async () => ({ status: 200, text: async () => done({ message: { content: 'answer' } }) })) as unknown as FetchLike;
    const host = liveHost(nonStreaming, { stream: false });
    const outcome = await host.run({ slot: slot(), promptText: 'p', maxOutputTokens: 512 });
    expect(outcome.streamEvents).toEqual([]);
    const telemetry = summariseAttempt(outcome.streamEvents, outcome.runtime, outcome.totalElapsedMilliseconds);
    expect(telemetry.timeToFirstTokenMilliseconds).toEqual({
      unavailableReason: 'the adapter did not stream, so no token arrival time was observed',
    });
  });

  it('keeps the arrivals it did observe when the stream breaks', async () => {
    const host = liveHost(streamingFetch([
      { text: visible('it began'), afterMilliseconds: 30 },
      { text: visible('and then') },
    ], { failAfter: 1 }));
    const outcome = await host.run({ slot: slot(), promptText: 'p', maxOutputTokens: 512 });
    expect(outcome.failure?.code).toBe('ollama.chatFailed');
    expect(outcome.failure?.detail).toMatch(/ECONNRESET|connectionFailed/);
    expect(outcome.streamEvents).toHaveLength(1);
    expect(outcome.answerText).toBe('');
  });

  it('reports a malformed stream as a failure rather than a short answer', async () => {
    const host = liveHost(streamingFetch([{ text: visible('good') }, { text: '<html>gateway error</html>' }]));
    const outcome = await host.run({ slot: slot(), promptText: 'p', maxOutputTokens: 512 });
    expect(outcome.failure).toBeDefined();
    expect(outcome.answerText).toBe('');
  });
});

// MARK: - Through a whole campaign, and across a resume

/** The real live host, with only the machine reading faked, so the streaming path stays real. */
class BenchHost extends LiveHost {
  async readSystem(): Promise<SystemReading> {
    return {
      freeDiskBytes: 500 * GIB, swapUsedBytes: 0, freeMemoryBytes: 16 * GIB, totalMemoryBytes: 32 * GIB,
      listeners: { '11434': 1234 }, modelStoreListingDigest: 'unchanged', modelStoreCount: 1,
    };
  }
}

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-streaming-')); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function campaignConfiguration(): CampaignConfiguration {
  return {
    label: 'streamed campaign',
    suiteIDs: ['suite.model-lab.foundation'],
    repeatsPerCase: 1,
    candidates: [{ ...syntheticCandidate('llama3.2:3b'), runtimeDigest: 'sha256:pinned', parameterSize: '3.2B', quantization: 'Q4_K_M' }],
    hardware: SYNTHETIC_HARDWARE,
    runtimeVersion: 'ollama-0.33.2',
    guardPolicy: { minimumFreeDiskBytes: GIB, maximumSwapUsedBytes: 64 * GIB, minimumFreeMemoryMilli: 10, benchmarkPort: 11434, portsThatMustBeQuiet: [] },
    residencyDelayMilliseconds: 0,
  };
}

/** A fetch that answers `api/tags`, `api/show`, `api/ps` and streams `api/chat`. */
function campaignFetch(): FetchLike {
  const encoder = new TextEncoder();
  return (async (url: string) => {
    if (url.includes('api/tags')) {
      return { status: 200, text: async () => JSON.stringify({ models: [{ name: 'llama3.2:3b', digest: 'sha256:pinned', size: 1, details: { quantization_level: 'Q4_K_M', parameter_size: '3.2B', family: 'llama' } }] }) };
    }
    if (url.includes('api/show')) return { status: 200, text: async () => JSON.stringify({ details: {}, model_info: {} }) };
    if (url.includes('api/ps')) return { status: 200, text: async () => JSON.stringify({ models: [] }) };
    const lines = [
      { text: thinking('considering'), afterMilliseconds: 15 },
      { text: visible('Paris is the capital of France.'), afterMilliseconds: 35 },
      { text: done() },
    ];
    let index = 0;
    return {
      status: 200,
      text: async () => lines.map((line) => line.text).join('\n'),
      body: {
        getReader: () => ({
          read: async () => {
            if (index >= lines.length) return { done: true, value: undefined };
            const line = lines[index++];
            if (line.afterMilliseconds) await new Promise((resolve) => setTimeout(resolve, line.afterMilliseconds));
            return { done: false, value: encoder.encode(line.text + '\n') };
          },
          cancel: async () => undefined,
        }),
      },
    };
  }) as unknown as FetchLike;
}

function benchHost(): BenchHost {
  return new BenchHost({
    endpoint: ENDPOINT, catalogue: CATALOGUE, enableResidency: true,
    transport: new OllamaHTTPTransport(ENDPOINT, AUTHORIZATION, campaignFetch()),
  });
}

describe('a streamed campaign, paused and resumed', () => {
  it('records an observed first-token time on every attempt, and never re-runs one on resume', async () => {
    const configuration = campaignConfiguration();
    const campaign = Campaign.create(root, configuration, benchHost());

    const first = await campaign.run({ maxAttempts: 2, owner: { processType: 'terminal', command: 'cernum run streamed' } });
    expect(first.state).toBe('paused');
    expect(first.terminalCount).toBe(2);
    const afterPause = [...campaign.ledger.results.values()].map((result) => result.slotKey);

    const resumed = Campaign.open(root, configuration, benchHost());
    const finished = await resumed.run({ owner: { processType: 'terminal', command: 'cernum resume streamed' } });
    expect(finished.state).toBe('complete');
    expect(finished.reconciliation.balances).toBe(true);
    expect(finished.reconciliation.duplicateTerminalResults).toBe(0);

    const results = [...resumed.ledger.results.values()];
    // Every attempt from before the pause survived, byte for byte, with its measured arrival time.
    for (const key of afterPause) expect(resumed.ledger.isTerminal(key)).toBe(true);
    for (const result of results) {
      expect(result.streamed).toBe(true);
      expect(typeof result.timeToFirstTokenMilliseconds).toBe('number');
      expect(result.timeToFirstTokenMilliseconds as number).toBeGreaterThanOrEqual(40);
      // Both channels were active, so neither per-channel count is claimed.
      expect(result.visibleTokenCount).toBeUndefined();
      expect(result.thinkingTokenCount).toBeUndefined();
    }
  });
});
