// Cernum core · evaluation adapter boundary (port of `ModelLabAdapter`).

import { seal } from './digest';
import { CandidateDescriptor, ExecutionClass } from './candidate';
import { BenchmarkMessage, GenerationSettings, ResponseFormat } from './benchmark';
import { Observation } from './run';

/** Explicit, shared cancellation: the executor checks it between attempts; adapters check it mid-invocation. */
export class CancellationToken {
  private cancelled = false;
  private readonly listeners: Array<() => void> = [];
  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    for (const listener of [...this.listeners]) listener();
  }
  get isCancelled(): boolean {
    return this.cancelled;
  }
  /** Register a listener; it fires immediately if already cancelled. Returns an unsubscribe function. */
  onCancel(listener: () => void): () => void {
    if (this.cancelled) listener();
    this.listeners.push(listener);
    return () => {
      const at = this.listeners.indexOf(listener);
      if (at >= 0) this.listeners.splice(at, 1);
    };
  }
}

export interface AttemptRequest {
  attemptID: string;
  messages: BenchmarkMessage[];
  syntheticContext?: string;
  generationSettings: GenerationSettings;
  responseFormat: ResponseFormat;
  executionBudgetMilliseconds: number;
}

export function requestDigest(request: AttemptRequest): string {
  return seal(request, 'mlo1:');
}

/** `invoke` ALWAYS returns an observation — failures are represented, never thrown away. */
export interface EvaluationAdapter {
  readonly adapterID: string;
  readonly supportedExecutionClasses: ExecutionClass[];
  invoke(request: AttemptRequest, candidate: CandidateDescriptor, cancellation: CancellationToken): Promise<Observation>;
}
