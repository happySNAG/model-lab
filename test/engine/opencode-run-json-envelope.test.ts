// Cernum · v0.2.5 — the OpenCode adapter, against the bytes OpenCode actually returned.
//
// THE DEFECT THIS FILE PINS. `opencode/big-pickle` was asked one authorized question and answered it.
// Cernum recorded `malformedResponse`. The reply was fine; the parser was reading the wrong layer.
// `opencode-adapter.ts` had been written from the SDK's `Event` union — `message.updated`,
// `message.part.updated` — which is the SERVER's stream. `run --format json` subscribes to that
// stream and re-writes a subset of it in a flat envelope of its own, `{type, timestamp, sessionID,
// part|error}`, with underscored type names. Nothing matched, so no answer text was found, so a
// successful metered request was filed as an unreadable reply.
//
// Pass 4B's rule was "do not write an adapter from assumption, and do not test it against the same
// assumption". This is the narrower version of it that had to be bought a second time: READING THE
// TOOL'S TYPES IS NOT READING THE TOOL'S OUTPUT.
//
// SO EVERY TEST BELOW RUNS AGAINST A CAPTURE, not against a shape. `OPENCODE_BIG_PICKLE_CAPTURED_STDOUT`
// is the 922 bytes that came back, byte for byte apart from five opaque identifiers; its header
// carries the command, the version, the exit code and exactly what was changed. NO REQUEST IS SENT BY
// THESE TESTS — the capture is replayed, from memory and from a fake executable on disk.

import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { OpenCodeAdapter, parseOpenCodeRun } from '../../src/engine/opencode-adapter';
import { buildSmokeBinding } from '../../src/engine/smoke-binding';
import { identitySmokeTest } from '../../src/engine/identity-smoke';
import { totalInputTokens } from '../../src/engine/frontier-adapter';
import { REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE } from '../../src/engine/identity-admission';
import { ProviderBinding } from '../../src/engine/provider';
import {
  OPENCODE_BIG_PICKLE_CAPTURED_STDOUT, OPENCODE_BIG_PICKLE_OBSERVED,
  capturedLine, errorEvent, reasoningEvent, stepFinishEvent,
} from './fixtures/opencode-run-json';

/** The model the capture was taken from. Named here because the ENVELOPE does not name it anywhere. */
const REQUESTED = 'opencode/big-pickle';
const CAPTURED = OPENCODE_BIG_PICKLE_CAPTURED_STDOUT;
const OBSERVED = OPENCODE_BIG_PICKLE_OBSERVED;

const binding = (overrides: Partial<ProviderBinding> = {}): ProviderBinding => ({
  ...buildSmokeBinding({ provider: 'opencodeCLI', modelID: REQUESTED, effort: 'none' }),
  ...overrides,
});

function fakeRun(stdout: string, extra: Record<string, unknown> = {}) {
  return vi.fn(async (options: { onFirstOutput?: (at: number) => void }) => {
    if (stdout.length > 0) options.onFirstOutput?.(120);
    return { stdout, stderr: '', exitCode: 0, signal: null, elapsedMilliseconds: 596,
      failure: undefined, ...extra } as any;
  });
}

const adapter = (stdout: string, extra: Record<string, unknown> = {}) => new OpenCodeAdapter({
  executablePath: '/usr/local/bin/opencode',
  run: fakeRun(stdout, extra),
  makeWorkingDirectory: () => '/tmp/cernum-fake-wd',
});

const replay = (stdout: string) => adapter(stdout).complete({ binding: binding(), promptText: 'Reply with only: ok' });

describe('v0.2.5 · the captured envelope parses, which before this pass it did not', () => {
  it('REGRESSION — the real reply is no longer malformedResponse', async () => {
    const response = await replay(CAPTURED);

    // The one assertion that would have caught the whole defect.
    expect(response.failure).toBeUndefined();
    expect(response.answerText).toBe(OBSERVED.answerText);
  });

  it('finds the answer under the CLI framing, where the SDK framing is not present at all', () => {
    // Belt and braces on the root cause: the capture contains no dotted event name whatsoever, so an
    // adapter that only understood `message.part.updated` could never have read it.
    expect(CAPTURED).not.toContain('message.part.updated');
    expect(CAPTURED).not.toContain('message.updated');
    expect(CAPTURED).not.toContain('"properties"');
    expect(parseOpenCodeRun(CAPTURED).answerText).toBe('ok');
  });

  it('reads the event names OpenCode writes, underscores and all', () => {
    for (const type of ['step_start', 'text', 'step_finish'] as const) {
      expect(CAPTURED).toContain(`{"type":"${type}"`);
    }
  });
});

