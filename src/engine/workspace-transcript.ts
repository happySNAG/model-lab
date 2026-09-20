// Benchmark engine · what actually happened during an agentic attempt, as a record rather than a
// story.
//
// A PROSE ATTEMPT PRODUCES A STRING; AN AGENTIC ATTEMPT PRODUCES A HISTORY. `Observation` in the
// portable core carries `outputText` and `toolCallObservationsRaw: string[]`, which can represent
// "the model said something" and "some tool calls happened, here is their text". It cannot
// represent a file being written, a test being run, a failure being read, or a second attempt being
// started — and those are the things this benchmark exists to measure. So the transcript is its own
// model.
//
// EVERY EVENT CARRIES ITS PROVENANCE, AND THAT IS THE LOAD-BEARING FIELD.
//
//   `engineObserved`  Cernum did this itself, or watched the filesystem do it. The engine ran the
//                     command and holds the exit status; the engine diffed the tree and holds the
//                     digests. These events are evidence.
//   `agentReported`   the tool's own stream said so. A CLI that reports a tidy sequence of edits and
//                     leaves a stray file behind has reported a tidy sequence of edits. These events
//                     are TESTIMONY, and the scorer never rests a verdict on one.
//
// Mixing the two into one undifferentiated list is how a harness ends up scoring what a model said
// it did. Every consumer downstream — the scorer, the ranking, the report — filters on this field
// before counting anything.
//
// THE TRANSCRIPT IS CANONICALLY ENCODABLE, so it can be digested and put in the ledger: integers
// only, no floats, sorted keys, redacted at append time rather than on the way out.

import { CanonicalValue, digestObject } from './canonical';
import { redactSecrets, redactValue } from './redaction';

export type EventProvenance = 'engineObserved' | 'agentReported';

/**
 * WHY AN ATTEMPT STOPPED, as a closed set rather than as prose.
 *
 * THE AUDIT THAT PUT THIS HERE. Before it, an attempt's ending was recoverable only by reading the
 * `detail` string on `attemptFinished`, or by reaching past the transcript into
 * `WorkspaceAgentResult.failure?.kind` and mapping it by hand at each call site. Both are inference.
 * A transcript that cannot say "this stopped because the deadline passed" without someone parsing a
 * sentence is a transcript whose most important fact is the least reliable one in it — and the
 * difference between `deadlineExceeded` and `agentCompleted` is the difference between a
 * measurement and a non-measurement.
 *
 * It is a FIELD, not an event kind. The attempt already has exactly one ending, `attemptFinished`
 * already marks it, and a second event carrying only a reason would be a second place for the two
 * to disagree.
 */
export type TerminationReason =
  /** The tool finished under its own steam. Says nothing about whether the task was done. */
  | 'agentCompleted'
  /** The tool ran and reported a failure of its own: a non-zero exit, unreadable output, a transport fault. */
  | 'agentFailed'
  /** The deadline passed with work still in flight. An unfinished measurement, not a slow one. */
  | 'deadlineExceeded'
  /** A pause or an abort stopped it. */
  | 'cancelled'
  /** The PROVIDER declined — a rate limit, an expired session. Never a quality outcome. */
  | 'providerDeclined'
  /** The tool could not be started at all: not installed, or it would not spawn. */
  | 'driverUnavailable'
  /** The driver could not express something the case froze, so the request was never sent. */
  | 'policyNotExpressible'
  /** Cernum faulted. Nothing about a model was measured. */
  | 'harnessFault'
  /** The attempt wrote outside the workspace it was given. */
  | 'workspaceEscape';

/** The one mapping from a driver's failure to a termination reason. Pure, and used by every caller. */
export function terminationReasonFor(failureKind: string | undefined): TerminationReason {
  switch (failureKind) {
    case undefined: return 'agentCompleted';
    case 'timeout': return 'deadlineExceeded';
    case 'cancelled': return 'cancelled';
    case 'rateLimited': case 'notAuthenticated': return 'providerDeclined';
    case 'notInstalled': case 'spawnFailure': return 'driverUnavailable';
    case 'policyNotExpressible': return 'policyNotExpressible';
    default: return 'agentFailed';
  }
}

/**
 * The kinds, and what each one is for. Adding a kind is adding something the scorer may count, so
 * the list is deliberately closed and deliberately small.
 */
