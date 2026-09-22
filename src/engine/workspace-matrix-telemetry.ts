// Benchmark engine · one loopback telemetry collector for a whole Codex matrix, scoped per run so no
// run's telemetry can be attached to another.
//
// WHY ONE COLLECTOR AND NOT ONE PER RUN. The observer already keys everything by the conversation id
// the CLI prints as `thread_id`, and that id is minted per `codex exec`: two runs cannot share one.
// Keying by it is what makes the collector safe to share — sequentially today, concurrently if a
// matrix ever runs cells in parallel — and a per-run socket would add nothing except a new way to lose
// the records that arrive after a run closes. What a shared collector DOES need is a statement of who
// claimed which conversation, so that the impossible case (one id reported by two attempts) is caught
// and refused rather than silently attributed to whichever asked first. That is this module.
//
// WHAT IT NEVER DOES. It never attaches a record by time, never picks the "nearest" conversation to an
// attempt that reported no id, and never lets a record without a conversation id reach any run. It
// sends nothing anywhere: the observer binds 127.0.0.1 on an ephemeral port and makes no outbound
// connection, and the CLI is pointed at it by a per-invocation `-c otel=…` override that touches
// neither `forced_login_method` nor the child's environment — so attaching it cannot change who pays.
//
// A COLLECTOR THAT CANNOT MEASURE IS A HARNESS PROBLEM. If it cannot start, the matrix is refused
// before anything is sent; if it dies part-way, every observation after that is marked
// `observerFailed` and the matrix stops launching Codex runs — neither is ever recorded as something
// the provider or the model did.

import * as path from 'node:path';
import { OTLPObserver, OTLPTurnObservation, OTLPTurnSource } from './otlp-observer';
import {
  AppliedEffortVerdict, LateAppliedEffortEvidence, TELEMETRY_CORRELATION_BOUNDARY, WorkspaceTelemetryCapture,
  attemptAppliedEffortEvidence,
} from './workspace-effort-evidence';
import { EffortLevel } from './provider';

export class WorkspaceMatrixTelemetryError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'WorkspaceMatrixTelemetryError';
  }
}

/** The collector, as the matrix runner sees it. The seam the tests replace. */
export interface WorkspaceMatrixTelemetrySource {
  readonly endpoint: string;
  readonly capture: WorkspaceTelemetryCapture;
  /** A source scoped to one run. Every conversation it is asked about is claimed by that run. */
  sourceFor(claim: WorkspaceTelemetryClaim): OTLPTurnSource;
  /** Why the collector stopped working, or undefined while it works. */
  failure(): string | undefined;
}

/** Who is asking about a conversation. `runKey` is the record root: unique per run in a matrix. */
export interface WorkspaceTelemetryClaim {
  runKey: string;
  candidate: string;
  caseID: string;
  repeatIndex: number;
  requestedModelID: string;
  requestedEffort: EffortLevel;
}

/** The part of `OTLPObserver` this module uses. Declared so a test can hand in a collector that dies. */
export interface MatrixObserver extends OTLPTurnSource {
  readonly failure: string | undefined;
  readonly unreadablePayloadCount: number;
  snapshot(): Record<string, OTLPTurnObservation>;
  stop(): Promise<{ payloadCount: number; conversationCount: number; correlatedCount: number; leakAuditClean: boolean;
    leaks: string[]; evidenceFile: string; indexFile: string; unreadablePayloadCount: number; failure?: string }>;
}

/** Two attempts that reported the same conversation id. Neither is attributed the telemetry. */
export interface TelemetryCollision {
  correlationKey: string;
  claimants: string[];
}

export interface WorkspaceMatrixTelemetrySummary {
  endpoint: string;
  evidenceFile: string;
  indexFile: string;
  payloadCount: number;
  unreadablePayloadCount: number;
  conversationCount: number;
  correlatedCount: number;
  leakAuditClean: boolean;
  leakCount: number;
  failure?: string;
  collisions: TelemetryCollision[];
  correlationBoundary: string;
}

interface Claimed { runKey: string; attempt: number; claim: WorkspaceTelemetryClaim; correlationKey?: string }

