// Benchmark engine · a fully deterministic host, so a whole campaign — create, pause, resume,
// abort, finalize, review — can be exercised without a single request reaching any server.
//
// This is not a mock of the engine. It is a real host driving the REAL campaign code path: the same
// ledger, the same guards, the same manifest verification, the same residency proof. That is the
// only kind of synthetic campaign worth having; one that shortcuts the orchestration proves the
// shortcut works and nothing else.

import { CanonicalValue } from './canonical';
import { AttemptOutcome, AttemptRequest, CampaignHost } from './campaign';
import { PlanSlot, PlannableCandidate, TerminalSlotStatus } from './ledger';
import { GIB, SystemReading } from './guards';
import { ResidencyController, ScriptedResidency } from './residency';
import { ObservedModelIdentity } from './verification';

export interface ScriptedAnswer {
  status: TerminalSlotStatus;
  answerText: string;
  governanceViolated?: boolean;
  /** Milliseconds of simulated wall time. */
  latencyMilliseconds?: number;
  visibleTokens?: number;
  thinkingTokens?: number;
  /** Drop the supplied context, to exercise the measurement-fault path. */
  dropContext?: boolean;
  /** Truncate the supplied context to this many characters. */
  truncateContextTo?: number;
  failure?: { code: string; detail: string };
}

export interface SyntheticScript {
  /** Answer chosen by slot key, then by case, then the default. */
  bySlotKey?: Record<string, ScriptedAnswer>;
  byCaseID?: Record<string, ScriptedAnswer>;
  byCandidate?: Record<string, ScriptedAnswer>;
  defaultAnswer?: ScriptedAnswer;
  /** Identity the runtime reports, by candidate name. Absent means "exactly what was pinned". */
  identities?: Record<string, ObservedModelIdentity>;
  /** System readings, consumed in order; the last one repeats. */
  readings?: Partial<SystemReading>[];
  /** Unload behaviour by model name; see ScriptedResidency. */
  residencyScript?: Record<string, number | 'never'>;
}

export const HEALTHY_READING: SystemReading = {
  freeDiskBytes: 200 * GIB,
  swapUsedBytes: 0,
  freeMemoryBytes: 16 * GIB,
  totalMemoryBytes: 32 * GIB,
  listeners: { '11436': 4242 },
  modelStoreListingDigest: 'store-baseline-digest',
  modelStoreCount: 8,
};

const DEFAULT_ANSWER: ScriptedAnswer = { status: 'pass', answerText: 'a scripted answer', latencyMilliseconds: 120, visibleTokens: 24 };

/** A clock that advances by a fixed step on every read, so timestamps are ordered and reproducible. */
export function steppingClock(startISO = '2026-01-01T00:00:00Z', stepMilliseconds = 1_000): () => Date {
  let current = new Date(startISO).getTime();
  return () => {
    const value = new Date(current);
    current += stepMilliseconds;
    return value;
  };
}

export class SyntheticHost implements CampaignHost {
  readonly residency: ScriptedResidency;
  private readingIndex = 0;
  /** Every request the campaign made, in order — so a test can assert what was actually sent. */
  readonly requests: AttemptRequest[] = [];

  constructor(
    private readonly script: SyntheticScript = {},
    readonly now: () => Date = steppingClock(),
    private readonly pinned: Record<string, ObservedModelIdentity> = {},
  ) {
    this.residency = new ScriptedResidency(script.residencyScript ?? {});
  }

  private answerFor(slot: PlanSlot): ScriptedAnswer {
    return this.script.bySlotKey?.[slot.slotKey]
      ?? this.script.byCaseID?.[slot.caseID]
      ?? this.script.byCandidate?.[slot.candidate]
      ?? this.script.defaultAnswer
      ?? DEFAULT_ANSWER;
  }

  async observeIdentity(candidate: PlannableCandidate): Promise<ObservedModelIdentity> {
    return this.script.identities?.[candidate.name] ?? this.pinned[candidate.name] ?? {};
  }

  async run(request: AttemptRequest): Promise<AttemptOutcome> {
    this.requests.push(request);
    // Running against a model loads its weights. Saying so is what makes the residency proof at the
    // next candidate transition a real proof rather than a check against an empty set.
    (this.residency as ScriptedResidency).load(request.slot.candidate);
    const answer = this.answerFor(request.slot);
    const latency = answer.latencyMilliseconds ?? 120;
    const visible = answer.visibleTokens ?? 24;
    const thinking = answer.thinkingTokens ?? 0;

    let assembledContext = request.suppliedContext;
    if (answer.dropContext) assembledContext = undefined;
    else if (answer.truncateContextTo !== undefined && assembledContext !== undefined) {
      assembledContext = assembledContext.slice(0, answer.truncateContextTo);
    }

    const streamEvents = [];
    let at = Math.round(latency * 0.1);
    if (thinking > 0) {
      streamEvents.push({ channel: 'thinking' as const, tokens: thinking, atMilliseconds: at });
      at += Math.round(latency * 0.4);
    }
    if (visible > 0) streamEvents.push({ channel: 'visible' as const, tokens: visible, atMilliseconds: at });

    return {
      answerText: answer.answerText,
      assembledContext,
      streamEvents,
      runtime: {
        evalTokenCount: visible + thinking,
        evalDurationNanoseconds: Math.max(1, latency) * 1_000_000,
        promptTokenCount: Math.max(1, Math.round(request.promptText.length / 4)),
        doneReason: visible > 0 ? 'stop' : 'length',
        weightsWereLoaded: false,
      },
      totalElapsedMilliseconds: latency,
      failure: answer.failure,
    };
  }

  async score(slot: PlanSlot, answerText: string): Promise<{ status: TerminalSlotStatus; governanceViolated: boolean; detail: string }> {
    const answer = this.answerFor(slot);
    return {
      status: answer.status,
      governanceViolated: answer.governanceViolated === true,
      detail: `scripted outcome for ${slot.caseID} (${answerText.length} characters)`,
    };
  }

  async readSystem(): Promise<SystemReading> {
    const overrides = this.script.readings ?? [];
    const chosen = overrides.length === 0 ? {} : overrides[Math.min(this.readingIndex, overrides.length - 1)];
    this.readingIndex += 1;
    return { ...HEALTHY_READING, ...chosen };
  }
}

/** The synthetic hardware a deterministic campaign is frozen against. */
export const SYNTHETIC_HARDWARE = {
  platform: 'synthetic',
  architecture: 'synthetic',
  model: 'Synthetic Deterministic Host',
  cpuCoreCount: 8,
  physicalMemoryBytes: 32 * GIB,
  osVersion: 'synthetic 1.0',
};

export const SYNTHETIC_STORE_BASELINE = { listingDigest: 'store-baseline-digest', count: 8 };

export function syntheticCandidate(name: string): PlannableCandidate & {
  runtimeDigest: string; parameterSize: string; quantization: string;
} {
  return { name, modelID: name, runtimeDigest: `digest-${name}`, parameterSize: '4B', quantization: 'Q4_K_M' };
}

export type { CanonicalValue };