export type TranscriptEventKind =
  /** The attempt began. Carries the workspace digest it started from. */
  | 'attemptStarted'
  /** The attempt ended, for any reason, including a deadline. */
  | 'attemptFinished'
  /** Prose from the agent along the way: its plan, its narration, its explanation. */
  | 'message'
  /**
   * THE AGENT'S ANSWER OF RECORD, distinguished from the narration around it.
   *
   * Added by the transcript audit. `finalMessage` existed on the driver's RESULT and never reached
   * the transcript at all, so anyone reading the events had to take the last `message` and hope. A
   * tool that narrates after it answers, or answers and then apologises, makes that guess wrong —
   * and "the last one" is not a fact the transcript was asserting. This is `agentReported`: it is
   * the tool's closing claim, and it is recorded, never scored.
   */
  | 'finalResponse'
  /** The agent asked for a tool. Name and a digest of the arguments; never the arguments verbatim. */
  | 'toolCall'
  /** What the tool returned, as the agent saw it. */
  | 'toolResult'
  /** A file was read. Reported by the agent, or observed when the engine served the read. */
  | 'fileRead'
  /** A file was created, changed or deleted. Digests on both sides when the engine observed it. */
  | 'fileWrite'
  /** A command ran. `engineObserved` ones carry a real exit status. */
  | 'commandExecuted'
  /** A verification command ran. Always `engineObserved`: the engine runs these itself. */
  | 'verificationRan'
  /**
   * A FRESH WORKSPACE WAS MADE FOR ANOTHER GO, carrying why the previous one ended.
   *
   * Emitted only for attempt 2 and after, which is what distinguishes an initial attempt from a
   * retry without anybody comparing `attemptIndex` to zero and calling that a boundary. It carries
   * the prior attempt's termination reason and its patch digest, so the retry's transcript can be
   * read on its own and still say what it was recovering from.
   */
  | 'retryStarted'
  /** Something went wrong that is not the model's answer: a spawn failure, a deadline, a cancellation. */
  | 'harnessFault'
  /** The agent tried to leave the workspace, or named a path outside it. Never ignored. */
  | 'boundaryRefusal';

export interface TranscriptEvent extends Record<string, CanonicalValue | undefined> {
  seq: number;
  /** Milliseconds since the attempt started, on this process's clock. Integer, never a timestamp. */
  atMilliseconds: number;
  kind: TranscriptEventKind;
  provenance: EventProvenance;
  attemptIndex: number;
  /** Free-form, redacted, and bounded. The one human-readable field. */
  detail: string;

  // The typed payload. Every field is optional because an event kind uses a handful of them; a
  // single flat shape is what keeps the whole list canonically encodable without a discriminated
  // union the canonical encoder would have to understand.
  toolName?: string;
  callID?: string;
  argumentsDigest?: string;
  ok?: boolean;
  path?: string;
  beforeSHA256?: string;
  afterSHA256?: string;
  byteCount?: number;
  executable?: string;
  argv?: string[];
  exitCode?: number | null;
  signal?: string;
  elapsedMilliseconds?: number;
  stdoutDigest?: string;
  stderrDigest?: string;
  stdoutByteCount?: number;
  stderrByteCount?: number;
  /**
   * The tail of each stream, bounded and redacted, KEPT APART.
   *
   * Digests and byte counts alone are enough to prove two runs produced the same output and useless
   * for reading why one failed. The engine's own commands keep their full tails on `CommandOutcome`;
   * a command the AGENT ran has no `CommandOutcome`, so without these its output would exist only as
   * a hash. They are separate fields rather than one merged log because a test runner that writes
   * results to stdout and warnings to stderr is not saying the same thing on both.
   */
  stdoutTail?: string;
  stderrTail?: string;
  commandID?: string;
  commandKind?: string;
  channel?: 'visible' | 'thinking';
  textDigest?: string;
  textByteCount?: number;
  reason?: string;
  workspaceTreeDigest?: string;
  /** Set on `attemptFinished`, on `harnessFault`, and on `retryStarted` (the PREVIOUS ending). */
  terminationReason?: TerminationReason;
  /** On `retryStarted`: which attempt this one is recovering from. */
  priorAttemptIndex?: number;
  patchDigest?: string;
}

/**
 * Kinds ONLY THIS ENGINE MAY EMIT, whatever a driver asks for.
 *
 * The provenance field is the load-bearing distinction in this whole model, and it is only worth
 * anything if it cannot be claimed. A driver that emitted `verificationRan` as `agentReported`
 * would be a tool asserting its own test result into the record the scorer reads before deciding a
 * regression; a driver that emitted `attemptFinished` could close an attempt that had not ended.
 * Drivers are Cernum's code rather than the model's, so this is not a hostility assumption — it is
 * the same reason `guards.ts` lives outside the loop it protects: a guard that the thing it guards
 * can opt out of is not a guard.
 *
 * `boundaryRefusal` is here because a refusal is always something the ENGINE did — it resolved a
 * path and said no. A tool reporting that it was refused is narration, and belongs in `message`.
 */
