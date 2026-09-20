// Cernum · executing through the OpenCode CLI, IN THE SERVER EVENT FRAMING.
//
// READ THIS BEFORE TAKING ANYTHING HERE AS EVIDENCE ABOUT A REAL REQUEST. Every fixture in this file
// is a `message.updated` / `message.part.updated` event, shaped from the GENERATED TYPES that ship
// with the tool — `@opencode-ai/sdk/dist/gen/types.gen.d.ts`, where `AssistantMessage`, `TextPart`,
// `RetryPart` and the five error variants are declared by OpenCode itself. Those types are real, and
// they describe the SERVER'S event stream.
//
// `opencode run --format json` DOES NOT EMIT THAT FRAMING. It subscribes to the server stream and
// re-writes a subset of it on stdout as `{type, timestamp, sessionID, part|error}` with underscored
// type names, and it never forwards the assistant message at all. The first live request proved it,
// and the parser — written from these types and tested against them — read none of it. See
// `opencode-run-json-envelope.test.ts`, which drives the captured bytes, and take THAT file as the
// statement of what a real OpenCode reply contains.
//
// SO WHAT IS THIS FILE FOR. The invocation assertions are unaffected: `opencode run --help` is the
// same source either way. The envelope assertions cover the branch that reads the server framing,
// which remains because the events are declared and because an assistant message is the only place
// identity ever appears. NOTHING HERE ESTABLISHES THAT CERNUM CAN VERIFY AN OPENCODE MODEL on the
// path it actually uses — in that framing it cannot, and the captured-envelope file says so.
//
// NO REQUEST IS SENT TO ANY MODEL by these tests.

import { describe, expect, it, vi } from 'vitest';
import {
  OpenCodeAdapter, parseOpenCodeRun, classifyOpenCodeError, buildOpenCodeArguments,
} from '../../src/engine/opencode-adapter';
import { UNION_ALPHA_MODEL_ID } from '../../src/engine/opencode-cli';
import { ProviderBinding } from '../../src/engine/provider';
import { readSmoke } from '../../src/engine/identity-smoke';

const MODEL = UNION_ALPHA_MODEL_ID;

const binding = (overrides: Partial<ProviderBinding> = {}): ProviderBinding => ({
  candidate: `opencodeCLI:${MODEL}`,
  provider: 'opencodeCLI',
  executionClass: 'meteredAPI',
  requestedModelID: MODEL,
  identityState: 'requestedOnly',
  verifiedModelID: '',
  identityEvidence: 'nothing yet',
  effort: 'none',
  thinkingMode: 'off',
  sampling: {},
  maxInputTokens: 4096,
  maxOutputTokens: 512,
  timeoutMilliseconds: 30_000,
  retry: { maxAttempts: 1, backoffMilliseconds: 0 },
  billingBasis: 'meteredAPI',
  ...overrides,
} as ProviderBinding);

/**
 * An `AssistantMessage` as OpenCode's own types declare it — in the SERVER framing, which
 * `run --format json` never writes to stdout. Not a shape any Cernum request receives.
 */
function assistantMessage(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'message.updated',
    properties: {
      info: {
        id: 'msg_1', sessionID: 'ses_1', role: 'assistant', parentID: 'msg_0',
        providerID: 'opencode', modelID: 'union-alpha', mode: 'build',
        path: { cwd: '/tmp/empty', root: '/tmp/empty' },
        time: { created: 1_000, completed: 1_450 },
        cost: 0.0031,
        tokens: { input: 42, output: 7, reasoning: 3, cache: { read: 11, write: 5 } },
        finish: 'stop',
        ...overrides,
      },
    },
  });
}

function textPart(text: string, id = 'prt_1'): string {
  return JSON.stringify({
    type: 'message.part.updated',
    properties: { part: { id, sessionID: 'ses_1', messageID: 'msg_1', type: 'text', text } },
  });
}

const HAPPY = [textPart('ok'), assistantMessage()].join('\n');

