// Benchmark engine · per-attempt telemetry. Measure first-token latency instead of declaring it
// unavailable. A port of the proven `telemetry_v2.py`.
//
// The harness this descends from recorded `firstTokenMilliseconds: unavailable` on EVERY attempt,
// because its adapter did not stream. Perceived responsiveness — the thing that actually matters
// to a person waiting for an answer — went unmeasured across a whole cohort. This consumes a token
// stream and times it.
//
// FIVE SEPARATE MEASUREMENTS, NEVER CONFLATED:
//   coldLoadMilliseconds        weights not resident; the runtime reports the load
//   warmResponseMilliseconds    resident; full request/response wall time
//   timeToFirstTokenMilliseconds  the first VISIBLE-ANSWER token; only ever from a stream that saw one
//   totalLatencyMilliseconds    client wall time, start of request to end of stream
//   throughputTokensPerSecondMilli  visible tokens / generation seconds, integer-scaled
//
// THINKING VS VISIBLE. Thinking-capable models spend budget before their answer begins. Counting
// the two channels together is how a thinking trace that exhausts the output budget turns into a
// mysterious empty reply. The two are counted separately, and first-token is timed on the VISIBLE
// channel with the first thinking token recorded beside it.
//
// AN UNMEASURED VALUE IS NEVER SILENTLY REPLACED BY A GUESS. Where a provider does not expose a
// split, the value is recorded as unavailable WITH A REASON.

import { Measurement, measured, unavailable } from '../core/candidate';

export type StreamChannel = 'visible' | 'thinking';

export interface StreamEvent {
  channel: StreamChannel;
  /** Tokens carried by this event, as the runtime counts them. */
  tokens: number;
  /** Milliseconds since the request was sent. */
  atMilliseconds: number;
}

export interface RuntimeReportedTiming {
  /** Nanoseconds the runtime spent loading weights. Absent when it did not say. */
  loadDurationNanoseconds?: number;
  promptEvalDurationNanoseconds?: number;
  evalDurationNanoseconds?: number;
  evalTokenCount?: number;
  promptTokenCount?: number;
  doneReason?: string;
  /** True when the runtime reported it had to load the weights for this request. */
  weightsWereLoaded?: boolean;
}

export interface AttemptTelemetry {
  coldLoadMilliseconds: Measurement<number>;
  warmResponseMilliseconds: Measurement<number>;
  timeToFirstTokenMilliseconds: Measurement<number>;
  firstThinkingTokenMilliseconds: Measurement<number>;
  totalLatencyMilliseconds: Measurement<number>;
  throughputTokensPerSecondMilli: Measurement<number>;
  visibleTokenCount: Measurement<number>;
  thinkingTokenCount: Measurement<number>;
  promptTokenCount: Measurement<number>;
  doneReason: Measurement<string>;
  /** True when the stream produced thinking tokens but no visible ones — the budget-exhaustion shape. */
  thinkingOnly: boolean;
  streamed: boolean;
}

const NO_STREAM = 'the adapter did not stream, so no token arrival time was observed';

/**
 * Fold a stream of token events plus whatever the runtime reported into one attempt's telemetry.
 *
 * `totalElapsedMilliseconds` is the client's own wall clock, which is the only number that is
 * always available and the only one that includes queueing.
 */
export function summariseAttempt(events: StreamEvent[], runtime: RuntimeReportedTiming, totalElapsedMilliseconds: number | undefined): AttemptTelemetry {
  const streamed = events.length > 0;
  const visible = events.filter((event) => event.channel === 'visible');
  const thinking = events.filter((event) => event.channel === 'thinking');
  const visibleTokens = visible.reduce((sum, event) => sum + event.tokens, 0);
  const thinkingTokens = thinking.reduce((sum, event) => sum + event.tokens, 0);

  const firstVisible = visible.find((event) => event.tokens > 0);
  const firstThinking = thinking.find((event) => event.tokens > 0);

  const nanosecondsToMilliseconds = (nanoseconds: number | undefined, reason: string): Measurement<number> =>
    nanoseconds === undefined ? unavailable(reason) : measured(Math.round(nanoseconds / 1_000_000));

  const coldLoad: Measurement<number> = runtime.weightsWereLoaded === false
    ? unavailable('the weights were already resident, so this request did not measure a cold load')
    : nanosecondsToMilliseconds(runtime.loadDurationNanoseconds, 'the runtime did not report a load duration');

  const warm: Measurement<number> = runtime.weightsWereLoaded === true
    ? unavailable('the weights were loaded during this request, so its wall time is not a warm response')
    : totalElapsedMilliseconds === undefined
      ? unavailable('no client wall time was recorded for this attempt')
      : measured(Math.round(totalElapsedMilliseconds));

  // Throughput is derived from runtime-reported inputs only, never from the client clock, and is
  // unavailable rather than zero when either input is missing.
  let throughput: Measurement<number>;
  if (runtime.evalTokenCount === undefined) throughput = unavailable('the runtime reported no completion token count');
  else if (runtime.evalDurationNanoseconds === undefined || runtime.evalDurationNanoseconds <= 0) {
    throughput = unavailable('the runtime reported no positive evaluation duration');
  } else {
    throughput = measured(Number((BigInt(runtime.evalTokenCount) * 1_000n * 1_000_000_000n) / BigInt(runtime.evalDurationNanoseconds)));
  }

  return {
    coldLoadMilliseconds: coldLoad,
    warmResponseMilliseconds: warm,
    timeToFirstTokenMilliseconds: firstVisible
      ? measured(Math.round(firstVisible.atMilliseconds))
      : unavailable(streamed
        ? 'the stream carried no visible-answer token, so there was no first token to time'
        : NO_STREAM),
    firstThinkingTokenMilliseconds: firstThinking
      ? measured(Math.round(firstThinking.atMilliseconds))
      : unavailable(streamed ? 'the stream carried no thinking token' : NO_STREAM),
    totalLatencyMilliseconds: totalElapsedMilliseconds === undefined
      ? unavailable('no client wall time was recorded for this attempt')
      : measured(Math.round(totalElapsedMilliseconds)),
    throughputTokensPerSecondMilli: throughput,
    visibleTokenCount: streamed ? measured(visibleTokens) : unavailable(NO_STREAM),
    thinkingTokenCount: streamed ? measured(thinkingTokens) : unavailable(NO_STREAM),
    promptTokenCount: runtime.promptTokenCount === undefined ? unavailable('the runtime reported no prompt token count') : measured(runtime.promptTokenCount),
    doneReason: runtime.doneReason === undefined ? unavailable('the runtime gave no reason for stopping') : measured(runtime.doneReason),
    thinkingOnly: thinkingTokens > 0 && visibleTokens === 0,
    streamed,
  };
}

/**
 * The one-line explanation for an attempt that produced no visible answer.
 *
 * This exists because "empty reply" is the least useful thing a benchmark can say. When the stream
 * shows thinking tokens and no visible ones, the cause is nearly always the output budget, and
 * saying so turns an unexplained failure into a fixable configuration note.
 */
export function explainEmptyAnswer(telemetry: AttemptTelemetry, maxOutputTokens: number): string | undefined {
  if (!telemetry.thinkingOnly) return undefined;
  const thinking = 'measured' in telemetry.thinkingTokenCount ? telemetry.thinkingTokenCount.measured : undefined;
  if (thinking === undefined) return 'the model produced thinking tokens and no visible answer';
  return `the model spent ${thinking} of its ${maxOutputTokens}-token budget thinking and never began its visible answer; this is a budget setting, not a capability failure`;
}