export const ENGINE_ONLY_EVENT_KINDS: TranscriptEventKind[] = [
  'attemptStarted', 'attemptFinished', 'retryStarted', 'verificationRan', 'harnessFault', 'boundaryRefusal',
];

/** Detail strings are bounded so one runaway stack trace cannot dominate an evidence file. */
export const MAXIMUM_DETAIL_CHARACTERS = 2_000;

export function boundedDetail(text: string): string {
  const redacted = redactSecrets(text);
  if (redacted.length <= MAXIMUM_DETAIL_CHARACTERS) return redacted;
  return `${redacted.slice(0, MAXIMUM_DETAIL_CHARACTERS)}… [${redacted.length - MAXIMUM_DETAIL_CHARACTERS} more characters omitted]`;
}

export interface TranscriptSummary {
  eventCount: number;
  /** Counted separately, because only the observed ones are evidence. */
  observedEventCount: number;
  reportedEventCount: number;
  messageCount: number;
  toolCallCount: number;
  /** Distinct tool names, sorted. What the model actually reached for. */
  toolsUsed: string[];
  fileReadCount: number;
  fileWriteCount: number;
  commandCount: number;
  failedCommandCount: number;
  /** Commands the engine ran itself and watched exit. The denominator a reliability rate needs. */
  observedCommandCount: number;
  verificationRunCount: number;
  /**
   * `1` when this transcript belongs to a retry, `0` when it belongs to an initial attempt.
   *
   * A transcript covers ONE attempt — the builder is made fresh for each, because an attempt that
   * dies mid-way must still leave everything up to the moment it died. So this is a boundary marker
   * rather than a tally across a run; the run's retry count is `WorkspaceRunResult.attemptsUsed - 1`.
   */
  retryCount: number;
  /** `1` when the agent gave a closing answer, `0` when it stopped without one. */
  finalResponseCount: number;
  boundaryRefusalCount: number;
  harnessFaultCount: number;
  /** Why this attempt stopped, lifted off `attemptFinished`. Absent while an attempt is in flight. */
  terminationReason?: TerminationReason;
  /**
   * Every executable named by a `commandExecuted` event, whoever reported it, sorted.
   *
   * DELIBERATELY NOT RESTRICTED TO OBSERVED EVENTS, and the first version of this was, which made
   * the case's executable allow-list check the ENGINE'S OWN verification commands and nothing else
   * — precisely backwards. A model's shell command runs inside the tool's process; this engine
   * cannot watch it exit, so the only account of it there will ever be is the tool's own stream.
   * Policing what was named therefore has to read testimony.
   *
   * What follows from that is stated rather than papered over: a tool that does not report its
   * commands cannot be checked this way at all. That is why the allow-list is a detection and the
   * VERDICT rests on the final tree — the same posture `CODEX_TOOL_SURFACE_IS_NOT_CLOSED` takes.
   * `observedCommandCount` stays beside it so a reader can always tell how much of this was watched.
   */
  executablesInvoked: string[];
  lastEventAtMilliseconds: number;
}

export interface WorkspaceTranscript {
  events: TranscriptEvent[];
  summary: TranscriptSummary;
  /** SHA-256 over the canonical encoding of `events`. The identity of this attempt's behaviour. */
  transcriptDigest: string;
}

/**
 * Collects events during an attempt.
 *
 * `emit` is handed to the driver, so a driver streams what it sees as it sees it rather than
 * assembling a list at the end — an attempt that times out mid-way still leaves everything up to
 * the deadline, which is exactly the attempt whose transcript matters most.
 */
export class TranscriptBuilder {
  private readonly events: TranscriptEvent[] = [];

  private sequence = 0;

  constructor(private readonly startedAtMilliseconds: number, private readonly now: () => number = () => Date.now()) {}

  get count(): number {
    return this.events.length;
  }

