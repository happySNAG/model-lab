// Benchmark engine · the EFFORT a Codex run actually got, measured from the CLI's own telemetry and
// kept apart from the effort that was asked for.
//
// WHY THIS EXISTS. A Codex matrix freezes `model_reasoning_effort="medium"` (or `"max"`) into every
// argv, and until this module nothing checked what the tool did with it. `codex exec --json` echoes no
// effort. The CLI's OpenTelemetry export does: codex-cli 0.155.0 writes the session's effort on its
// `codex.conversation_starts` LOG record as `reasoning_effort`, and each completed model request's
// effort on a `codex.sse_event` record as `model_reasoning_effort`. Both carry `conversation.id`, which
// is byte-identical to the `thread_id` the CLI prints on stdout. So a run's applied effort can be
// MEASURED, and a requested effort can be checked against it.
//
// TWO FIELDS, NEVER ONE. `requestedEffort` is what Cernum froze and sent. `appliedEffort` is what the
// tool's telemetry says it applied. The first is never copied into the second: a request that was
// accepted is not a request that was honoured, and an absent measurement stays absent.
//
// WHAT THIS MAY NEVER ESTABLISH. The telemetry's `model`/`slug` attributes are the identifier the
// CLIENT SENT. They are read here for exactly one purpose — to REFUSE an observation whose client-sent
// model is not the one this run requested, because such an observation cannot be this run's — and are
// never evidence of which model answered. A run with a verified applied effort is still
// `requestAcceptedIdentityUnverifiable`.

import { CanonicalValue } from './canonical';
import { OTLPTurnObservation } from './otlp-observer';
import { EffortLevel } from './provider';

/**
 * The applied-effort verdict for one attempt, one run, or one candidate.
 *
 * `appliedEffortNotRequested` is the fifth state and exists so a route frozen at `none` is not
 * described as unverified: nothing was asked for, so there is nothing to verify, and whatever the
 * telemetry reported is recorded as the catalogue default the tool chose.
 */
export type AppliedEffortVerdict =
  | 'appliedEffortVerified'
  | 'appliedEffortMismatch'
  | 'appliedEffortUnavailable'
  | 'appliedEffortAmbiguous'
  | 'appliedEffortNotRequested';

/**
 * How an attempt's telemetry was — or was not — tied to the attempt.
 *
 * Every state is a fact about the join, not about the model. `noTelemetryForConversation` is the
 * ordinary "nothing arrived in time"; `attributionRefused` is "something arrived that could not be
 * shown to be exclusively this attempt's", and it is never resolved by picking the nearest record.
 */
export type TelemetryCorrelationState =
  | 'correlatedByConversationID'
  | 'noTelemetryForConversation'
  | 'noConversationID'
  | 'noRequestSent'
  | 'noCollector'
  | 'attributionRefused'
  | 'observerFailed';

/** Where each applied-effort figure is read from, named so a row says which record it came from. */
export const APPLIED_EFFORT_SOURCES = {
  conversationStart: 'otlp:codex.conversation_starts.reasoning_effort',
  turnSpan: 'otlp:codex.turn.reasoning_effort',
  requestEvent: 'otlp:codex.sse_event.model_reasoning_effort',
  requestSpan: 'otlp:codex.request.reasoning_effort',
} as const;

export const TELEMETRY_CORRELATION_BOUNDARY =
  'A run\'s telemetry is the set of OTLP records carrying the conversation id that THIS run\'s own `codex exec` printed '
  + 'as `thread_id`. Nothing else is attributed to it. Time is never used to attribute a record — only to bound how long '
  + 'an attempt waits — so a record without a conversation id (startup spans, model-manager traces) joins no run, a '
  + 'conversation id claimed by two attempts is attributed to neither, and an observation whose client-sent model is not '
  + 'the one this run requested is refused. There is no "nearest event" fallback: an attempt that cannot be joined '
  + 'exactly is recorded as unavailable or ambiguous.';

export const APPLIED_EFFORT_IS_MEASURED_NOT_REQUESTED =
  'requestedEffort is what Cernum froze and sent (`-c model_reasoning_effort`). appliedEffort is what the codex CLI\'s '
  + 'own OTLP telemetry says it applied, read from the records carrying this run\'s conversation id. The request is never '
  + 'copied into the measurement: an accepted request is not proof of an applied effort, and a missing measurement is '
  + 'recorded as unavailable rather than assumed.';