describe('v0.2.5 · identity — what the envelope does NOT contain, and what is not invented to fill it', () => {
  it('names no model, because --format json emits no assistant message', () => {
    // THE FINDING OF THIS PASS. `providerID`/`modelID` live on `AssistantMessage`, which `run` reads
    // only in its non-JSON branch to print `> agent · modelID` for a person. Under `--format json` it
    // never reaches stdout. Grep the capture and there is nothing to read.
    expect(CAPTURED).not.toContain('modelID');
    expect(CAPTURED).not.toContain('providerID');
    expect(parseOpenCodeRun(CAPTURED).reportedModelID).toBe('');
  });

  it('leaves the identity EMPTY rather than copying the request into it', async () => {
    const response = await replay(CAPTURED);

    expect(response.reportedModelID).toBe('');
    expect(response.reportedModelID).not.toBe(REQUESTED);
    expect(response.participatingModelIDs).toEqual([]);
  });

  it('a parsed answer does not become a proven identity', async () => {
    // Execution is real and is reported as such; who answered is not established, and fixing the
    // parser did not change that by one inch. The two facts travel together on the same response.
    const response = await replay(CAPTURED);

    expect(response.failure).toBeUndefined();
    expect(response.answerText).toBe('ok');
    expect(response.reportedModelID).toBe('');
    expect(response.usageProvenance).toBe('providerReported');
  });

  it('SUBSTITUTION IS UNDETECTABLE HERE, and the mismatch check cannot pretend otherwise', async () => {
    // A `modelMismatch` needs a reported identity to compare against. The captured envelope carries
    // none, so a substituted model would have returned exactly these bytes. This test exists to keep
    // that stated rather than discovered.
    const asDifferentModel = await adapter(CAPTURED).complete({
      binding: binding({ requestedModelID: 'opencode/some-other-model' } as Partial<ProviderBinding>),
      promptText: 'hi',
    });
    expect(asDifferentModel.failure).toBeUndefined();
    expect(asDifferentModel.reportedModelID).toBe('');
  });
});

describe('v0.2.5 · tokens, read where the envelope puts them: the step-finish part', () => {
  it('reads input, output, reasoning and both cache figures', async () => {
    const response = await replay(CAPTURED);

    expect(response.usage.inputTokens).toBe(OBSERVED.tokens.input);
    expect(response.usage.visibleOutputTokens).toBe(OBSERVED.tokens.output);
    expect(response.usage.reasoningTokens).toBe(OBSERVED.tokens.reasoning);
    expect(response.usage.cacheReadInputTokens).toBe(OBSERVED.tokens.cacheRead);
    expect(response.usage.cacheCreationInputTokens).toBe(OBSERVED.tokens.cacheWrite);
    expect(response.usageProvenance).toBe('providerReported');
  });

  it('treats `input` as FRESH input, which is what the observed `total` proves it is', async () => {
    // OpenCode emits a `total` its own generated types do not declare. It is 7936, and
    // input + output + reasoning + cache.read is 7936 — so `input` excludes cached input, exactly the
    // contract `FrontierUsage` states, and Cernum's derived total agrees with the tool's.
    const { input, output, reasoning, cacheRead, total } = OBSERVED.tokens;
    expect(input + output + reasoning + cacheRead).toBe(total);

    const response = await replay(CAPTURED);
    expect(totalInputTokens(response.usage)).toBe(input + cacheRead);
  });

  it('does not store `total`, because a field that can only disagree with its parts is not worth keeping', async () => {
    const response = await replay(CAPTURED);
    expect(JSON.stringify(response.usage)).not.toContain('7936');
  });

  it('marks usage UNAVAILABLE, not zero, when no step-finish came back', async () => {
    const withoutStepFinish = [capturedLine('step_start'), capturedLine('text'), ''].join('\n');
    const response = await replay(withoutStepFinish);

    expect(response.failure).toBeUndefined();
    expect(response.answerText).toBe('ok');
    expect(response.usageProvenance).toBe('unavailable');
    expect(response.usage.inputTokens).toBeUndefined();
  });

  it('keeps OpenCode\'s own arithmetic across steps: tokens are the LAST step\'s', () => {
    // `assistantMessage.tokens = step.tokens` in OpenCode's session loop. Replaced, not summed.
    const second = stepFinishEvent('stop', { total: 40, input: 30, output: 5, reasoning: 0, cache: { write: 0, read: 5 } }, 0);
    const twoSteps = [capturedLine('step_start'), capturedLine('text'), capturedLine('step_finish'), second, ''].join('\n');

    const turn = parseOpenCodeRun(twoSteps);
    expect(turn.usage.inputTokens).toBe(30);
    expect(turn.usage.visibleOutputTokens).toBe(5);
    expect(turn.usage.inputTokens).not.toBe(OBSERVED.tokens.input + 30);
  });
});