  /**
   * Append one event. Never throws: an evidence collector that can fail is an evidence collector
   * that loses the tail of the attempt it was collecting.
   */
  emit(kind: TranscriptEventKind, provenance: EventProvenance, attemptIndex: number,
       detail: string, payload: Partial<TranscriptEvent> = {}): TranscriptEvent {
    // A driver claiming an engine-only kind does not get it. The forgery is DROPPED and recorded as
    // a harness fault rather than corrected into place: relabelling it `engineObserved` would make
    // the thing this rule exists to refuse into evidence, and silently discarding it would let a
    // driver defect look like a quiet run.
    if (provenance === 'agentReported' && ENGINE_ONLY_EVENT_KINDS.includes(kind)) {
      return this.emit('harnessFault', 'engineObserved', attemptIndex,
        `a driver reported a '${kind}' event, which only this engine may record. It was discarded: `
        + 'a tool asserting its own verification result is the one thing the provenance split exists to refuse.',
        { reason: 'forgedEngineEvent', toolName: kind });
    }
    const event: TranscriptEvent = redactValue({
      ...payload,
      seq: this.sequence++,
      atMilliseconds: Math.max(0, Math.round(this.now() - this.startedAtMilliseconds)),
      kind,
      provenance,
      attemptIndex,
      detail: boundedDetail(detail),
    });
    this.events.push(event);
    return event;
  }

  /** The finished transcript. Safe to call more than once; the builder keeps collecting afterwards. */
  build(): WorkspaceTranscript {
    const events = [...this.events];
    return { events, summary: summariseTranscript(events), transcriptDigest: digestObject(events as unknown as CanonicalValue) };
  }
}

const sortedUnique = (values: string[]): string[] => [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

export function summariseTranscript(events: TranscriptEvent[]): TranscriptSummary {
  const observed = events.filter((event) => event.provenance === 'engineObserved');
  const commands = events.filter((event) => event.kind === 'commandExecuted');
  const observedCommands = commands.filter((event) => event.provenance === 'engineObserved');
  return {
    eventCount: events.length,
    observedEventCount: observed.length,
    reportedEventCount: events.length - observed.length,
    messageCount: events.filter((event) => event.kind === 'message').length,
    toolCallCount: events.filter((event) => event.kind === 'toolCall').length,
    toolsUsed: sortedUnique(events.filter((event) => event.kind === 'toolCall' && typeof event.toolName === 'string').map((event) => event.toolName!)),
    fileReadCount: events.filter((event) => event.kind === 'fileRead').length,
    fileWriteCount: events.filter((event) => event.kind === 'fileWrite').length,
    commandCount: commands.length,
    // A command with no recorded exit status is not counted as failed: unknown is not failure.
    failedCommandCount: commands.filter((event) => typeof event.exitCode === 'number' && event.exitCode !== 0).length,
    observedCommandCount: observedCommands.length,
    verificationRunCount: events.filter((event) => event.kind === 'verificationRan').length,
    retryCount: events.filter((event) => event.kind === 'retryStarted').length,
    finalResponseCount: events.filter((event) => event.kind === 'finalResponse').length,
    // Read off the ending event rather than derived: `attemptFinished` is the one place an attempt
    // records why it stopped, and a summary that recomputed it could disagree with the transcript.
    terminationReason: [...events].reverse().find((event) => event.kind === 'attemptFinished')?.terminationReason
      ?? [...events].reverse().find((event) => event.kind === 'harnessFault')?.terminationReason,
    boundaryRefusalCount: events.filter((event) => event.kind === 'boundaryRefusal').length,
    harnessFaultCount: events.filter((event) => event.kind === 'harnessFault').length,
    executablesInvoked: sortedUnique(commands.filter((event) => typeof event.executable === 'string').map((event) => event.executable!)),
    lastEventAtMilliseconds: events.length === 0 ? 0 : events[events.length - 1].atMilliseconds,
  };
}

/**
 * Executables that were invoked and are not on the case's allow-list.
 *
 * Checked against the OBSERVED events only. A list derived from what the agent reported would be a
 * list a tool could shorten by not reporting, which is the opposite of what an allow-list is for.
 * Empty `allowedExecutables` returns nothing: the case declared no list, so there is nothing to breach.
 */
export function executablesOutsidePolicy(summary: TranscriptSummary, allowedExecutables: string[]): string[] {
  if (allowedExecutables.length === 0) return [];
  const allowed = new Set(allowedExecutables);
  return summary.executablesInvoked.filter((executable) => !allowed.has(executable));
}

/** The one-line summary a terminal prints beside a workspace row. */
export function describeTranscript(summary: TranscriptSummary): string {
  const parts = [
    `${summary.eventCount} events (${summary.observedEventCount} observed)`,
    `${summary.toolCallCount} tool calls`,
    `${summary.fileWriteCount} writes`,
    `${summary.commandCount} commands`,
  ];
  if (summary.retryCount > 0) parts.push('retry');
  if (summary.boundaryRefusalCount > 0) parts.push(`${summary.boundaryRefusalCount} boundary refusals`);
  if (summary.terminationReason !== undefined) parts.push(summary.terminationReason);
  return parts.join(' · ');
}