export const EFFORT_VALIDITY_IS_NOT_QUALITY =
  'Applied-effort validity and task quality are separate. Every run keeps its workspace evidence, its status and its '
  + 'score exactly as verification produced them. A run whose telemetry shows a DIFFERENT effort is not evidence for the '
  + 'requested route, and one whose applied effort could not be measured is not proof of it: in either case the candidate '
  + 'is NOT qualified at the requested effort. The quality figures are published beside that verdict, never adjusted by it.';

/** One attempt's applied-effort evidence. Written onto the attempt record, and folded into the run's row. */
export interface AttemptAppliedEffortEvidence extends Record<string, CanonicalValue | undefined> {
  requestedEffort: string;
  /** The applied effort, ONLY when the telemetry carried exactly one value for this attempt. */
  appliedEffort?: string;
  /** Every distinct effort any attributed record carried, sorted. Two or more means the attempt was mixed. */
  observedEfforts: string[];
  /** Which telemetry fields those efforts were read from. See `APPLIED_EFFORT_SOURCES`. */
  appliedEffortSources: string[];
  verdict: AppliedEffortVerdict;
  correlation: TelemetryCorrelationState;
  /** The redacted placeholder joining this attempt to the collector's evidence file. Not an identifier. */
  correlationKey?: string;
  /** How many records carrying this attempt's conversation id had arrived when the verdict was reached. */
  telemetryRecordCount: number;
  /** `auth_mode` on the conversation-start record — `Chatgpt` on a subscription session. Billing evidence. */
  telemetryAuthMode?: string;
  /** `auth.env_openai_api_key_present`, as the tool itself reported it. False is what the envelope requires. */
  telemetryAPIKeyEnvironmentPresent?: boolean;
  /** The model identifiers the CLIENT SENT, distinct. Used to refuse a foreign observation; never identity. */
  telemetryClientSentModels?: string[];
  /** Per-request token figures, verbatim from the telemetry. Preserved, never reinterpreted or summed here. */
  telemetryRequestUsage?: CanonicalValue;
  detail: string;
}

const normalise = (effort: string): string => effort.trim().toLowerCase();

const distinct = (values: (string | undefined)[]): string[] =>
  [...new Set(values.filter((value): value is string => value !== undefined && value.length > 0).map(normalise))].sort();

/**
 * The verdict for ONE attempt, from what that attempt's own conversation reported.
 *
 * The order of the checks is the argument. First: was a request sent at all, was anything listening,
 * did the collector survive, and is there an exact key to join on? Then: can what arrived be
 * attributed to this attempt EXCLUSIVELY? Only then is the effort compared — so a comparison is never
 * made against telemetry that might belong to somebody else.
 */
