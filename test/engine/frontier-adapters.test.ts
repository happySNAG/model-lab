// The adapters: what they send, what they refuse to send, how they read an answer, and — the part
// that only a real child process can test — how they stop.
//
// The subscription-CLI tests run FAKE EXECUTABLES written onto disk, not stub objects. The thing
// under test is the process machinery: the process group, SIGTERM, the grace period, the kill. None
// of that is exercised by a stub that resolves a promise, and all of it is what stands between a
// paused campaign and a child process that keeps consuming an allowance nobody is watching.

import { afterEach, describe, expect, it } from 'vitest';
import {
  MeteredAPIAdapter, RETRYABLE_FAILURES, ScriptedFrontierAdapter, SubscriptionCLIAdapter,
  buildAPIBody, buildCLIArguments, parseAPIResponse, parseCLIResponse, thinkingBudgetFor, withRetry,
} from '../../src/engine/frontier-adapter';
import { liveCLIProcessCount, runCLI, terminateAllCLIProcesses } from '../../src/engine/cli-process';
import { forgetRegisteredSecrets } from '../../src/engine/redaction';
import { DEFAULT_RETRY } from '../../src/engine/provider';
import { meteredBinding, startMockProvider, subscriptionBinding, writeFakeCLI } from './frontier-harness';
import { FIXTURE_ANTHROPIC_KEY } from '../secret-fixtures';

afterEach(() => { terminateAllCLIProcesses(0); forgetRegisteredSecrets(); });

describe('what a subscription CLI is asked', () => {
  it('never puts the prompt in argv, where every process on the machine can read it', async () => {
    const fake = writeFakeCLI('claude', `
      STDIN=$(cat)
      printf '{"args":%s,"stdin":%s,"env":{}}\\n' "$(printf '%s' "$*" | sed 's/.*/["&"]/')" "$(printf '%s' "$STDIN" | sed 's/.*/"&"/')" >> "$LOG"
      echo '{"result":"an answer","model":"sonnet","usage":{"input_tokens":10,"output_tokens":4}}'
    `);
    try {
      const adapter = new SubscriptionCLIAdapter({ provider: 'claudeCLI', executablePath: fake.executablePath });
      const response = await adapter.complete({
        binding: subscriptionBinding('claudeCLI:sonnet'),
        promptText: 'a-very-distinctive-prompt-string',
      });
      expect(response.failure).toBeUndefined();
      expect(response.answerText).toBe('an answer');
      const invocations = fake.invocations();
      expect(invocations).toHaveLength(1);
      expect(invocations[0].args.join(' ')).not.toContain('a-very-distinctive-prompt-string');
      expect(invocations[0].stdin).toContain('a-very-distinctive-prompt-string');
    } finally { fake.cleanup(); }
  });

  it('expresses the model and the effort as flags the tool documents', () => {
    const { args, unexpressed } = buildCLIArguments(subscriptionBinding('claudeCLI:sonnet', 'claudeCLI', { effort: 'high' }));
    expect(args).toContain('--model');
    expect(args).toContain('sonnet');
    expect(args).toContain('--effort');
    expect(args).toContain('high');
    expect(unexpressed).toEqual([]);
  });

  it('REFUSES a frozen setting it cannot express, rather than dropping it silently', async () => {
    const binding = subscriptionBinding('claudeCLI:sonnet', 'claudeCLI', {
      sampling: { temperatureMilli: 0, topPMilli: 1000, seed: 7 },
    });
    const { unexpressed } = buildCLIArguments(binding);
    expect(unexpressed.length).toBe(3);

    const fake = writeFakeCLI('claude', `echo '{"result":"should never happen"}'`);
    try {
      const adapter = new SubscriptionCLIAdapter({ provider: 'claudeCLI', executablePath: fake.executablePath });
      const response = await adapter.complete({ binding, promptText: 'x' });
      expect(response.failure?.kind).toBe('budgetRefused');
      expect(response.failure?.detail).toMatch(/froze settings this CLI cannot express/);
      // NOTHING WAS RUN.
      expect(fake.invocations()).toHaveLength(0);
    } finally { fake.cleanup(); }
  });

  it('refuses thinking-on with no effort level, because no flag means what the manifest says', () => {
    const { unexpressed } = buildCLIArguments(subscriptionBinding('claudeCLI:s', 'claudeCLI', { thinkingMode: 'enabled', effort: 'none' }));
    expect(unexpressed.join(' ')).toMatch(/no flag that means what the manifest says/);
  });

  it('says plainly when the command is not installed, and blames nobody for it', async () => {
    const adapter = new SubscriptionCLIAdapter({ provider: 'claudeCLI', findExecutable: () => undefined });
    const response = await adapter.complete({ binding: subscriptionBinding('claudeCLI:s'), promptText: 'x' });
    expect(response.failure?.kind).toBe('notInstalled');
    expect(response.failure?.detail).toMatch(/does not reach the service any other way/);
  });
});