/**
 * A `runCLI` that behaves like the real one, including calling `onFirstOutput`.
 *
 * The callback matters: time-to-first-visible-token is an OBSERVATION of when bytes landed, made by
 * the process watching them, not a number any tool reports. A fake that returned a result without
 * ever calling back would let the adapter silently stop recording it and still pass.
 */
function fakeRun(stdout: string, extra: Record<string, unknown> = {}) {
  return vi.fn(async (options: { onFirstOutput?: (at: number) => void }) => {
    if (stdout.length > 0) options.onFirstOutput?.(120);
    return {
      stdout, stderr: '', exitCode: 0, signal: null, elapsedMilliseconds: 470,
      failure: undefined, ...extra,
    } as any;
  });
}

const adapter = (run: ReturnType<typeof fakeRun>, options: Record<string, unknown> = {}) =>
  new OpenCodeAdapter({ executablePath: '/usr/local/bin/opencode', run, makeWorkingDirectory: () => '/tmp/cernum-fake-wd', ...options });

describe('v0.2.3 · OpenCode is invoked non-interactively, with the model named explicitly', () => {
  it('asks for the model in OpenCode\'s own addressing, as JSON, in an isolated directory', () => {
    const args = buildOpenCodeArguments(MODEL, 'none', '/tmp/empty-dir');
    expect(args).toEqual(['run', '--format', 'json', '--model', MODEL, '--dir', '/tmp/empty-dir', '--pure']);
  });

  it('sends --variant only when the binding froze an effort', () => {
    expect(buildOpenCodeArguments(MODEL, 'high', '/tmp/x')).toContain('--variant');
    expect(buildOpenCodeArguments(MODEL, 'high', '/tmp/x')).toContain('high');
    // Asking for a variant a model may not accept is a DIFFERENT request from not asking.
    expect(buildOpenCodeArguments(MODEL, 'none', '/tmp/x')).not.toContain('--variant');
  });

  it('runs in a working directory it created, and removes it afterwards', async () => {
    const run = fakeRun(HAPPY);
    await adapter(run).complete({ binding: binding(), promptText: 'Reply with only: ok' });
    const call = run.mock.calls[0][0] as { workingDirectory: string; args: string[]; input: string };
    expect(call.workingDirectory).toBe('/tmp/cernum-fake-wd');
    expect(call.args).toContain('--dir');
    expect(call.input).toContain('Reply with only: ok');
  });

  it('reports notInstalled without running anything when OpenCode is absent', async () => {
    const run = fakeRun(HAPPY);
    const absent = new OpenCodeAdapter({ findExecutable: () => undefined, run });
    const response = await absent.complete({ binding: binding(), promptText: 'hi' });
    expect(response.failure?.kind).toBe('notInstalled');
    expect(run).not.toHaveBeenCalled();
  });
});