export function attemptAppliedEffortEvidence(input: {
  requestedEffort: EffortLevel | undefined;
  requestedModelID: string;
  collectorAttached: boolean;
  /** False when the attempt was refused before the CLI was started. */
  requestSent: boolean;
  threadID?: string;
  observation?: OTLPTurnObservation;
  /** Why no request was sent, when none was. */
  refusal?: string;
}): AttemptAppliedEffortEvidence {
  const requestedEffort = normalise(input.requestedEffort ?? 'none');
  const observation = input.observation;
  const base = {
    requestedEffort,
    observedEfforts: [] as string[],
    appliedEffortSources: [] as string[],
    correlationKey: observation?.correlationKey === undefined || observation.correlationKey.length === 0
      ? undefined : observation.correlationKey,
    telemetryRecordCount: observation?.recordCount ?? 0,
    telemetryAuthMode: observation?.authMode,
    telemetryAPIKeyEnvironmentPresent: observation?.apiKeyEnvironmentPresent,
    telemetryClientSentModels: observation?.clientSentModels === undefined ? undefined : [...observation.clientSentModels],
    telemetryRequestUsage: observation?.requestUsage === undefined
      ? undefined : observation.requestUsage.map((entry) => ({ ...entry })) as unknown as CanonicalValue,
  };
  const unavailable = (correlation: TelemetryCorrelationState, detail: string): AttemptAppliedEffortEvidence =>
    ({ ...base, verdict: 'appliedEffortUnavailable', correlation, detail });

  if (!input.requestSent) {
    return unavailable('noRequestSent', `no request was sent${input.refusal === undefined ? '' : ` (${input.refusal})`}, `
      + 'so no effort was applied to anything and there is nothing to measure. This is not an effort finding.');
  }
  if (!input.collectorAttached) {
    return unavailable('noCollector', 'no OTLP collector was attached to this attempt, so what the tool applied was not '
      + `observed. requested ${requestedEffort} is recorded as requested, never as applied.`);
  }
  if (observation?.observerFailure !== undefined) {
    return unavailable('observerFailed', `the telemetry collector failed (${observation.observerFailure}), so this `
      + 'attempt\'s applied effort was not measured. A MEASUREMENT failure, not a provider or model failure.');
  }
  if (input.threadID === undefined || input.threadID.length === 0) {
    return unavailable('noConversationID', 'the CLI\'s stream reported no `thread_id`, so there is no exact key to join '
      + 'telemetry on. No record is attached by time or by proximity; the applied effort is unavailable.');
  }
  if (observation === undefined || observation.recordCount === 0) {
    return unavailable('noTelemetryForConversation', 'no telemetry record carrying this attempt\'s conversation id had '
      + 'arrived when the attempt closed. The correlation key is kept so late records can be REPORTED; a late record '
      + 'never upgrades this sealed verdict.');
  }
  if (observation.attributionRefused !== undefined) {
    return { ...base, verdict: 'appliedEffortAmbiguous', correlation: 'attributionRefused',
      detail: `telemetry arrived that cannot be attributed to this attempt alone: ${observation.attributionRefused}` };
  }
  const foreign = (observation.clientSentModels ?? []).filter((model) => model !== input.requestedModelID);
  if (foreign.length > 0) {
    return { ...base, verdict: 'appliedEffortAmbiguous', correlation: 'attributionRefused',
      detail: `records carrying this attempt's conversation id name client-sent model(s) ${foreign.join(', ')}, and this `
        + `attempt requested ${input.requestedModelID}. An observation that does not describe this request is refused `
        + 'rather than attributed.' };
  }
  if (observation.effortAmbiguous === true) {
    return { ...base, verdict: 'appliedEffortAmbiguous', correlation: 'correlatedByConversationID',
      detail: 'this conversation\'s start records reported two DIFFERENT efforts, so which one applied cannot be said. '
        + 'Neither is taken.' };
  }

  const sources: string[] = [];
  if (observation.turnReasoningEffort !== undefined) {
    sources.push(observation.turnReasoningEffortSource ?? APPLIED_EFFORT_SOURCES.conversationStart);
  }
  if ((observation.requestReasoningEfforts ?? []).length > 0) sources.push(APPLIED_EFFORT_SOURCES.requestEvent);
  const observedEfforts = distinct([observation.turnReasoningEffort, ...(observation.requestReasoningEfforts ?? [])]);
  const measured = { ...base, observedEfforts, appliedEffortSources: [...new Set(sources)].sort() };

  if (observedEfforts.length === 0) {
    return { ...measured, verdict: 'appliedEffortUnavailable', correlation: 'correlatedByConversationID',
      detail: `${observation.recordCount} record(s) carrying this attempt's conversation id arrived and none of them `
        + 'carried an effort, so the applied effort is unavailable.' };
  }
  const appliedEffort = observedEfforts.length === 1 ? observedEfforts[0] : undefined;
  if (requestedEffort === 'none') {
    return { ...measured, appliedEffort, verdict: 'appliedEffortNotRequested', correlation: 'correlatedByConversationID',
      detail: `no effort was requested; the tool reports ${observedEfforts.join(', ')}, which is its own default and is `
        + 'recorded as such.' };
  }
  if (observedEfforts.every((effort) => effort === requestedEffort)) {
    return { ...measured, appliedEffort, verdict: 'appliedEffortVerified', correlation: 'correlatedByConversationID',
      detail: `requested ${requestedEffort}; the tool's own telemetry for this conversation reports ${requestedEffort} `
        + `(${measured.appliedEffortSources.join(', ')}).` };
  }
  return { ...measured, appliedEffort, verdict: 'appliedEffortMismatch', correlation: 'correlatedByConversationID',
    detail: `requested ${requestedEffort}; the tool's own telemetry for this conversation reports `
      + `${observedEfforts.join(' and ')} (${measured.appliedEffortSources.join(', ')}). This attempt did not run at the `
      + 'requested effort and is not evidence for that route.' };
}

// MARK: - One run

