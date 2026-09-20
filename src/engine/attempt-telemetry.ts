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
// split, the value is recorded as unavailable WITH A REASON. In particular this module does NOT
// estimate a token count from text length: a character-per-token ratio is a property of a
// tokenizer, it differs per model and per script, and a number derived from one is indistinguishable
// from a measured one once it is written into evidence. `unavailable` plus a reason is worth more
// than a plausible number, because a reader can act on it.
//
// ARRIVAL TIMES ARE OBSERVED, NEVER RECONSTRUCTED. `atMilliseconds` on an event is the moment the
// caller SAW the bytes. It is never computed from the runtime's own reported durations: those say
// how long the runtime spent, not when anything reached the client, and the two differ by queueing,
// transport and scheduling — precisely the delay a person waiting for an answer experiences.

import { Measurement, measured, unavailable } from '../core/candidate';

export type StreamChannel = 'visible' | 'thinking';

export interface StreamEvent {
  channel: StreamChannel;
  /**
   * Tokens carried by this event, when the runtime counts per event. ABSENT when it does not —
   * Ollama's stream carries text deltas and reports a single combined completion count only at the
   * end, so a per-channel figure is genuinely unavailable rather than merely unread.
   */
  tokens?: number;
  /** Milliseconds from the moment the request was sent to the moment this event was OBSERVED. */
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
  /** Every completion token the runtime counted, across both channels. Its own figure, unsplit. */
  completionTokenCount: Measurement<number>;
  promptTokenCount: Measurement<number>;
  doneReason: Measurement<string>;
  /** True when the stream carried thinking output and no visible output — the budget-exhaustion shape. */
  thinkingOnly: boolean;
  /** True when token arrival was actually observed, so first-token times are measurements. */
  streamed: boolean;
}

const NO_STREAM = 'the adapter did not stream, so no token arrival time was observed';
const NO_SPLIT = 'the runtime reported one combined completion token count and no per-channel split, and this engine does not estimate a token count from text length';
const NO_COUNT = 'the runtime reported no completion token count, and this engine does not estimate one from text length';

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

  const firstVisible = visible[0];
  const firstThinking = thinking[0];

  /**
   * One channel's token count, from the best evidence available and never from an estimate.
   *
   *  · the events themselves carry counts    -> their sum, which is what the runtime counted
   *  · this channel produced nothing at all  -> zero, which is an observation and not a guess
   *  · this channel was the ONLY one active  -> the runtime's combined completion count belongs
   *                                             entirely to it, so it is that channel's count
   *  · both channels were active             -> unavailable: the runtime published one number for
   *                                             two channels and splitting it would be invention
   */
  const channelTokens = (own: StreamEvent[], other: StreamEvent[]): Measurement<number> => {
    if (!streamed) return unavailable(NO_STREAM);
    if (own.length > 0 && own.every((event) => event.tokens !== undefined)) {
      return measured(own.reduce((sum, event) => sum + (event.tokens ?? 0), 0));
    }
    if (own.length === 0) return measured(0);
    if (other.length === 0) {
      return runtime.evalTokenCount === undefined ? unavailable(NO_COUNT) : measured(runtime.evalTokenCount);
    }
    return unavailable(runtime.evalTokenCount === undefined ? NO_COUNT : NO_SPLIT);
  };

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

  // Throughput is the runtime's OWN completion token count over the runtime's OWN generation
  // duration — never the client clock, never an estimated count — and is unavailable rather than
  // zero when either input is missing.
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
    visibleTokenCount: channelTokens(visible, thinking),
    thinkingTokenCount: channelTokens(thinking, visible),
    completionTokenCount: runtime.evalTokenCount === undefined ? unavailable('the runtime reported no completion token count') : measured(runtime.evalTokenCount),
    promptTokenCount: runtime.promptTokenCount === undefined ? unavailable('the runtime reported no prompt token count') : measured(runtime.promptTokenCount),
    doneReason: runtime.doneReason === undefined ? unavailable('the runtime gave no reason for stopping') : measured(runtime.doneReason),
    // Decided from what the channels CARRIED, not from a token count that may be unavailable: a
    // stream that produced reasoning and no answer is the budget-exhaustion shape whether or not
    // the runtime was willing to say how many tokens that was.
    thinkingOnly: thinking.length > 0 && visible.length === 0,
    streamed,
  };
}

/**
 * The terminal reasons that mean THE OUTPUT CEILING ENDED THE ANSWER, in every dialect Cernum reads.
 *
 * `length` is Ollama's and the OpenAI API's word for it; `max_tokens` and `max_output_tokens` are
 * the Anthropic API's. They are one event described by three vocabularies, and this set is where
 * that is stated once — the recorded `doneReason` keeps whichever word the provider itself used, so
 * nothing here rewrites a provider's own report.
 */
const OUTPUT_LIMIT_TERMINAL_REASONS = new Set(['length', 'max_tokens', 'max_output_tokens']);

/**
 * True when the provider SAID it stopped at the output limit.
 *
 * False when it said it stopped for any other reason AND when it said nothing at all — the two are
 * different facts, and `doneReason` above is where a reader tells them apart. This predicate exists
 * so "was this answer truncated" is asked in one place rather than by every caller comparing
 * strings, and so a scorer cannot read a ceiling-truncated answer as a completed one by accident.
 */
export function endedAtOutputLimit(telemetry: AttemptTelemetry): boolean {
  return 'measured' in telemetry.doneReason && OUTPUT_LIMIT_TERMINAL_REASONS.has(telemetry.doneReason.measured);
}

/**
 * The one-line note for an answer the provider says its output ceiling cut short.
 *
 * Undefined when the provider said it finished, and undefined when it said nothing: an attempt
 * whose terminal reason is unknown is not announced as truncated on a guess.
 */
export function explainTruncatedAnswer(telemetry: AttemptTelemetry, maxOutputTokens: number): string | undefined {
  if (!endedAtOutputLimit(telemetry)) return undefined;
  const reason = 'measured' in telemetry.doneReason ? telemetry.doneReason.measured : '';
  return `the provider stopped at the output token limit (terminal reason '${reason}') with a `
    + `${maxOutputTokens}-token budget; what was scored is a truncated generation, not a completed answer`;
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
  if (thinking === undefined) return 'the model produced reasoning and no visible answer, and the runtime did not report how many tokens that took';
  return `the model spent ${thinking} of its ${maxOutputTokens}-token budget thinking and never began its visible answer; this is a budget setting, not a capability failure`;
}