const copyOf = (observation: OTLPTurnObservation): OTLPTurnObservation =>
  JSON.parse(JSON.stringify(observation)) as OTLPTurnObservation;

export class WorkspaceMatrixTelemetryCollector implements WorkspaceMatrixTelemetrySource {
  /** Conversation id → the first attempt that claimed it. In memory only; the id never reaches a file. */
  private readonly claims = new Map<string, Claimed>();

  private readonly collisionsByKey = new Map<string, Set<string>>();

  private readonly attemptsByRun = new Map<string, number>();

  constructor(private readonly observer: MatrixObserver, readonly capture: WorkspaceTelemetryCapture) {}

  /**
   * Start a loopback collector for one matrix, writing redacted evidence under `directory`.
   *
   * Refuses — with a harness error, never a provider one — when the socket cannot be bound. The CLI
   * turns that into "nothing was sent": a Codex matrix whose applied effort cannot be measured cannot
   * qualify a single route, so spending allowance on it would buy nothing.
   */
  static async start(options: {
    directory: string; runLabel: string; observeTimeoutMilliseconds?: number; shutdownGraceMilliseconds?: number;
    port?: number;
  }): Promise<WorkspaceMatrixTelemetryCollector> {
    const evidenceFile = path.join(options.directory, `${options.runLabel}-otlp-payloads.redacted.jsonl`);
    const observeTimeoutMilliseconds = options.observeTimeoutMilliseconds ?? 2_000;
    let observer: OTLPObserver;
    try {
      observer = await OTLPObserver.start({
        evidenceFile, observeTimeoutMilliseconds, shutdownGraceMilliseconds: options.shutdownGraceMilliseconds,
        port: options.port,
      });
    } catch (error) {
      throw new WorkspaceMatrixTelemetryError('observerUnavailable',
        `the loopback telemetry collector could not be started (${String(error)}). Without it no Codex run's applied `
        + 'effort can be measured and no route could qualify, so nothing was sent. This is a measurement failure on this '
        + 'machine, not a provider or model failure.');
    }
    return new WorkspaceMatrixTelemetryCollector(observer, {
      collector: 'otlp-http loopback (127.0.0.1, ephemeral port)',
      evidenceFile: path.resolve(evidenceFile),
      observeWaitMilliseconds: observeTimeoutMilliseconds,
      correlationBoundary: TELEMETRY_CORRELATION_BOUNDARY,
    });
  }

  get endpoint(): string {
    return this.observer.endpoint;
  }

  failure(): string | undefined {
    return this.observer.failure;
  }

  get collisions(): TelemetryCollision[] {
    return [...this.collisionsByKey.entries()].map(([correlationKey, claimants]) =>
      ({ correlationKey, claimants: [...claimants].sort() }));
  }

  /**
   * A telemetry source that belongs to ONE run.
   *
   * Every conversation id this source is asked about is claimed by the run, attempt by attempt. A
   * conversation id already claimed by another run — or by an earlier attempt of this one — is a
   * collision: the observation comes back with `attributionRefused` set, and the collision is kept so
   * the attempt that claimed it first can be flagged after the fact as well.
   */
  sourceFor(claim: WorkspaceTelemetryClaim): OTLPTurnSource {
    return {
      endpoint: this.observer.endpoint,
      observe: async (threadID: string) => {
        const attempt = (this.attemptsByRun.get(claim.runKey) ?? 0) + 1;
        this.attemptsByRun.set(claim.runKey, attempt);
        const failedBefore = this.observer.failure;
        if (failedBefore !== undefined) {
          return { correlated: false, recordCount: 0, correlationKey: '', observerFailure: failedBefore };
        }
        const observation = await this.observer.observe(threadID);
        if (observation === undefined) return undefined;
        const result = copyOf(observation);
        const claimant = `${claim.runKey}#attempt-${attempt}`;
        const prior = this.claims.get(threadID);
        if (prior === undefined) {
          this.claims.set(threadID, { runKey: claim.runKey, attempt, claim, correlationKey: observation.correlationKey });
        } else {
          const set = this.collisionsByKey.get(observation.correlationKey)
            ?? new Set([`${prior.runKey}#attempt-${prior.attempt}`]);
          set.add(claimant);
          this.collisionsByKey.set(observation.correlationKey, set);
          result.attributionRefused = `conversation ${observation.correlationKey} was already claimed by `
            + `${prior.claim.candidate} · ${prior.claim.caseID} · repeat ${prior.claim.repeatIndex} (attempt ${prior.attempt}). `
            + 'A conversation id reported by two attempts is attributed to neither.';
        }
        const failedDuring = this.observer.failure;
        if (failedDuring !== undefined && !result.correlated) result.observerFailure = failedDuring;
        return result;
      },
    };
  }