/** A run's applied-effort evidence: every attempt's, and one verdict over them. */
export interface RunAppliedEffortEvidence {
  requestedEffort: string;
  /** Present only when every attempt that sent a request reported the same single effort. */
  appliedEffort?: string;
  verdict: AppliedEffortVerdict;
  /** The join state of the attempt that decided the verdict. */
  correlation: TelemetryCorrelationState;
  appliedEffortSources: string[];
  detail: string;
  attempts: (AttemptAppliedEffortEvidence & { attemptIndex: number })[];
  /** True exactly when the verdict is `appliedEffortVerified`. The route-validity bit; never a quality bit. */
  qualifiesRequestedRoute: boolean;
}

/** Worst first. A run is only as verified as its least-verified attempt that actually sent a request. */
const VERDICT_SEVERITY: AppliedEffortVerdict[] = [
  'appliedEffortMismatch', 'appliedEffortAmbiguous', 'appliedEffortUnavailable', 'appliedEffortNotRequested',
  'appliedEffortVerified',
];

/**
 * Fold a run's attempts into one verdict.
 *
 * UNDEFINED WHEN NO ATTEMPT CARRIES EVIDENCE — every Claude run, and every Codex run from a scripted
 * driver — so a row that never had an applied-effort question is written exactly as it was before
 * this existed. Attempts refused before sending anything are kept in the list and left out of the
 * verdict, unless nothing was sent at all.
 */
export function runAppliedEffortEvidence(attempts: (AttemptAppliedEffortEvidence | undefined)[]):
  RunAppliedEffortEvidence | undefined {
  const indexed = attempts
    .map((evidence, attemptIndex) => (evidence === undefined ? undefined : { ...evidence, attemptIndex }))
    .filter((entry): entry is AttemptAppliedEffortEvidence & { attemptIndex: number } => entry !== undefined);
  if (indexed.length === 0) return undefined;
  const sent = indexed.filter((entry) => entry.correlation !== 'noRequestSent');
  const deciding = (sent.length === 0 ? indexed : sent).reduce((worst, entry) =>
    (VERDICT_SEVERITY.indexOf(entry.verdict) < VERDICT_SEVERITY.indexOf(worst.verdict) ? entry : worst));
  const applied = distinct(sent.map((entry) => entry.appliedEffort));
  const appliedEffort = applied.length === 1 && sent.every((entry) => entry.appliedEffort !== undefined)
    ? applied[0] : undefined;
  const attemptsWord = indexed.length === 1 ? 'the run\'s one attempt' : `attempt ${deciding.attemptIndex + 1} of ${indexed.length}`;
  return {
    requestedEffort: indexed[0].requestedEffort,
    appliedEffort,
    verdict: deciding.verdict,
    correlation: deciding.correlation,
    appliedEffortSources: [...new Set(sent.flatMap((entry) => entry.appliedEffortSources))].sort(),
    detail: indexed.length === 1 ? deciding.detail : `decided by ${attemptsWord}: ${deciding.detail}`,
    attempts: indexed,
    qualifiesRequestedRoute: deciding.verdict === 'appliedEffortVerified',
  };
}

/**
 * The fields a ledger row and a durable record carry for a run's applied effort, or none.
 *
 * EMPTY WHEN THERE IS NO EVIDENCE, so a Claude row — and every row written before this existed —
 * is byte-identical to what it would have been.
 */
export function appliedEffortRowFields(evidence: RunAppliedEffortEvidence | undefined,
                                       capture?: WorkspaceTelemetryCapture): Record<string, CanonicalValue | undefined> {
  if (evidence === undefined) return {};
  return {
    requestedEffort: evidence.requestedEffort,
    appliedEffort: evidence.appliedEffort,
    appliedEffortVerdict: evidence.verdict,
    appliedEffortEvidenceSource: evidence.appliedEffortSources.join(', ') || 'none — no attributed record carried an effort',
    appliedEffortDetail: evidence.detail,
    telemetryCorrelation: evidence.correlation,
    appliedEffortQualifiesRequestedRoute: evidence.qualifiesRequestedRoute,
    appliedEffortAttempts: evidence.attempts as unknown as CanonicalValue,
    telemetryCapture: capture as unknown as CanonicalValue,
  };
}