describe('v0.2.5 · cost, which the envelope reports and this engine refuses to dress up', () => {
  it('preserves a reported zero as a zero, not as an absence', () => {
    const turn = parseOpenCodeRun(CAPTURED);

    // `big-pickle` is on OpenCode's free development pool, so 0 is the true figure. It has to survive
    // the parser: dropping it as falsy would have turned a measured zero back into a silence.
    expect(turn.reportedCost).toBe(0);
    expect(turn.reportedCost).not.toBeUndefined();
  });

  it('carries the figure under a name that admits nobody established its unit', async () => {
    const response = await replay(CAPTURED);
    const raw = response.rawUsage as Record<string, number>;

    expect(raw.openCodeReportedCostUnitUnverified).toBe(OBSERVED.cost);
  });

  it('NEVER files it as subscription allowance, because OpenCode is metered', async () => {
    const response = await replay(CAPTURED);
    expect(response.subscriptionIncludedUsageMicroUSD).toBeUndefined();
  });

  it('sums cost across steps, which is what OpenCode does to the message', () => {
    // `assistantMessage.cost += step.cost`. Accumulated, not replaced — the opposite rule to tokens.
    const second = stepFinishEvent('stop', { total: 10, input: 8, output: 2, reasoning: 0, cache: { write: 0, read: 0 } }, 0.25);
    const third = stepFinishEvent('stop', { total: 10, input: 8, output: 2, reasoning: 0, cache: { write: 0, read: 0 } }, 0.5, 'prt_third');
    const turn = parseOpenCodeRun([capturedLine('step_finish'), second, third, ''].join('\n'));

    expect(turn.reportedCost).toBe(0.75);
  });

  it('leaves cost undefined when no step reported one at all', () => {
    const noCost = stepFinishEvent('stop', { total: 3, input: 2, output: 1, reasoning: 0, cache: { write: 0, read: 0 } }, 0)
      .replace(',"cost":0', '');
    const turn = parseOpenCodeRun([capturedLine('text'), noCost, ''].join('\n'));

    expect(turn.usageReported).toBe(true);
    expect(turn.reportedCost).toBeUndefined();
  });
});

describe('v0.2.5 · timing, kept separate from the wall clock Cernum measures itself', () => {
  it('reads the window OpenCode says the visible text was generated in', () => {
    const turn = parseOpenCodeRun(CAPTURED);
    expect(turn.reportedTextGenerationMilliseconds).toBe(OBSERVED.textGenerationMilliseconds);
  });

  it('does not pass the text window off as the request duration', async () => {
    const response = await replay(CAPTURED);

    // 50ms of text generation inside a 596ms request. Reporting the former as the latter would have
    // understated every OpenCode attempt by an order of magnitude.
    expect(OBSERVED.textGenerationMilliseconds).toBeLessThan(OBSERVED.eventSpanMilliseconds);
    expect(response.totalElapsedMilliseconds).toBe(596);
    expect(response.firstVisibleTokenMilliseconds).toBe(120);
  });

  it('does not derive a duration from the assistant message, which this framing never sends', () => {
    // `reportedDurationMilliseconds` is the server framing's figure. Silence, not an invented number.
    expect(parseOpenCodeRun(CAPTURED).reportedDurationMilliseconds).toBeUndefined();
  });

  it('counts a streamed text part once, however many times it is re-sent', () => {
    // Under the server framing a part arrives repeatedly as it grows. Both the text and its time
    // window are keyed by part id, so a re-send overwrites rather than accumulates.
    const line = capturedLine('text');
    const turn = parseOpenCodeRun([line, line, line, capturedLine('step_finish'), ''].join('\n'));

    expect(turn.answerText).toBe('ok');
    expect(turn.reportedTextGenerationMilliseconds).toBe(OBSERVED.textGenerationMilliseconds);
  });
});