  /**
   * Stop the collector (with its grace period, so records still in the exporter's queue land) and
   * report what it saw. Returns the observations so late evidence can be computed against the rows.
   */
  async stop(): Promise<{ summary: WorkspaceMatrixTelemetrySummary; observations: Record<string, OTLPTurnObservation> }> {
    const stopped = await this.observer.stop();
    return {
      summary: {
        endpoint: this.observer.endpoint,
        evidenceFile: stopped.evidenceFile,
        indexFile: stopped.indexFile,
        payloadCount: stopped.payloadCount,
        unreadablePayloadCount: stopped.unreadablePayloadCount,
        conversationCount: stopped.conversationCount,
        correlatedCount: stopped.correlatedCount,
        leakAuditClean: stopped.leakAuditClean,
        leakCount: stopped.leaks.length,
        failure: stopped.failure,
        collisions: this.collisions,
        correlationBoundary: TELEMETRY_CORRELATION_BOUNDARY,
      },
      observations: this.observer.snapshot(),
    };
  }
}

/**
 * What arrived AFTER each run was sealed, re-judged under the same rules — reported, and able only to
 * take a qualification away.
 *
 * A sealed verdict is never rewritten. An attempt sealed `noTelemetryForConversation` whose records
 * arrived later is listed with the verdict those records would have produced; an attempt whose
 * conversation id turned out to be claimed twice is listed as ambiguous whatever it was sealed as.
 */
export function lateAppliedEffortEvidence(
  runs: { recordRoot: string; row: Record<string, unknown> }[],
  observations: Record<string, OTLPTurnObservation>,
  collisions: TelemetryCollision[] = [],
): LateAppliedEffortEvidence[] {
  const late: LateAppliedEffortEvidence[] = [];
  const collided = new Set(collisions.map((entry) => entry.correlationKey));
  for (const { recordRoot, row } of runs) {
    const attempts = Array.isArray(row.appliedEffortAttempts) ? row.appliedEffortAttempts as Record<string, unknown>[] : [];
    for (const attempt of attempts) {
      const key = typeof attempt.correlationKey === 'string' ? attempt.correlationKey : undefined;
      const attemptIndex = typeof attempt.attemptIndex === 'number' ? attempt.attemptIndex : 0;
      const sealedVerdict = String(attempt.verdict);
      if (key === undefined) continue;
      if (collided.has(key) && sealedVerdict !== 'appliedEffortAmbiguous') {
        late.push({ recordRoot, attemptIndex, sealedVerdict, lateVerdict: 'appliedEffortAmbiguous',
          detail: `conversation ${key} was later claimed by another attempt as well, so neither can own its telemetry` });
        continue;
      }
      if (attempt.correlation !== 'noTelemetryForConversation') continue;
      const observation = observations[key];
      if (observation === undefined || observation.recordCount === 0) continue;
      const rejudged = attemptAppliedEffortEvidence({
        requestedEffort: String(attempt.requestedEffort) as EffortLevel,
        requestedModelID: typeof row.requestedModelID === 'string' ? row.requestedModelID : '',
        collectorAttached: true,
        requestSent: true,
        threadID: key,
        observation,
      });
      if (rejudged.verdict === 'appliedEffortUnavailable') continue;
      late.push({
        recordRoot, attemptIndex, sealedVerdict, lateVerdict: rejudged.verdict as AppliedEffortVerdict,
        lateAppliedEffort: rejudged.appliedEffort,
        detail: `arrived after the record was sealed: ${rejudged.detail} The sealed verdict stands; a late record can only `
          + 'withdraw a qualification, never grant one.',
      });
    }
  }
  return late;
}
