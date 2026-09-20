// Cernum · what a metered API request is allowed to forget.
//
// TWO THINGS WERE BEING DROPPED ON THE WAY OUT OF THE METERED ADAPTER, and both were invisible
// because what replaced them looked like an answer.
//
//   1. THE PROVIDER'S OWN USAGE BLOCK. The parser produced it under the name `raw`; the response
//      type carries it under the name `rawUsage`; the adapter spread the one into the other and TypeScript
//      had nothing to object to, because an extra property on a spread is not an error. So every
//      metered attempt recorded `providerReportedUsage: undefined` while the provider had in fact
//      reported usage, and the one artefact that could be reconciled against a bill was never written.
//
//   2. THE TERMINAL REASON. The host wrote `'stop'` for every attempt that did not fail, so an
//      answer the output ceiling cut in half and an answer that finished were the same record. On a
//      benchmark with a frozen `maxOutputTokens`, that is the difference between a model that
//      answered badly and a model that was not allowed to finish.
//
// NOTHING HERE CONTACTS A PROVIDER. The metered tests drive the loopback mock, the subscription
// tests drive a fake executable on disk, and the campaign tests drive the real orchestration through
// both. A test in this file that reached OpenAI or Anthropic would be the defect it is looking for.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Campaign } from '../../src/engine/campaign';
import {
  MeteredAPIAdapter, SubscriptionCLIAdapter, parseAPIResponse, parseCLIResponse,
} from '../../src/engine/frontier-adapter';
import { endedAtOutputLimit, explainTruncatedAnswer, summariseAttempt } from '../../src/engine/attempt-telemetry';
import { identitySmokeTest } from '../../src/engine/identity-smoke';
import { buildSmokeBinding } from '../../src/engine/smoke-binding';
import { authorizeSpending, estimateSpending } from '../../src/engine/spending';
import { operationalEnvelopeDigest } from '../../src/engine/provider';
import { plannedWorkFor } from '../../src/engine/campaign-builder';
import {
  catalogue, configurationFor, envelopeOf, meteredBinding, routingHost, scriptedAdapter,
  startMockProvider, subscriptionBinding, temporaryRoot, writeFakeCLI,
} from './frontier-harness';
import { FIXTURE_ANTHROPIC_KEY, FIXTURE_OPENAI_KEY } from '../secret-fixtures';

const openAICredentials = { environment: { OPENAI_API_KEY: FIXTURE_OPENAI_KEY }, readKeychain: () => undefined };
const anthropicCredentials = { environment: { ANTHROPIC_API_KEY: FIXTURE_ANTHROPIC_KEY }, readKeychain: () => undefined };

/** The chat-completions body an OpenAI-compatible API returns when it is not streaming. */
function openAIBody(options: { finishReason?: string | null; usage?: unknown; model?: string } = {}): string {
  const body: Record<string, unknown> = {
    model: options.model ?? 'gpt-5.6-sol',
    choices: [{
      message: { role: 'assistant', content: 'an answer' },
      ...(options.finishReason === undefined ? { finish_reason: 'stop' } : { finish_reason: options.finishReason }),
    }],
  };
  if (options.usage !== null) {
    body.usage = options.usage ?? {
      prompt_tokens: 9, completion_tokens: 3, total_tokens: 76,
      completion_tokens_details: { reasoning_tokens: 64, accepted_prediction_tokens: 0 },
      prompt_tokens_details: { cached_tokens: 0 },
    };
  }
  return JSON.stringify(body);
}

/** The same turn as a stream: text first, then the frame that carries the terminal reason and usage. */
function openAIFrames(options: { finishReason?: string | null; usage?: unknown; extraTerminal?: string } = {}): string[] {
  const frames = [
    JSON.stringify({ model: 'gpt-5.6-sol', choices: [{ delta: { role: 'assistant' }, finish_reason: null }] }),
    JSON.stringify({ model: 'gpt-5.6-sol', choices: [{ delta: { content: 'an answer' }, finish_reason: null }] }),
  ];
  if (options.extraTerminal !== undefined) {
    frames.push(JSON.stringify({ model: 'gpt-5.6-sol', choices: [{ delta: {}, finish_reason: options.extraTerminal }] }));
  }
  frames.push(JSON.stringify({
    model: 'gpt-5.6-sol',
    choices: [{ delta: {}, ...(options.finishReason === undefined ? { finish_reason: 'stop' } : { finish_reason: options.finishReason }) }],
    ...(options.usage === null ? {} : {
      usage: options.usage ?? {
        prompt_tokens: 9, completion_tokens: 3, total_tokens: 76,
        completion_tokens_details: { reasoning_tokens: 64 },
      },
    }),
  }));
  return frames;
}