/** How a run's telemetry was captured. Written onto the row so a reader can find the evidence file. */
export interface WorkspaceTelemetryCapture extends Record<string, CanonicalValue | undefined> {
  collector: string;
  /** The redacted evidence file every attributed record was written to. */
  evidenceFile?: string;
  /** How long an attempt waited for its telemetry after the CLI exited. A bound, never an attribution rule. */
  observeWaitMilliseconds?: number;
  correlationBoundary: string;
}

// MARK: - Per candidate

export interface AppliedEffortRunReference {
  candidate: string;
  caseID: string;
  repeatIndex?: number;
  recordRoot: string;
  verdict: string;
  appliedEffort?: string;
  status: string;
  compositeMilli?: number;
  detail: string;
}

/** Telemetry that arrived after a run was sealed, or a collision found after it. Reported; can only DOWNGRADE. */
export interface LateAppliedEffortEvidence {
  recordRoot: string;
  attemptIndex: number;
  sealedVerdict: string;
  lateVerdict: AppliedEffortVerdict;
  lateAppliedEffort?: string;
  detail: string;
}

export interface CandidateAppliedEffortProvenance {
  candidate: string;
  requestedModelID: string;
  requestedEffort: string;
  /** Executed runs that carry applied-effort evidence. */
  runCount: number;
  verifiedRunCount: number;
  mismatchRunCount: number;
  unavailableRunCount: number;
  ambiguousRunCount: number;
  notRequestedRunCount: number;
  /** Runs by the effort they were measured at. `unmeasured` and `mixed` are named, never folded into a level. */
  appliedEffortDistribution: Record<string, number>;
  /** Runs that are NOT evidence for the requested route, with their scores kept for the reader. */
  mismatchedRuns: AppliedEffortRunReference[];
  unverifiedRuns: AppliedEffortRunReference[];
  lateEvidence: LateAppliedEffortEvidence[];
  /** True only when every executed run verified the requested effort and nothing late contradicts one. */
  qualifiedForRequestedEffort: boolean;
  qualificationReason: string;
}

export interface WorkspaceAppliedEffortProvenance {
  candidates: CandidateAppliedEffortProvenance[];
  correlationBoundary: string;
  disclosure: string;
}

const rowText = (row: Record<string, unknown>, key: string): string | undefined =>
  (typeof row[key] === 'string' ? row[key] as string : undefined);

/**
 * Per candidate, what the matrix measured about applied effort.
 *
 * READS ONLY ROWS THAT CARRY A VERDICT. A candidate none of whose rows asked the question is omitted
 * rather than reported as unverified, so a Claude matrix produces an empty list. Late evidence can
 * turn a qualified candidate into an unqualified one and can never do the reverse: a sealed
 * `unavailable` stays unavailable however conclusive a record that arrived afterwards looks.
 */