describe('reading a subscription CLI\'s answer', () => {
  it('refuses an output it does not recognise rather than scraping it', () => {
    expect(parseCLIResponse('some prose the tool printed')).toBeUndefined();
    expect(parseCLIResponse('')).toBeUndefined();
    expect(parseCLIResponse('{"unexpected":"shape"}')).toBeUndefined();
  });

  it('records "the tool did not say which model" as an empty string, never as the request', () => {
    const parsed = parseCLIResponse('{"result":"hi"}')!;
    expect(parsed.reportedModelID).toBe('');
  });

  it('takes the last complete JSON object, so a progress line does not become the answer', () => {
    const parsed = parseCLIResponse('{"type":"progress"}\n{"result":"the answer","model":"m"}')!;
    expect(parsed.answerText).toBe('the answer');
    expect(parsed.reportedModelID).toBe('m');
  });

  it('turns an unrecognised output into a malformedResponse, not a silent empty answer', async () => {
    const fake = writeFakeCLI('claude', `echo "I am afraid I cannot do that"`);
    try {
      const adapter = new SubscriptionCLIAdapter({ provider: 'claudeCLI', executablePath: fake.executablePath });
      const response = await adapter.complete({ binding: subscriptionBinding('claudeCLI:s'), promptText: 'x' });
      expect(response.failure?.kind).toBe('malformedResponse');
      expect(response.failure?.detail).toMatch(/refuses to scrape an unrecognised format/);
    } finally { fake.cleanup(); }
  });

  it('recognises a rate limit and a sign-in failure as what they are', async () => {
    const limited = writeFakeCLI('claude', `echo "429 rate limit exceeded" >&2; exit 1`);
    const unauthenticated = writeFakeCLI('claude', `echo "You are not logged in" >&2; exit 1`);
    try {
      const a = new SubscriptionCLIAdapter({ provider: 'claudeCLI', executablePath: limited.executablePath });
      expect((await a.complete({ binding: subscriptionBinding('claudeCLI:s'), promptText: 'x' })).failure?.kind).toBe('rateLimited');
      const b = new SubscriptionCLIAdapter({ provider: 'claudeCLI', executablePath: unauthenticated.executablePath });
      expect((await b.complete({ binding: subscriptionBinding('claudeCLI:s'), promptText: 'x' })).failure?.kind).toBe('notAuthenticated');
    } finally { limited.cleanup(); unauthenticated.cleanup(); }
  });
});

describe('a child process is stopped, not abandoned', () => {
  it('kills a tool that outlives its deadline', async () => {
    const fake = writeFakeCLI('claude', `sleep 30; echo '{"result":"too late"}'`);
    try {
      const started = Date.now();
      const result = await runCLI({
        executable: fake.executablePath, args: [], timeoutMilliseconds: 400, graceMilliseconds: 100,
      });
      expect(result.failure?.kind).toBe('timeout');
      expect(result.failure?.detail).toMatch(/is an unfinished measurement, not a slow one/);
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(liveCLIProcessCount()).toBe(0);
    } finally { fake.cleanup(); }
  }, 30_000);

  it('stops a tool when the caller pauses, even one that has gone quiet', async () => {
    const fake = writeFakeCLI('claude', `sleep 30`);
    try {
      let cancel = false;
      setTimeout(() => { cancel = true; }, 300);
      const result = await runCLI({
        executable: fake.executablePath, args: [], timeoutMilliseconds: 20_000,
        graceMilliseconds: 100, shouldCancel: () => cancel,
      });
      expect(result.failure?.kind).toBe('cancelled');
      expect(result.failure?.detail).toMatch(/paused or aborted/);
      expect(liveCLIProcessCount()).toBe(0);
    } finally { fake.cleanup(); }
  }, 30_000);

  it('kills a tool that IGNORES SIGTERM, after the grace period', async () => {
    // A tool that traps the polite signal is exactly the tool that must not survive a pause. The
    // loop matters: `sleep` itself does not ignore SIGTERM, so a bare `trap '' TERM; sleep 30` would
    // end when its child died and never exercise the kill. This shell only ever ends by SIGKILL.
    const fake = writeFakeCLI('claude', `trap '' TERM; while true; do sleep 0.2; done`);
    try {
      const started = Date.now();
      const result = await runCLI({
        executable: fake.executablePath, args: [], timeoutMilliseconds: 500, graceMilliseconds: 300,
      });
      expect(result.failure?.kind).toBe('timeout');
      // SIGKILL, because SIGTERM was ignored.
      expect(result.signal).toBe('SIGKILL');
      expect(Date.now() - started).toBeLessThan(15_000);
    } finally { fake.cleanup(); }
  }, 30_000);

  it('stops every child at once, from a handler holding no reference to any of them', async () => {
    const fake = writeFakeCLI('claude', `sleep 20`);
    try {
      const runs = [0, 1, 2].map(() => runCLI({
        executable: fake.executablePath, args: [], timeoutMilliseconds: 20_000, graceMilliseconds: 100,
      }));
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(liveCLIProcessCount()).toBe(3);
      expect(terminateAllCLIProcesses(100)).toBe(3);
      const results = await Promise.all(runs);
      for (const result of results) expect(result.signal === 'SIGTERM' || result.signal === 'SIGKILL').toBe(true);
      expect(liveCLIProcessCount()).toBe(0);
    } finally { fake.cleanup(); }
  }, 30_000);

  it('records when the first byte arrived, observed rather than derived', async () => {
    const fake = writeFakeCLI('claude', `sleep 0.3; echo '{"result":"hello","model":"m"}'`);
    try {
      const result = await runCLI({ executable: fake.executablePath, args: [], timeoutMilliseconds: 10_000 });
      expect(result.firstOutputMilliseconds).toBeGreaterThanOrEqual(200);
      expect(result.firstOutputMilliseconds).toBeLessThanOrEqual(result.elapsedMilliseconds);
    } finally { fake.cleanup(); }
  }, 30_000);
});