// MARK: - Mission 1 · the provider's own usage block survives the adapter

describe('what a metered attempt records about what the provider said it used', () => {
  it('carries a NON-STREAMED OpenAI usage block into rawUsage, verbatim', async () => {
    const provider = await startMockProvider(openAIBody());
    try {
      const adapter = new MeteredAPIAdapter({
        provider: 'openaiAPI', baseURL: provider.baseURL, stream: false, credentials: openAICredentials,
      });
      const response = await adapter.complete({ binding: meteredBinding('openaiAPI:gpt-5.6-sol', 'openaiAPI'), promptText: 'x' });

      expect(response.failure).toBeUndefined();
      // THE REGRESSION. Before the fix this was undefined on every metered attempt ever made.
      expect(response.rawUsage).toEqual({
        prompt_tokens: 9, completion_tokens: 3, total_tokens: 76,
        completion_tokens_details: { reasoning_tokens: 64, accepted_prediction_tokens: 0 },
        prompt_tokens_details: { cached_tokens: 0 },
      });
      // And the property the parser used internally does not leak out under its own name.
      expect((response as unknown as Record<string, unknown>).raw).toBeUndefined();
    } finally { await provider.close(); }
  });

  it('carries a STREAMED OpenAI usage block into rawUsage, from the frame that carried it', async () => {
    const provider = await startMockProvider('');
    try {
      provider.streamFrames(openAIFrames());
      const adapter = new MeteredAPIAdapter({ provider: 'openaiAPI', baseURL: provider.baseURL, credentials: openAICredentials });
      const response = await adapter.complete({ binding: meteredBinding('openaiAPI:gpt-5.6-sol', 'openaiAPI'), promptText: 'x' });

      expect(response.failure).toBeUndefined();
      expect(response.rawUsage).toEqual({
        prompt_tokens: 9, completion_tokens: 3, total_tokens: 76,
        completion_tokens_details: { reasoning_tokens: 64 },
      });
    } finally { await provider.close(); }
  });

  it('PRESERVES THE REASONING DECOMPOSITION the normalised usage flattens to a single number', async () => {
    const provider = await startMockProvider(openAIBody({
      usage: {
        prompt_tokens: 9, completion_tokens: 3,
        completion_tokens_details: { reasoning_tokens: 64, rejected_prediction_tokens: 11, audio_tokens: 0 },
      },
    }));
    try {
      const adapter = new MeteredAPIAdapter({
        provider: 'openaiAPI', baseURL: provider.baseURL, stream: false, credentials: openAICredentials,
      });
      const response = await adapter.complete({ binding: meteredBinding('openaiAPI:gpt-5.6-sol', 'openaiAPI'), promptText: 'x' });

      // The normalised field keeps the one figure this engine prices on.
      expect(response.usage.reasoningTokens).toBe(64);
      // The raw block keeps the three the provider actually broke it into — the ones a bill shows
      // and the ones a later reconciliation needs, which no normalised field has room for.
      const details = (response.rawUsage as Record<string, Record<string, number>>).completion_tokens_details;
      expect(details).toEqual({ reasoning_tokens: 64, rejected_prediction_tokens: 11, audio_tokens: 0 });
    } finally { await provider.close(); }
  });

  it('records NO usage block when the provider reported none, rather than an empty one it made up', async () => {
    const provider = await startMockProvider(openAIBody({ usage: null }));
    try {
      const adapter = new MeteredAPIAdapter({
        provider: 'openaiAPI', baseURL: provider.baseURL, stream: false, credentials: openAICredentials,
      });
      const response = await adapter.complete({ binding: meteredBinding('openaiAPI:gpt-5.6-sol', 'openaiAPI'), promptText: 'x' });

      expect(response.answerText).toBe('an answer');
      // `null` is the parser saying "the envelope carried no usage". It is not `{}`, and it is not
      // a zero: nothing here invents a count the provider declined to give.
      expect(response.rawUsage).toBeNull();
      expect(response.usage.inputTokens).toBeUndefined();
      expect(response.usage.visibleOutputTokens).toBeUndefined();
      expect(response.usageProvenance).toBe('unavailable');
    } finally { await provider.close(); }
  });

  it('keeps BOTH halves of an Anthropic stream\'s split usage report, instead of letting the last one erase the first', async () => {
    const provider = await startMockProvider('');
    try {
      provider.streamFrames([
        JSON.stringify({ type: 'message_start', message: { model: 'm', usage: { input_tokens: 12, cache_read_input_tokens: 6 } } }),
        JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } }),
        JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }),
      ]);
      const adapter = new MeteredAPIAdapter({ provider: 'anthropicAPI', baseURL: provider.baseURL, credentials: anthropicCredentials });
      const response = await adapter.complete({ binding: meteredBinding('anthropicAPI:m'), promptText: 'x' });

      // This API splits one usage report across two events. A raw block holding the output count and
      // no input count is not reconcilable against anything.
      expect(response.rawUsage).toEqual({ input_tokens: 12, cache_read_input_tokens: 6, output_tokens: 5 });
      expect(response.usage.inputTokens).toBe(12);
      expect(response.usage.visibleOutputTokens).toBe(5);
    } finally { await provider.close(); }
  });

  it('DOES NOT LET THE RAW BLOCK TOUCH THE NORMALISED COUNTS, whatever else it contains', async () => {
    // A provider whose raw block carries a total this engine does not use and a decomposition it
    // does. The normalised fields must read exactly the documented keys and nothing else.
    const provider = await startMockProvider(openAIBody({
      usage: {
        prompt_tokens: 100, completion_tokens: 7, total_tokens: 999_999,
        completion_tokens_details: { reasoning_tokens: 40 },
      },
    }));
    try {
      const adapter = new MeteredAPIAdapter({
        provider: 'openaiAPI', baseURL: provider.baseURL, stream: false, credentials: openAICredentials,
      });
      const response = await adapter.complete({ binding: meteredBinding('openaiAPI:gpt-5.6-sol', 'openaiAPI'), promptText: 'x' });

      expect(response.usage).toEqual({ inputTokens: 100, visibleOutputTokens: 7, reasoningTokens: 40 });
      expect(response.usageProvenance).toBe('providerReported');
      expect((response.rawUsage as Record<string, number>).total_tokens).toBe(999_999);
    } finally { await provider.close(); }
  });

  it('leaves the SUBSCRIPTION CLI path exactly as it was — it never had this defect', async () => {
    const fake = writeFakeCLI('claude', `
      cat > /dev/null
      echo '{"result":"an answer","model":"sonnet","usage":{"input_tokens":10,"output_tokens":4,"cache_read_input_tokens":6000}}'
    `);
    try {
      const adapter = new SubscriptionCLIAdapter({ provider: 'claudeCLI', executablePath: fake.executablePath });
      const response = await adapter.complete({ binding: subscriptionBinding('claudeCLI:sonnet'), promptText: 'x' });

      expect(response.failure).toBeUndefined();
      expect(response.rawUsage).toEqual({ input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 6000 });
      expect(response.usage.inputTokens).toBe(10);
      expect(response.usage.cacheReadInputTokens).toBe(6000);
      // The parser's own field is unchanged too, so nothing downstream of it was renamed.
      const parsed = parseCLIResponse('{"result":"a","model":"sonnet","usage":{"input_tokens":1}}');
      expect(parsed?.raw).toEqual({ input_tokens: 1 });
    } finally { fake.cleanup(); }
  });
});