export function workspaceAppliedEffortProvenance(runs: { recordRoot: string; row: Record<string, unknown> }[],
                                                 late: LateAppliedEffortEvidence[] = []): WorkspaceAppliedEffortProvenance {
  const byCandidate = new Map<string, { recordRoot: string; row: Record<string, unknown> }[]>();
  for (const run of runs) {
    if (rowText(run.row, 'appliedEffortVerdict') === undefined) continue;
    const candidate = rowText(run.row, 'candidate') ?? '';
    byCandidate.set(candidate, [...(byCandidate.get(candidate) ?? []), run]);
  }
  const candidates = [...byCandidate.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([candidate, members]) => {
    const verdictOf = (row: Record<string, unknown>) => rowText(row, 'appliedEffortVerdict') as AppliedEffortVerdict;
    const count = (verdict: AppliedEffortVerdict) => members.filter(({ row }) => verdictOf(row) === verdict).length;
    const distribution: Record<string, number> = {};
    for (const { row } of members) {
      const attempts = Array.isArray(row.appliedEffortAttempts) ? row.appliedEffortAttempts as Record<string, unknown>[] : [];
      const mixed = attempts.some((attempt) => Array.isArray(attempt.observedEfforts) && attempt.observedEfforts.length > 1);
      const key = rowText(row, 'appliedEffort') ?? (mixed ? 'mixed' : 'unmeasured');
      distribution[key] = (distribution[key] ?? 0) + 1;
    }
    const reference = ({ recordRoot, row }: { recordRoot: string; row: Record<string, unknown> }): AppliedEffortRunReference => ({
      candidate,
      caseID: rowText(row, 'caseID') ?? '',
      repeatIndex: typeof row.repeatIndex === 'number' ? row.repeatIndex : undefined,
      recordRoot,
      verdict: verdictOf(row),
      appliedEffort: rowText(row, 'appliedEffort'),
      status: String(row.status),
      compositeMilli: typeof row.compositeMilli === 'number' ? row.compositeMilli : undefined,
      detail: rowText(row, 'appliedEffortDetail') ?? '',
    });
    const roots = new Set(members.map((member) => member.recordRoot));
    const lateHere = late.filter((entry) => roots.has(entry.recordRoot));
    const lateDowngrades = lateHere.filter((entry) =>
      entry.lateVerdict === 'appliedEffortMismatch' || entry.lateVerdict === 'appliedEffortAmbiguous');
    const verified = count('appliedEffortVerified');
    const requestedEffort = rowText(members[0].row, 'requestedEffort') ?? '';
    const qualified = members.length > 0 && verified === members.length && lateDowngrades.length === 0;
    return {
      candidate,
      requestedModelID: rowText(members[0].row, 'requestedModelID') ?? '',
      requestedEffort,
      runCount: members.length,
      verifiedRunCount: verified,
      mismatchRunCount: count('appliedEffortMismatch'),
      unavailableRunCount: count('appliedEffortUnavailable'),
      ambiguousRunCount: count('appliedEffortAmbiguous'),
      notRequestedRunCount: count('appliedEffortNotRequested'),
      appliedEffortDistribution: distribution,
      mismatchedRuns: members.filter(({ row }) => verdictOf(row) === 'appliedEffortMismatch').map(reference),
      unverifiedRuns: members.filter(({ row }) => verdictOf(row) !== 'appliedEffortVerified'
        && verdictOf(row) !== 'appliedEffortMismatch').map(reference),
      lateEvidence: lateHere,
      qualifiedForRequestedEffort: qualified,
      qualificationReason: qualified
        ? `every one of ${members.length} executed run(s) measured ${requestedEffort}, the requested effort`
        : lateDowngrades.length > 0
          ? `${lateDowngrades.length} record(s) arriving after sealing contradict a run's effort; NOT qualified at ${requestedEffort}`
          : `${members.length - verified} of ${members.length} executed run(s) did not verify ${requestedEffort} `
            + `(${count('appliedEffortMismatch')} mismatch, ${count('appliedEffortAmbiguous')} ambiguous, `
            + `${count('appliedEffortUnavailable')} unavailable); NOT qualified at ${requestedEffort}`,
    };
  });
  return { candidates, correlationBoundary: TELEMETRY_CORRELATION_BOUNDARY, disclosure: EFFORT_VALIDITY_IS_NOT_QUALITY };
}

/** The per-candidate block, as a person reads it after a matrix. */
export function describeWorkspaceAppliedEffortProvenance(provenance: WorkspaceAppliedEffortProvenance): string[] {
  const lines: string[] = [];
  for (const entry of provenance.candidates) {
    lines.push(`${entry.candidate.padEnd(30)} requested ${entry.requestedEffort.padEnd(7)} `
      + `verified ${entry.verifiedRunCount}/${entry.runCount} · mismatch ${entry.mismatchRunCount} · `
      + `ambiguous ${entry.ambiguousRunCount} · unavailable ${entry.unavailableRunCount} · applied `
      + `${Object.entries(entry.appliedEffortDistribution).map(([effort, runs]) => `${effort}×${runs}`).join(' ') || 'none'}`);
    lines.push(`${''.padEnd(30)} ${entry.qualifiedForRequestedEffort ? 'QUALIFIED' : 'NOT QUALIFIED'} — ${entry.qualificationReason}`);
    for (const run of entry.mismatchedRuns) {
      lines.push(`${''.padEnd(30)} mismatch  ${run.caseID} · repeat ${run.repeatIndex ?? '-'}: applied `
        + `${run.appliedEffort ?? 'mixed'} (status ${run.status}, kept as evidence, not scored for @${entry.requestedEffort})`);
    }
    for (const late of entry.lateEvidence) {
      lines.push(`${''.padEnd(30)} late      ${late.recordRoot} attempt ${late.attemptIndex + 1}: sealed ${late.sealedVerdict}, `
        + `late telemetry says ${late.lateVerdict}${late.lateAppliedEffort === undefined ? '' : ` (${late.lateAppliedEffort})`}`);
    }
  }
  return lines;
}