describe('retrying is not free, and is not done for everything', () => {
  it('retries only what a retry could plausibly fix', () => {
    expect(RETRYABLE_FAILURES).toEqual(['timeout', 'rateLimited', 'transport']);
    expect(RETRYABLE_FAILURES).not.toContain('refused');
    expect(RETRYABLE_FAILURES).not.toContain('modelMismatch');
  });

  it('counts the tokens every discarded try burned', async () => {
    const adapter = new ScriptedFrontierAdapter('anthropicAPI', {
      fallback: { failuresBeforeSuccess: 2, usage: { inputTokens: 100, visibleOutputTokens: 20 } },
    });
    const binding = meteredBinding('anthropicAPI:m', 'anthropicAPI', { retry: DEFAULT_RETRY });
    const response = await withRetry(binding, () => adapter.complete({ binding, promptText: 'x' }), async () => undefined);
    expect(response.failure).toBeUndefined();
    expect(response.retryCount).toBe(2);
    // Two discarded tries, 100 input tokens each. Hiding these would make an unreliable model
    // look cheap.
    expect(response.wastedTokens).toBe(200);
  });

  it('returns a non-retryable failure immediately rather than paying to reproduce it', async () => {
    let calls = 0;
    const binding = meteredBinding('anthropicAPI:m', 'anthropicAPI', { retry: DEFAULT_RETRY });
    const response = await withRetry(binding, async () => {
      calls += 1;
      return {
        answerText: '', reportedModelID: '', usage: { inputTokens: 50 }, usageProvenance: 'providerReported' as const,
        totalElapsedMilliseconds: 1, retryCount: 0, wastedTokens: 0,
        failure: { kind: 'refused' as const, detail: 'the provider refused' },
      };
    }, async () => undefined);
    expect(calls).toBe(1);
    expect(response.retryCount).toBe(0);
    expect(response.failure?.kind).toBe('refused');
  });
});