describe('v0.2.5 · finish state, and the reasoning that is not an answer', () => {
  it('reads `reason` off the step-finish part', () => {
    expect(parseOpenCodeRun(CAPTURED).finishReason).toBe(OBSERVED.finishReason);
  });

  it('takes the LAST step\'s reason, as OpenCode does', () => {
    const last = stepFinishEvent('length', { total: 3, input: 2, output: 1, reasoning: 0, cache: { write: 0, read: 0 } }, 0);
    expect(parseOpenCodeRun([capturedLine('step_finish'), last, ''].join('\n')).finishReason).toBe('length');
  });

  it('never reports a finish reason as an applied effort', async () => {
    // This one has bitten before: `finish: stop` in `reportedEffort` made every OpenCode smoke print
    // "effort applied, as the provider reported it: stop". OpenCode reports no applied effort.
    const response = await replay(CAPTURED);
    expect(response.reportedEffort).toBeUndefined();
  });

  it('keeps reasoning text out of the answer', () => {
    // Only emitted under `--thinking`, which `buildOpenCodeArguments` does not send. Guarded anyway:
    // measuring thinking as the answer would be measuring the wrong string.
    const withReasoning = [capturedLine('step_start'), reasoningEvent('deliberating at length'),
      capturedLine('text'), capturedLine('step_finish'), ''].join('\n');

    expect(parseOpenCodeRun(withReasoning).answerText).toBe('ok');
  });

  it('ignores a tool_use event rather than choking on it', () => {
    const toolUse = JSON.stringify({
      type: 'tool_use', timestamp: 1789929250100, sessionID: OBSERVED.sessionID,
      part: { id: 'prt_tool', type: 'tool', tool: 'read', state: { status: 'completed' } },
    });
    const turn = parseOpenCodeRun([capturedLine('step_start'), toolUse, capturedLine('text'), capturedLine('step_finish'), ''].join('\n'));

    expect(turn.answerText).toBe('ok');
    expect(turn.usageReported).toBe(true);
  });
});