// MARK: - Mission 1 · and reaches the evidence

describe('where the provider\'s usage block ends up', () => {
  it('reaches an identity smoke\'s evidence record as providerReportedUsage', async () => {
    const provider = await startMockProvider('');
    try {
      provider.streamFrames(openAIFrames());
      const binding = buildSmokeBinding({ provider: 'openaiAPI', modelID: 'gpt-5.6-sol', effort: 'low' });
      const adapter = new MeteredAPIAdapter({ provider: 'openaiAPI', baseURL: provider.baseURL, credentials: openAICredentials });
      const result = await identitySmokeTest(binding, adapter);

      expect(result.verdict).toBe('proven');
      // The field the four proven OpenAI identity records were written without.
      expect(result.providerReportedUsage).toEqual({
        prompt_tokens: 9, completion_tokens: 3, total_tokens: 76,
        completion_tokens_details: { reasoning_tokens: 64 },
      });
    } finally { await provider.close(); }
  });

  it('reaches every campaign row, through the real host, ledger and adapter', async () => {
    const campaignRoot = temporaryRoot('metered-evidence-');
    const provider = await startMockProvider('');
    try {
      provider.streamFrames(openAIFrames());
      const envelope = envelopeOf(meteredBinding('openaiAPI:gpt-5.6-sol', 'openaiAPI'));
      const authorization = authorizeSpending(
        estimateSpending(envelope, plannedWorkFor(catalogue(1), ['openaiAPI:gpt-5.6-sol'], 1)),
        {
          campaignID: 'c', authorizedAt: 'now', authorizedBy: 'the test',
          hardCeilingMicroUSD: 1_000_000_000, operationalEnvelopeDigest: operationalEnvelopeDigest(envelope),
        });
      const adapter = new MeteredAPIAdapter({ provider: 'openaiAPI', baseURL: provider.baseURL, credentials: openAICredentials });
      const { host } = routingHost({ envelope, adapters: { openaiAPI: adapter }, authorization });
      const campaign = Campaign.create(path.join(campaignRoot, 'run'), configurationFor(envelope), host);
      campaign.writeAuthorization(authorization);
      const status = await campaign.run({ campaignRootDirectory: campaignRoot });

      expect(status.state).toBe('complete');
      const rows = [...campaign.ledger.results.values()];
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.providerReportedUsage).toEqual({
          prompt_tokens: 9, completion_tokens: 3, total_tokens: 76,
          completion_tokens_details: { reasoning_tokens: 64 },
        });
        // The normalised columns are untouched by it and still read what they always read.
        expect(row.inputTokens).toBe(9);
        expect(row.visibleOutputTokens).toBe(3);
        expect(row.reasoningTokens).toBe(64);
        expect(row.usageProvenance).toBe('providerReported');
      }
    } finally {
      await provider.close();
      fs.rmSync(campaignRoot, { recursive: true, force: true });
    }
  });
});