describe('the metered API wire format', () => {
  it('builds the documented body from the frozen binding and nothing else', () => {
    const anthropic = buildAPIBody(meteredBinding('anthropicAPI:m'), 'hello', false);
    expect(anthropic.model).toBe('m');
    expect(anthropic.max_tokens).toBe(512);
    expect(anthropic.stream).toBe(false);

    const openai = buildAPIBody(meteredBinding('openaiAPI:o', 'openaiAPI', { effort: 'high' }), 'hello', true);
    expect(openai.max_completion_tokens).toBe(512);
    expect(openai.reasoning_effort).toBe('high');
    expect(openai.stream_options).toEqual({ include_usage: true });
  });

  it('reserves a thinking budget that always leaves room for a visible answer', () => {
    for (const effort of ['none', 'low', 'medium', 'high', 'max'] as const) {
      const budget = thinkingBudgetFor(effort, 8_000);
      expect(budget).toBeLessThanOrEqual(6_000);
    }
  });

  it('never concatenates a thinking block into the visible answer', () => {
    const body = JSON.stringify({
      model: 'm',
      content: [{ type: 'thinking', thinking: 'SECRET REASONING' }, { type: 'text', text: 'the answer' }],
      usage: { input_tokens: 10, output_tokens: 3 },
    });
    const parsed = parseAPIResponse('anthropicAPI', body)!;
    expect(parsed.answerText).toBe('the answer');
    expect(parsed.answerText).not.toContain('SECRET REASONING');
  });

  it('refuses a response that is not in the documented shape', () => {
    expect(parseAPIResponse('anthropicAPI', '{"nope":true}')).toBeUndefined();
    expect(parseAPIResponse('openaiAPI', 'not json')).toBeUndefined();
    expect(parseAPIResponse('openaiAPI', '{"choices":[]}')).toBeUndefined();
  });

  it('times the first VISIBLE delta of a stream, not the first thinking delta', async () => {
    const provider = await startMockProvider('');
    try {
      provider.streamFrames([
        JSON.stringify({ type: 'message_start', message: { model: 'm', usage: { input_tokens: 12 } } }),
        JSON.stringify({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'reasoning' } }),
        JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'the ' } }),
        JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'answer' } }),
        JSON.stringify({ type: 'message_delta', usage: { output_tokens: 5 } }),
      ]);
      const adapter = new MeteredAPIAdapter({
        provider: 'anthropicAPI', baseURL: provider.baseURL,
        credentials: { environment: { ANTHROPIC_API_KEY: FIXTURE_ANTHROPIC_KEY }, readKeychain: () => undefined },
      });
      const response = await adapter.complete({ binding: meteredBinding('anthropicAPI:m'), promptText: 'x' });
      expect(response.answerText).toBe('the answer');
      expect(response.reportedModelID).toBe('m');
      expect(response.usage.inputTokens).toBe(12);
      expect(response.usage.visibleOutputTokens).toBe(5);
      expect(response.usageProvenance).toBe('providerReported');
      expect(response.firstVisibleTokenMilliseconds).toBeGreaterThanOrEqual(0);
    } finally { await provider.close(); }
  });

  it('records NO first-token time for a non-streamed attempt, rather than deriving one', async () => {
    const provider = await startMockProvider(JSON.stringify({
      model: 'm', content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 4, output_tokens: 1 },
    }));
    try {
      const adapter = new MeteredAPIAdapter({
        provider: 'anthropicAPI', baseURL: provider.baseURL, stream: false,
        credentials: { environment: { ANTHROPIC_API_KEY: FIXTURE_ANTHROPIC_KEY }, readKeychain: () => undefined },
      });
      const response = await adapter.complete({ binding: meteredBinding('anthropicAPI:m'), promptText: 'x' });
      expect(response.answerText).toBe('hi');
      expect(response.firstVisibleTokenMilliseconds).toBeUndefined();
    } finally { await provider.close(); }
  });

  it('refuses before opening a socket when the key is missing', async () => {
    const adapter = new MeteredAPIAdapter({
      provider: 'anthropicAPI', baseURL: 'http://127.0.0.1:1',
      credentials: { environment: {}, readKeychain: () => undefined },
    });
    const response = await adapter.complete({ binding: meteredBinding('anthropicAPI:m'), promptText: 'x' });
    expect(response.failure?.kind).toBe('notAuthenticated');
    expect(response.failure?.detail).toMatch(/Nothing was sent, and no charge was incurred/);
  });

  it('classifies a 429 as rate-limited and a 5xx as transport, so retries apply where they should', async () => {
    const provider = await startMockProvider('');
    const credentials = { environment: { ANTHROPIC_API_KEY: FIXTURE_ANTHROPIC_KEY }, readKeychain: () => undefined };
    try {
      const adapter = new MeteredAPIAdapter({ provider: 'anthropicAPI', baseURL: provider.baseURL, credentials });
      provider.respondWith(429, '{"error":"slow down"}');
      expect((await adapter.complete({ binding: meteredBinding('anthropicAPI:m'), promptText: 'x' })).failure?.kind).toBe('rateLimited');
      provider.respondWith(503, '{"error":"unavailable"}');
      expect((await adapter.complete({ binding: meteredBinding('anthropicAPI:m'), promptText: 'x' })).failure?.kind).toBe('transport');
      provider.respondWith(400, '{"error":"bad request"}');
      expect((await adapter.complete({ binding: meteredBinding('anthropicAPI:m'), promptText: 'x' })).failure?.kind).toBe('refused');
    } finally { await provider.close(); }
  });
});