describe('v0.2.3 · server framing (NOT emitted by `run --format json`) · telemetry off the assistant message', () => {
  it('reads tokens, cost, latency and finish reason from the assistant message', async () => {
    const response = await adapter(fakeRun(HAPPY)).complete({ binding: binding(), promptText: 'hi' });

    expect(response.failure).toBeUndefined();
    expect(response.answerText).toBe('ok');
    expect(response.usage.inputTokens).toBe(42);
    expect(response.usage.visibleOutputTokens).toBe(7);
    expect(response.usage.reasoningTokens).toBe(3);
    expect(response.usage.cacheReadInputTokens).toBe(11);
    expect(response.usage.cacheCreationInputTokens).toBe(5);
    expect(response.usageProvenance).toBe('providerReported');
    expect(response.totalElapsedMilliseconds).toBe(470);
    expect(response.firstVisibleTokenMilliseconds).toBe(120);
  });

  it('marks usage UNAVAILABLE rather than zero when no tokens block came back', async () => {
    const withoutTokens = [textPart('ok'), assistantMessage({ tokens: undefined })].join('\n');
    const response = await adapter(fakeRun(withoutTokens)).complete({ binding: binding(), promptText: 'hi' });

    // The distinction that matters: nobody counted is not the same as counted zero.
    expect(response.usageProvenance).toBe('unavailable');
    expect(response.usage.inputTokens).toBeUndefined();
  });

  it('never files OpenCode\'s cost as subscription allowance', async () => {
    // OpenCode is METERED. Putting its charge in the subscription field would report a real
    // per-token bill as plan usage — the precise misreport codexCLI already refuses by hand.
    const response = await adapter(fakeRun(HAPPY)).complete({ binding: binding(), promptText: 'hi' });
    expect(response.subscriptionIncludedUsageMicroUSD).toBeUndefined();
  });

  it('counts retries from the retry parts OpenCode emits', async () => {
    const retried = [
      JSON.stringify({ type: 'message.part.updated', properties: { part: { id: 'r1', type: 'retry', attempt: 1, error: { name: 'APIError', data: { message: 'busy', isRetryable: true } }, time: { created: 1 } } } }),
      JSON.stringify({ type: 'message.part.updated', properties: { part: { id: 'r2', type: 'retry', attempt: 2, error: { name: 'APIError', data: { message: 'busy', isRetryable: true } }, time: { created: 2 } } } }),
      textPart('ok'), assistantMessage(),
    ].join('\n');
    const response = await adapter(fakeRun(retried)).complete({ binding: binding(), promptText: 'hi' });
    expect(response.retryCount).toBe(2);
  });
});

describe('v0.2.3 · server framing (NOT emitted by `run --format json`) · identity is read, never copied', () => {
  it('reports the model OpenCode named, rejoined in OpenCode\'s addressing', async () => {
    const response = await adapter(fakeRun(HAPPY)).complete({ binding: binding(), promptText: 'hi' });
    expect(response.reportedModelID).toBe(MODEL);
    expect(response.participatingModelIDs).toEqual([MODEL]);
  });

  it('leaves the identity EMPTY when the reply names no model', async () => {
    const anonymous = [textPart('ok'), assistantMessage({ modelID: undefined, providerID: undefined })].join('\n');
    const response = await adapter(fakeRun(anonymous)).complete({ binding: binding(), promptText: 'hi' });

    // Not the requested id. A request is not evidence about who answered it.
    expect(response.reportedModelID).toBe('');
    expect(response.failure).toBeUndefined();
  });

  it('calls a different answering model a mismatch rather than a result', async () => {
    const substituted = [textPart('ok'), assistantMessage({ modelID: 'gpt-5.4' })].join('\n');
    const response = await adapter(fakeRun(substituted)).complete({ binding: binding(), promptText: 'hi' });

    expect(response.failure?.kind).toBe('modelMismatch');
    expect(response.reportedModelID).toBe('opencode/gpt-5.4');
  });
});

describe('v0.2.3 · server framing (NOT emitted by `run --format json`) · what such a smoke would prove', () => {
  it('WOULD reach PROVEN if OpenCode ever named the model on stdout — which under --format json it does not', async () => {
    const response = await adapter(fakeRun(HAPPY)).complete({ binding: binding(), promptText: 'hi' });
    const smoke = readSmoke(binding(), response, '2026-09-17T12:00:00Z');

    expect(smoke.verdict).toBe('proven');
    expect(smoke.evidence).toContain(MODEL);
  });

  it('stays UNVERIFIABLE when the request succeeded but named nobody', async () => {
    // THE DISTINCTION v0.2.3 HAS TO KEEP. Execution succeeded — that is real. Who answered is not
    // established, and a successful request is never allowed to imply it.
    const anonymous = [textPart('ok'), assistantMessage({ modelID: undefined, providerID: undefined })].join('\n');
    const response = await adapter(fakeRun(anonymous)).complete({ binding: binding(), promptText: 'hi' });
    const smoke = readSmoke(binding(), response, '2026-09-17T12:00:00Z');

    expect(response.answerText).toBe('ok');
    expect(smoke.verdict).toBe('unverifiable');
    expect(smoke.evidence).toContain('named no model');
  });

  it('records a substitution as substituted, not as a result for what was asked', async () => {
    const substituted = [textPart('ok'), assistantMessage({ modelID: 'gpt-5.4' })].join('\n');
    const response = await adapter(fakeRun(substituted)).complete({ binding: binding(), promptText: 'hi' });
    expect(readSmoke(binding(), response, '2026-09-17T12:00:00Z').verdict).not.toBe('proven');
  });
});