describe('v0.2.5 · malformed and incomplete envelopes, in the framing that actually arrives', () => {
  it('reports an envelope with no text part as malformed, not as an empty answer', async () => {
    const noText = [capturedLine('step_start'), capturedLine('step_finish'), ''].join('\n');
    const response = await replay(noText);

    expect(response.failure?.kind).toBe('malformedResponse');
    expect(response.answerText).toBe('');
    // And the telemetry that DID arrive is still not laundered into a result.
    expect(response.usage.inputTokens).toBeUndefined();
  });

  it('survives a truncated final line, keeping every complete event before it', () => {
    const truncated = [capturedLine('step_start'), capturedLine('text'),
      capturedLine('step_finish').slice(0, 120)].join('\n');
    const turn = parseOpenCodeRun(truncated);

    expect(turn.answerText).toBe('ok');
    // The half-line is skipped rather than half-read: no tokens, no cost, no finish reason from it.
    expect(turn.usageReported).toBe(false);
    expect(turn.reportedCost).toBeUndefined();
    expect(turn.finishReason).toBeUndefined();
  });

  it('skips decorated or logged lines around the events', () => {
    const noisy = ['~  https://opencode.ai/s/abc', capturedLine('text'), '',
      'some warning on stdout', capturedLine('step_finish'), ''].join('\n');
    const turn = parseOpenCodeRun(noisy);

    expect(turn.answerText).toBe('ok');
    expect(turn.usage.inputTokens).toBe(OBSERVED.tokens.input);
  });

  it('accepts the same events wrapped as a JSON array', () => {
    const asArray = JSON.stringify(CAPTURED.split('\n').filter(Boolean).map((line) => JSON.parse(line)));
    const turn = parseOpenCodeRun(asArray);

    expect(turn.answerText).toBe('ok');
    expect(turn.finishReason).toBe('stop');
  });

  it('finds nothing in an empty stream, and says so by leaving everything undefined', () => {
    const turn = parseOpenCodeRun('');

    expect(turn.answerText).toBe('');
    expect(turn.reportedModelID).toBe('');
    expect(turn.usageReported).toBe(false);
    expect(turn.reportedCost).toBeUndefined();
    expect(turn.finishReason).toBeUndefined();
    expect(turn.reportedTextGenerationMilliseconds).toBeUndefined();
  });

  it('reads an error event in the CLI envelope, where the error sits at the top level', async () => {
    // `run` emits `{type:"error", ..., error: <the session.error payload>}` — NOT under `properties`,
    // and NOT on an assistant message. Before this pass an OpenCode auth failure would have been read
    // as a transport fault and retried three times over.
    const unauthenticated = errorEvent({ name: 'ProviderAuthError', data: { providerID: 'opencode', message: 'no credential' } });
    const response = await adapter(unauthenticated, { exitCode: 1, failure: { kind: 'exitCode', detail: 'exit 1' } })
      .complete({ binding: binding(), promptText: 'hi' });

    expect(response.failure?.kind).toBe('notAuthenticated');
    expect(response.failure?.detail).toContain('ProviderAuthError');
  });

  it('reads an API status out of an error event and classifies on it', async () => {
    const rateLimited = errorEvent({ name: 'APIError', data: { statusCode: 429, message: 'slow down', isRetryable: true } });
    const response = await adapter(rateLimited, { exitCode: 1, failure: { kind: 'exitCode', detail: 'exit 1' } })
      .complete({ binding: binding(), promptText: 'hi' });

    expect(response.failure?.kind).toBe('rateLimited');
    expect(response.failure?.detail).toContain('HTTP 429');
  });

  it('prefers the envelope\'s error to the shell\'s exit code', () => {
    // The ordering the Claude path documents: a refusal exits non-zero AND prints a structured error,
    // and reading the exit code first turns a machine-readable refusal into an opaque fault.
    const turn = parseOpenCodeRun(errorEvent({ name: 'MessageAbortedError', data: { message: 'stopped' } }));
    expect(turn.error?.name).toBe('MessageAbortedError');
  });
});

describe('v0.2.5 · through a real fake executable, end to end, the smoke says what it proved', () => {
  /** A fake `opencode` on disk that replays the capture byte for byte for `run`. */
  function fakeOpenCode(directory: string, body: string): string {
    const executable = path.join(directory, 'opencode');
    const payload = path.join(directory, 'run-events.txt');
    fs.writeFileSync(payload, body);
    fs.writeFileSync(executable, ['#!/bin/sh', 'cat > /dev/null',
      `cat ${JSON.stringify(payload)}`, ''].join('\n'), { mode: 0o755 });
    return executable;
  }

  it('reaches EXECUTED-BUT-UNVERIFIABLE: the answer parses, the identity does not exist', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cernum-oc-envelope-'));
    try {
      const frozen = buildSmokeBinding({ provider: 'opencodeCLI', modelID: REQUESTED, effort: 'none' });
      const result = await identitySmokeTest(frozen, new OpenCodeAdapter({
        executablePath: fakeOpenCode(directory, CAPTURED),
      }));

      // WHAT IS NOW TRUE: the request executed and Cernum can read every measured figure it returned.
      expect(result.answerText).toBe('ok');

      // WHAT IS STILL NOT TRUE, and is not made true by the parser fix: who answered.
      expect(result.reportedModelID).toBe('');
      expect(result.requestedModelID).toBe(REQUESTED);
      expect(result.verdict).toBe('unverifiable');

      // PASS 7 CHANGED THE STATE, NOT THE VERDICT. This read `unverifiable` when the parser fix landed,
      // before the governance decision; opencodeCLI is now inside the identity exception, so an accepted
      // and measured request records `requestAcceptedIdentityUnverifiable` — weaker than unverifiable
      // rather than stronger. The verdict above is untouched and nothing here is `proven`.
      expect(result.identityState).toBe(REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE);
      expect(result.identityState).not.toBe('verified');

      // And it is still a metered request, recorded as one rather than as free.
      expect(result.billingBasis).toBe('meteredAPI');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