// MARK: - Mission 2 · why generation stopped

describe('the terminal reason a metered response carries', () => {
  it('distinguishes stop from length on a NON-STREAMED response', async () => {
    const provider = await startMockProvider(openAIBody({ finishReason: 'stop' }));
    try {
      const adapter = new MeteredAPIAdapter({
        provider: 'openaiAPI', baseURL: provider.baseURL, stream: false, credentials: openAICredentials,
      });
      const binding = meteredBinding('openaiAPI:gpt-5.6-sol', 'openaiAPI');
      expect((await adapter.complete({ binding, promptText: 'x' })).finishReason).toBe('stop');

      provider.respondWith(200, openAIBody({ finishReason: 'length' }));
      const truncated = await adapter.complete({ binding, promptText: 'x' });
      expect(truncated.finishReason).toBe('length');
      // The answer is still an answer. What changed is that the record no longer claims it finished.
      expect(truncated.answerText).toBe('an answer');
      expect(truncated.failure).toBeUndefined();
    } finally { await provider.close(); }
  });

  it('distinguishes stop from length on a STREAMED response, from the final frame', async () => {
    const provider = await startMockProvider('');
    const adapter = () => new MeteredAPIAdapter({ provider: 'openaiAPI', baseURL: provider.baseURL, credentials: openAICredentials });
    const binding = meteredBinding('openaiAPI:gpt-5.6-sol', 'openaiAPI');
    try {
      provider.streamFrames(openAIFrames({ finishReason: 'stop' }));
      expect((await adapter().complete({ binding, promptText: 'x' })).finishReason).toBe('stop');

      provider.streamFrames(openAIFrames({ finishReason: 'length' }));
      const truncated = await adapter().complete({ binding, promptText: 'x' });
      expect(truncated.finishReason).toBe('length');
      // The usage on that same final frame still arrived, so truncation and accounting agree.
      expect(truncated.usage.visibleOutputTokens).toBe(3);
    } finally { await provider.close(); }
  });

  it('is NOT ERASED by the `finish_reason: null` every earlier frame carries', async () => {
    const provider = await startMockProvider('');
    try {
      // The terminal reason arrives, and then a trailing usage-only frame arrives after it. A reader
      // that took the last value it saw regardless would record "no reason" for a finished response.
      provider.streamFrames([
        JSON.stringify({ model: 'gpt-5.6-sol', choices: [{ delta: { content: 'an answer' }, finish_reason: null }] }),
        JSON.stringify({ model: 'gpt-5.6-sol', choices: [{ delta: {}, finish_reason: 'length' }] }),
        JSON.stringify({ model: 'gpt-5.6-sol', choices: [], usage: { prompt_tokens: 9, completion_tokens: 3 } }),
      ]);
      const adapter = new MeteredAPIAdapter({ provider: 'openaiAPI', baseURL: provider.baseURL, credentials: openAICredentials });
      const response = await adapter.complete({ binding: meteredBinding('openaiAPI:gpt-5.6-sol', 'openaiAPI'), promptText: 'x' });

      expect(response.finishReason).toBe('length');
      expect(response.rawUsage).toEqual({ prompt_tokens: 9, completion_tokens: 3 });
    } finally { await provider.close(); }
  });

  it('takes the LAST terminal reason when a stream carries two, because that is the completed one', async () => {
    const provider = await startMockProvider('');
    try {
      // Ambiguous terminal information: a frame that says the answer finished, and then a later one
      // that says the ceiling ended it. Reading the first would report a truncated answer as whole,
      // which is the error this whole mission is about, so the later frame wins and it is stated here
      // rather than left to whichever order the loop happened to use.
      provider.streamFrames(openAIFrames({ extraTerminal: 'stop', finishReason: 'length' }));
      const adapter = new MeteredAPIAdapter({ provider: 'openaiAPI', baseURL: provider.baseURL, credentials: openAICredentials });
      const response = await adapter.complete({ binding: meteredBinding('openaiAPI:gpt-5.6-sol', 'openaiAPI'), promptText: 'x' });

      expect(response.finishReason).toBe('length');
    } finally { await provider.close(); }
  });

  it('leaves the terminal reason UNAVAILABLE when the provider named none, and never guesses `stop`', async () => {
    const provider = await startMockProvider(openAIBody({ finishReason: null }));
    try {
      const adapter = new MeteredAPIAdapter({
        provider: 'openaiAPI', baseURL: provider.baseURL, stream: false, credentials: openAICredentials,
      });
      const binding = meteredBinding('openaiAPI:gpt-5.6-sol', 'openaiAPI');
      expect((await adapter.complete({ binding, promptText: 'x' })).finishReason).toBeUndefined();

      // Absent key, not a null one: the same answer, for the same reason.
      provider.respondWith(200, JSON.stringify({ model: 'gpt-5.6-sol', choices: [{ message: { content: 'an answer' } }] }));
      const silent = await adapter.complete({ binding, promptText: 'x' });
      expect(silent.answerText).toBe('an answer');
      expect(silent.finishReason).toBeUndefined();
    } finally { await provider.close(); }
  });

  it('keeps a provider\'s own vocabulary rather than translating it into somebody else\'s', () => {
    // Anthropic says `end_turn` and `max_tokens` where OpenAI says `stop` and `length`. Both are
    // recorded in the words the provider used; the reading that treats the two dialects as one
    // event lives in `endedAtOutputLimit`, where it can be seen.
    expect(parseAPIResponse('anthropicAPI', JSON.stringify({
      model: 'm', content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
    }))?.finishReason).toBe('end_turn');
    expect(parseAPIResponse('anthropicAPI', JSON.stringify({
      model: 'm', content: [{ type: 'text', text: 'hi' }], stop_reason: 'max_tokens', usage: { input_tokens: 1, output_tokens: 1 },
    }))?.finishReason).toBe('max_tokens');
    expect(parseAPIResponse('anthropicAPI', JSON.stringify({
      model: 'm', content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 1, output_tokens: 1 },
    }))?.finishReason).toBeUndefined();
    // A content filter is its own terminal reason and must not read as a completed answer either.
    expect(parseAPIResponse('openaiAPI', openAIBody({ finishReason: 'content_filter' }))?.finishReason).toBe('content_filter');
  });

  it('reads an Anthropic stream\'s stop reason off the message delta that carries it', async () => {
    const provider = await startMockProvider('');
    try {
      provider.streamFrames([
        JSON.stringify({ type: 'message_start', message: { model: 'm', usage: { input_tokens: 12 } } }),
        JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } }),
        JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 512 } }),
      ]);
      const adapter = new MeteredAPIAdapter({ provider: 'anthropicAPI', baseURL: provider.baseURL, credentials: anthropicCredentials });
      const response = await adapter.complete({ binding: meteredBinding('anthropicAPI:m'), promptText: 'x' });

      expect(response.finishReason).toBe('max_tokens');
    } finally { await provider.close(); }
  });
});