describe('v0.2.3 · failures are classified from the envelope, not from the exit code', () => {
  it('reads a ProviderAuthError as notAuthenticated, so it is never retried', async () => {
    const unauthenticated = assistantMessage({ error: { name: 'ProviderAuthError', data: { providerID: 'opencode', message: 'no credential' } } });
    const response = await adapter(fakeRun(unauthenticated, { exitCode: 1, failure: { kind: 'exitCode', detail: 'exit 1' } }))
      .complete({ binding: binding(), promptText: 'hi' });

    expect(response.failure?.kind).toBe('notAuthenticated');
  });

  it('maps the API error statuses the way the rest of the engine reasons about them', () => {
    expect(classifyOpenCodeError({ name: 'APIError', message: 'x', statusCode: 404 })).toBe('refused');
    expect(classifyOpenCodeError({ name: 'APIError', message: 'x', statusCode: 429 })).toBe('rateLimited');
    expect(classifyOpenCodeError({ name: 'APIError', message: 'x', statusCode: 401 })).toBe('notAuthenticated');
    expect(classifyOpenCodeError({ name: 'APIError', message: 'x', statusCode: 500 })).toBe('transport');
    expect(classifyOpenCodeError({ name: 'MessageAbortedError', message: 'stopped' })).toBe('cancelled');
  });

  it('reports a clean exit with no readable answer as malformed, not as an empty answer', async () => {
    const response = await adapter(fakeRun('not json at all\n')).complete({ binding: binding(), promptText: 'hi' });
    expect(response.failure?.kind).toBe('malformedResponse');
    expect(response.answerText).toBe('');
  });

  it('carries a timeout through as a timeout', async () => {
    const run = fakeRun('', { failure: { kind: 'timeout', detail: 'did not finish' } });
    const response = await adapter(run).complete({ binding: binding(), promptText: 'hi' });
    expect(response.failure?.kind).toBe('timeout');
  });
});

describe('v0.2.3 · the event parser refuses what it does not recognise', () => {
  it('accepts a JSON array as well as newline-delimited events', () => {
    const asArray = JSON.stringify([JSON.parse(textPart('ok')), JSON.parse(assistantMessage())]);
    expect(parseOpenCodeRun(asArray).answerText).toBe('ok');
    expect(parseOpenCodeRun(asArray).reportedModelID).toBe(MODEL);
  });

  it('skips lines that are not events rather than failing on them', () => {
    const noisy = ['some log line', textPart('ok'), '', 'another', assistantMessage()].join('\n');
    expect(parseOpenCodeRun(noisy).answerText).toBe('ok');
  });

  it('ignores synthetic and ignored text parts, which are not the answer', () => {
    const withSynthetic = [
      JSON.stringify({ type: 'message.part.updated', properties: { part: { id: 'p0', type: 'text', text: 'SYNTHETIC', synthetic: true } } }),
      textPart('real answer'), assistantMessage(),
    ].join('\n');
    expect(parseOpenCodeRun(withSynthetic).answerText).toBe('real answer');
  });

  it('finds nothing in an empty stream, and says so by leaving everything undefined', () => {
    const turn = parseOpenCodeRun('');
    expect(turn.answerText).toBe('');
    expect(turn.reportedModelID).toBe('');
    expect(turn.usageReported).toBe(false);
    expect(turn.reportedCost).toBeUndefined();
  });
});
