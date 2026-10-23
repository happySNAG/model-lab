// Cernum core · runtime-reported execution telemetry (port of `ModelLabRuntimeTelemetry`).

import { Measurement } from './candidate';

export interface RuntimeTelemetry {
  runtimeName: string;
  runtimeVersion: Measurement<string>;
  loadDurationMilliseconds: Measurement<number>;
  promptEvalDurationMilliseconds: Measurement<number>;
  evalDurationMilliseconds: Measurement<number>;
  tokensPerSecondMilli: Measurement<number>;
  runtimeReportedContextLimitTokens: Measurement<number>;
  modelMemoryBytes: Measurement<number>;
  doneReason: Measurement<string>;
  thinkingMode?: Measurement<string>;
  thinkingTraceCharacterCount?: Measurement<number>;
}

/** tokens/second × 1000 from runtime-reported inputs only; unavailable (never zero) when either is missing. */
export function derivedTokensPerSecondMilli(evalTokenCount: Measurement<number>, evalDurationNanoseconds: Measurement<number>): Measurement<number> {
  if (!('measured' in evalTokenCount)) return { unavailableReason: 'the runtime reported no completion token count' };
  if (!('measured' in evalDurationNanoseconds) || evalDurationNanoseconds.measured <= 0) {
    return { unavailableReason: 'the runtime reported no positive evaluation duration' };
  }
  const value = (BigInt(evalTokenCount.measured) * 1_000n * 1_000_000_000n) / BigInt(evalDurationNanoseconds.measured);
  return { measured: Number(value) };
}