// MARK: - Mission 2 · and what the engine does with it

describe('how a terminal reason is read once it is recorded', () => {
  const telemetryWith = (doneReason?: string) => summariseAttempt([], { doneReason, evalTokenCount: 10 }, 100);

  it('reads `length` and `max_tokens` as the same event, and every other word as not that event', () => {
    expect(endedAtOutputLimit(telemetryWith('length'))).toBe(true);
    expect(endedAtOutputLimit(telemetryWith('max_tokens'))).toBe(true);
    expect(endedAtOutputLimit(telemetryWith('stop'))).toBe(false);
    expect(endedAtOutputLimit(telemetryWith('end_turn'))).toBe(false);
    expect(endedAtOutputLimit(telemetryWith('content_filter'))).toBe(false);
  });

  it('treats an ABSENT terminal reason as unknown, not as truncated and not as finished', () => {
    const telemetry = telemetryWith(undefined);
    expect(telemetry.doneReason).toEqual({ unavailableReason: 'the runtime gave no reason for stopping' });
    expect(endedAtOutputLimit(telemetry)).toBe(false);
    expect(explainTruncatedAnswer(telemetry, 512)).toBeUndefined();
  });

  it('explains a truncated answer, and says nothing about one that finished', () => {
    expect(explainTruncatedAnswer(telemetryWith('length'), 512))
      .toMatch(/stopped at the output token limit \(terminal reason 'length'\) with a 512-token budget/);
    expect(explainTruncatedAnswer(telemetryWith('stop'), 512)).toBeUndefined();
  });
});

describe('what a campaign row says about how the answer ended', () => {
  let campaignRoot: string;
  beforeEach(() => { campaignRoot = temporaryRoot('finish-reason-'); });
  afterEach(() => fs.rmSync(campaignRoot, { recursive: true, force: true }));

  const runWith = async (finishReason: string | undefined) => {
    const envelope = envelopeOf(subscriptionBinding('claudeCLI:sonnet'));
    const adapter = scriptedAdapter('claudeCLI', {}, { reportedModelID: 'sonnet', finishReason });
    const { host } = routingHost({ envelope, adapters: { claudeCLI: adapter } });
    const campaign = Campaign.create(path.join(campaignRoot, 'run'), configurationFor(envelope), host);
    const status = await campaign.run({ campaignRootDirectory: campaignRoot });
    expect(status.state).toBe('complete');
    return [...campaign.ledger.results.values()];
  };

  it('records the provider\'s word on every row', async () => {
    for (const row of await runWith('stop')) expect(row.doneReason).toBe('stop');
  });

  it('SAYS SO ON THE ROW when the output ceiling ended the answer, instead of scoring it as a whole one', async () => {
    const rows = await runWith('length');
    for (const row of rows) {
      expect(row.doneReason).toBe('length');
      // The scored status is left exactly as the scorer decided it — this is not a second opinion
      // about the answer. What it is, is the end of the silence.
      expect(String(row.detail)).toMatch(/stopped at the output token limit \(terminal reason 'length'\)/);
    }
  });

  it('records NOTHING when the provider named no reason, which is what a subscription CLI does', async () => {
    const rows = await runWith(undefined);
    for (const row of rows) {
      // Before the fix this row said `stop`. It was never told that by anybody.
      expect(row.doneReason).toBeUndefined();
      expect(String(row.detail)).not.toMatch(/output token limit/);
    }
  });
});
