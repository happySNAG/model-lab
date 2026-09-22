// Benchmark engine · WHAT THE ATTEMPT MEASURED, recorded apart from how well it scored.
//
// THE DEFECT THIS FIXES, in the exact shape Pass 8 found it. Four Codex `refuse-harm` attempts were
// stopped by the service's own content filter — "This content was flagged for possible cybersecurity
// risk" — and written to the ledger as `runtimeError`. The ranking's counting rule is "everything
// that is neither a pass, a partial, an awaited review nor inapplicable is a fail", so all four
// became fails, and three candidates carried a quality penalty for an answer the provider never let
// a model give. Four more attempts ran a tool despite the isolation flags and were written the same
// way, so an agent session's outcome sat in the same column as single-turn answers.
//
// Both are real outcomes and neither is a model-quality outcome. So they are recorded on a SECOND
// AXIS, beside the terminal status rather than inside it:
//
//   modelAnswered           a model produced the text that was scored. The only disposition whose
//                           rows belong in a capability rate.
//   providerRefusedContent  a provider- or service-layer content filter stopped the turn. An
//                           end-to-end availability and usability fact about the provider, reported
//                           as one — never a statement about what the model can do, because no
//                           model was reached.
//   interfaceContaminated   a tool ran. Whatever this measured, it was not one model answering one
//                           question, and it is not comparable with a turn that invoked none.
//
// PASS 11 FOUND THE SAME DEFECT AGAIN, in the same place, with a different sentence in it. Sixty-nine
// consecutive `gpt-6-astra@max` attempts were answered "You've hit your usage limit ... try again at
// Sep 21st, 2026 1:55 AM". That envelope carries no HTTP status either, so it too fell through every
// status branch to `transport`, was written `runtimeError`, and was counted as sixty-nine model
// failures. The candidate's published rate was 19.5% over a denominator of 87 when it had been
// measured on 18 attempts — and because its allowance ran out before it reached a single governance
// case, it was also the one candidate in its cohort left undisqualified, and so was published at
// RANK 1. One defect produced both a rate that was far too low and a rank that was far too high.
//
// So Pass 11 stops enumerating exceptions and states the rule instead: A CAPABILITY RATE CONTAINS
// ONLY ROWS ON WHICH A MODEL WAS ASKED A QUESTION AND ANSWERED IT. Everything else takes a named
// disposition of its own and leaves the rate:
//
//   providerCapacityExhausted  the account's allowance, rate limit or quota was spent.
//   providerUnauthenticated    the credential or session was not accepted.
//   providerRejectedRequest    the provider would not serve this request for this account at all.
//   transportFailed            the request did not complete: network, process, missing tool, cancel.
//   measurementFault           this engine could not establish that the attempt measured anything.
//
// And the classification reads THE PROVIDER'S SENTENCE BEFORE THE ADAPTER'S LABEL, because both
// defects this engine has shipped were adapters labelling correctly-worded failures `transport`.
//
// WHY NOT A NEW TERMINAL STATUS. `TERMINAL_STATUSES` is the proven harness's set, pinned byte for
// byte by `fixtures/parity/engine/ledger-plan-vectors.json` and asserted "neither widened nor
// narrowed". Widening it would have falsified a parity claim to gain a label, so these attempts take
// the truthful member of the existing set — `envelopeFailure`, the failure of the execution envelope
// rather than of an answer — and carry the precise name here. The guard stays intact and the
// outcome is still first-class: it has its own field, its own vocabulary, and its own reported rate.
//
// WHY THE STATUS IS NOT `runtimeError`. Because nothing in the runtime went wrong. The instruction
// that Cernum must never score a provider's refusal as a model's failure is the same one Pass 8
// honoured for throttling, and it is honoured here by making the row unscoreable rather than by
// hoping a reader notices a footnote.

/** The second axis. Absent on a row written before this pass, which is read as `modelAnswered`. */
export const ATTEMPT_DISPOSITIONS = [
  'modelAnswered',
  'providerRefusedContent',
  'interfaceContaminated',
  // Pass 11. Every one of these is a row on which NO MODEL WAS ASKED OR ANSWERED, and every one of
  // them was being counted as a model-quality failure until this pass.
  'providerCapacityExhausted',
  'providerUnauthenticated',
  'providerRejectedRequest',
  'transportFailed',
  'measurementFault',
] as const;
export type AttemptDisposition = (typeof ATTEMPT_DISPOSITIONS)[number];

export function isAttemptDisposition(value: unknown): value is AttemptDisposition {
  return typeof value === 'string' && (ATTEMPT_DISPOSITIONS as readonly string[]).includes(value);
}

/**
 * A row's disposition. A row with no `disposition` field predates this pass and answered normally —
 * defaulting the other way would retroactively excuse every failure ever recorded.
 */
export function dispositionOf(row: unknown): AttemptDisposition {
  const value = (row as { disposition?: unknown } | null | undefined)?.disposition;
  return isAttemptDisposition(value) ? value : 'modelAnswered';
}

/** True when this row's text is a model's answer and may therefore be scored. */
export function isScoreableDisposition(disposition: AttemptDisposition): boolean {
  return disposition === 'modelAnswered';
}

export const DISPOSITION_EXPLANATION: Record<AttemptDisposition, string> = {
  modelAnswered:
    'a model produced the text that was scored; this row counts in the capability rates',
  providerCapacityExhausted:
    'the account ran out of the capacity it was entitled to — the subscription allowance was spent, or '
    + 'the provider rate-limited or quota-limited this account — so the request was never put to a model. '
    + 'It is counted in the provider-capacity rate and EXCLUDED from every capability rate. How much of a '
    + 'plan is left is a fact about a billing relationship on a particular day; scoring it would put the '
    + 'state of somebody\'s subscription in the model\'s column.',
  providerUnauthenticated:
    'the provider did not accept the credential or session, so no model was reached. It is counted in the '
    + 'provider-reliability rates and EXCLUDED from every capability rate: a login is not a capability.',
  providerRejectedRequest:
    'the provider declined to serve this request at all — the model is not available to this account, or '
    + 'the request was rejected before any model saw it. It is counted in the provider-reliability rates '
    + 'and EXCLUDED from every capability rate. It is a fact about what this account may ask for, not '
    + 'about what the model can do.',
  transportFailed:
    'the request did not complete and no answer came back: a network or process fault, a tool that was '
    + 'not installed, or an attempt stopped before it finished. It is counted in the provider-reliability '
    + 'rates and EXCLUDED from every capability rate, because there is no answer here to score and a '
    + 'blank is not a wrong answer.',
  measurementFault:
    'this engine could not establish that the attempt measured what it claims to — the supplied context '
    + 'did not reach the request intact. It is EXCLUDED from every capability rate: reporting the '
    + 'harness\'s own fault as the model\'s failure is the single most misleading thing a benchmark can do.',
  providerRefusedContent:
    'a provider- or service-layer content filter stopped this turn, so no model answered it. It is an '
    + 'end-to-end provider availability and usability outcome, counted in the provider-reliability '
    + 'rates and EXCLUDED from every capability rate. It is not a model-quality failure: the model was '
    + 'never reached, and scoring the silence would put the provider\'s policy in the model\'s column.',
  interfaceContaminated:
    'this turn invoked at least one tool despite the isolation flags, so it measured an agent session '
    + 'rather than one model answering one question. It is counted in the interface-contamination rate '
    + 'and EXCLUDED from every capability rate. Cernum does not score it and does not claim the '
    + 'isolation envelope held.',
};

/** The terminal status these dispositions take. See the header for why it is not a new status. */
export const NON_ANSWER_TERMINAL_STATUS = 'envelopeFailure' as const;

// MARK: - Recognising a content refusal

/**
 * Markers of a provider/service content filter, as the providers actually word them.
 *
 * Deliberately narrow, and deliberately NOT a general "refused" test. A MODEL that declines to help
 * is the correct answer on a safety case and must keep scoring as one — `refuse-harm` exists to
 * reward exactly that. What is matched here is the SERVICE speaking over the model: a turn that
 * failed with a policy notice and produced no model text at all. Every marker below is a phrase a
 * provider emitted into this engine's own captured evidence, or its documented sibling.
 */
export const CONTENT_FILTER_MARKERS: string[] = [
  'flagged for possible cybersecurity risk',
  'this content was flagged',
  'flagged by our content filter',
  'content_filter',
  'content policy violation',
  'violates our usage policies',
  'response was blocked by the content filter',
  'prompt was blocked',
  'blocked by content management policy',
];

/**
 * True when this failure detail is a service content filter rather than a transport fault.
 *
 * Matched case-insensitively on the detail the adapter already redacted. The check is on the
 * MESSAGE because that is where every provider puts it: a content refusal arrives with no HTTP
 * status on the Codex path at all, which is precisely why Pass 8 classified it as `transport`.
 */
export function isContentFilterRefusal(detail: string): boolean {
  const haystack = detail.toLowerCase();
  return CONTENT_FILTER_MARKERS.some((marker) => haystack.includes(marker));
}

/**
 * Which marker fired, for the record. A classification whose evidence is not written down is a
 * classification nobody can check.
 */
export function contentFilterMarker(detail: string): string | undefined {
  const haystack = detail.toLowerCase();
  return CONTENT_FILTER_MARKERS.find((marker) => haystack.includes(marker));
}

// MARK: - Recognising an exhausted allowance, a rate limit, or a spent quota

/**
 * The plan itself is SPENT, until a date the provider names. Not a burst, not a queue.
 *
 * THE DEFECT THIS FIXES, in the exact shape Pass 11 found it. On 2026-09-21 the Codex service
 * answered sixty-nine consecutive `gpt-6-astra@max` attempts with:
 *
 *     "You've hit your usage limit. Upgrade to Pro ... or try again at Sep 21st, 2026 1:55 AM."
 *
 * It arrived inside a `turn.failed` envelope WITH NO HTTP STATUS, so every status-based branch in
 * the adapter fell through to `transport`; `transport` is not in `PROVIDER_THROTTLE_FAILURES`, so
 * the campaign did not abort; the rows were written terminal as `runtimeError`; and the ranking's
 * counting rule — "everything that is neither a pass, a partial, an awaited review nor inapplicable
 * is a fail" — turned all sixty-nine into model-quality failures. The candidate's published pass
 * rate was 19.5% over a denominator of 87, when what it had actually been measured on was 18
 * attempts. It was also, because the allowance ran out before it ever reached a governance case,
 * the only candidate in its cohort left undisqualified, and so it was published at RANK 1.
 *
 * DELIBERATELY ABOUT THE ACCOUNT RATHER THAN THE ANSWER. A model that mentions a limit inside a
 * normal answer has still answered and is still scored; what is matched here is the SERVICE
 * declining to carry the request, with no model text at all.
 *
 * KEPT APART FROM THE TRANSIENT MARKERS BELOW because exactly one decision turns on the difference,
 * and it is not the scoring decision — for scoring, both are the account and neither is the model.
 * It is RETRY. Waiting and asking again is the right response to a per-minute burst limit and the
 * wrong response to a monthly allowance that resets at 1:55 AM, which is why Pass 11's sixty-nine
 * exhausted-allowance rows each carry `retryCount: 2`: 207 requests sent, against an allowance that
 * had already run out, to be told the same sentence 207 times.
 */
export const PLAN_EXHAUSTION_MARKERS: string[] = [
  // The sentence Pass 11 was handed, and its documented siblings.
  'usage limit',
  'plan limit',
  'monthly limit',
  'out of credits',
  'purchase more credits',
  'quota exceeded',
  'insufficient_quota',
  'resource_exhausted',
  'resource exhausted',
];

/** Throttling that a wait might genuinely clear. Still not a model outcome; still worth one retry. */
export const TRANSIENT_THROTTLE_MARKERS: string[] = [
  'rate limit',
  'rate-limit',
  'ratelimit',
  'rate_limit',
  'too many requests',
  'quota',
];

/**
 * Everything that means "the account, not the model". A superset of the private regex the Claude
 * path used to carry, which is deleted in its favour: one list, shared by the adapter that labels
 * the failure and the classifier that decides what it means.
 */
export const ALLOWANCE_EXHAUSTION_MARKERS: string[] = [...PLAN_EXHAUSTION_MARKERS, ...TRANSIENT_THROTTLE_MARKERS];

/** True when this failure detail says the ACCOUNT ran out of capacity, not that a model answered badly. */
export function isAllowanceExhaustion(detail: string): boolean {
  const haystack = detail.toLowerCase();
  return ALLOWANCE_EXHAUSTION_MARKERS.some((marker) => haystack.includes(marker));
}

/** True when the allowance is spent rather than momentarily throttled — so a retry buys nothing. */
export function isPlanExhausted(detail: string): boolean {
  const haystack = detail.toLowerCase();
  return PLAN_EXHAUSTION_MARKERS.some((marker) => haystack.includes(marker));
}

/** Which marker fired. A classification whose evidence is not written down is one nobody can check. */
export function allowanceExhaustionMarker(detail: string): string | undefined {
  const haystack = detail.toLowerCase();
  return ALLOWANCE_EXHAUSTION_MARKERS.find((marker) => haystack.includes(marker));
}

/** This engine's own sentence for a turn that ran a tool. Matched, not re-derived, so one wording governs. */
export function isToolContamination(detail: string): boolean {
  return /this turn invoked \d+ tool\(s\)/.test(detail);
}

// MARK: - From a failure to a disposition, in ONE place

/**
 * What each adapter failure kind measured.
 *
 * THE RULE, stated once so it cannot be re-decided per caller: a capability rate may only contain
 * rows on which a model was asked a question and answered it. Everything below that is not
 * `modelAnswered` is a row with no model text on it, and a row with no model text is not a wrong
 * answer — it is an absent one.
 *
 * TWO KINDS DELIBERATELY STAY SCOREABLE, and both are judgement calls worth stating out loud:
 *
 *   timeout            genuinely ambiguous. A slow network and a model that cannot finish inside
 *                      its budget produce the same row, and one of those IS a capability outcome.
 *                      Pass 8 reasoned this way about throttling and left timeouts alone; Pass 11
 *                      does the same rather than quietly widening an excuse.
 *   malformedResponse  the tool ran to completion and emitted bytes; what failed was reading them.
 *                      That is a format outcome of this provider path, and turning it into "not
 *                      measured" would let an unparseable answerer vanish from the denominator.
 *
 * `modelMismatch` and `budgetRefused` never reach a terminal row at all — both abort the candidate
 * before anything is recorded — so their entries here exist only to keep the map total.
 */
export const FAILURE_KIND_DISPOSITIONS: Record<string, AttemptDisposition> = {
  rateLimited: 'providerCapacityExhausted',
  notAuthenticated: 'providerUnauthenticated',
  refused: 'providerRejectedRequest',
  transport: 'transportFailed',
  notInstalled: 'transportFailed',
  cancelled: 'transportFailed',
  contentFiltered: 'providerRefusedContent',
  toolContaminated: 'interfaceContaminated',
  timeout: 'modelAnswered',
  malformedResponse: 'modelAnswered',
  modelMismatch: 'modelAnswered',
  budgetRefused: 'modelAnswered',
};

/**
 * The disposition for one failure, from its kind AND the sentence the provider actually wrote.
 *
 * THE MESSAGE OUTRANKS THE KIND, and that ordering is the whole fix. Both defects this engine has
 * shipped — Pass 9's content filter and Pass 11's exhausted allowance — arrived with no HTTP status,
 * fell through every status branch in the adapter, and were labelled `transport` by a classifier
 * that had nothing else to go on. Reading the message first means a mislabelled kind can no longer
 * carry a non-answer into a capability rate, and it means this function gives the same answer for a
 * row being recorded live and for a row being re-read out of a sealed ledger months later.
 */
export function dispositionForFailure(kind: string, detail: string): AttemptDisposition {
  if (isAllowanceExhaustion(detail)) return 'providerCapacityExhausted';
  if (isContentFilterRefusal(detail)) return 'providerRefusedContent';
  if (isToolContamination(detail)) return 'interfaceContaminated';
  return FAILURE_KIND_DISPOSITIONS[kind] ?? 'modelAnswered';
}

/**
 * The failure kind recorded inside a ledger row's `detail`.
 *
 * Every failure row is written as `${provider}.${kind}: ${sentence}`, so the kind is recoverable
 * from the evidence file alone — which is what makes an offline re-derivation reproducible by
 * somebody who has the ledger and none of this engine's memory. Returns `''` for a detail that
 * carries no such prefix, which then classifies on the message alone.
 */
export function failureKindFromDetail(detail: string): string {
  const match = /^([A-Za-z][A-Za-z0-9]*)\.([A-Za-z][A-Za-z0-9]*):/.exec(detail);
  return match ? match[2] : '';
}

/** Terminal statuses that carry no scored answer, and are therefore open to re-reading. */
const NON_ANSWER_STATUSES = new Set(['runtimeError', 'envelopeFailure']);

/**
 * How a RECORDED ROW must be read, which is not always what it was written as.
 *
 * WHY A READER, AND NOT A LEDGER REWRITE. The ledger is the evidence and is never edited — Pass 9
 * settled that and Pass 11 keeps it. But a rate computed from evidence has to read the evidence
 * correctly, and sixty-nine rows in a sealed ledger say, in their own recorded `detail`, that a
 * subscription allowance ran out. Reading that sentence is reading, not rewriting; refusing to read
 * it would leave the published rate wrong for ever in the name of not touching anything.
 *
 * THE CORRECTION IS ONE-WAY AND NARROWLY GATED. Only a row that is already terminal-without-an-answer
 * (`runtimeError` or `envelopeFailure`) is re-read at all, and only when its stored disposition is
 * the default. A row that was scored `fail` is never reconsidered here, whatever its detail says —
 * so this can excuse nothing a model was actually judged on, and it can never invent a pass.
 */
export function effectiveDisposition(row: unknown): AttemptDisposition {
  const record = (row ?? {}) as { disposition?: unknown; status?: unknown; detail?: unknown };
  const stored = record.disposition;
  if (isAttemptDisposition(stored) && stored !== 'modelAnswered') return stored;
  if (typeof record.status !== 'string' || !NON_ANSWER_STATUSES.has(record.status)) return 'modelAnswered';
  const detail = typeof record.detail === 'string' ? record.detail : '';
  return dispositionForFailure(failureKindFromDetail(detail), detail);
}

// MARK: - Provider reliability, which is the reporting half

export interface ProviderReliability {
  candidate: string;
  attempts: number;
  /** Attempts on which a model answered and the row was therefore scoreable. */
  answered: number;
  /** Attempts that produced no model answer at all, whatever the reason. */
  notMeasured: number;
  /** Per thousand attempts, so it sits beside the pass rates in the same units. */
  notMeasuredRateMilli: number;
  /**
   * How much of this candidate's attempted work actually produced a measurement, per thousand.
   *
   * Published because a pass rate on its own cannot say how much of the plan it rests on. Pass 11's
   * defect ended with a candidate at rank 1 on eighteen of eighty-eight attempts, and no number on
   * that leaderboard said so.
   */
  measuredCoverageMilli: number;
  /** One count per disposition, so a new cause can never hide inside an old total. */
  byDisposition: Record<AttemptDisposition, number>;
  /** The cases lost to each disposition, named so the loss is visible and not merely counted. */
  casesByDisposition: Record<AttemptDisposition, string[]>;
  providerRefusedContentCount: number;
  interfaceContaminatedCount: number;
  providerCapacityExhaustedCount: number;
  providerUnauthenticatedCount: number;
  providerRejectedRequestCount: number;
  transportFailedCount: number;
  measurementFaultCount: number;
  providerRefusalRateMilli: number;
  interfaceContaminationRateMilli: number;
  providerCapacityExhaustionRateMilli: number;
  /** The cases that were refused or contaminated, named so the loss is visible and not just counted. */
  providerRefusedCases: string[];
  interfaceContaminatedCases: string[];
}

export const PROVIDER_RELIABILITY_MEANS =
  'These rates describe the PROVIDER, the ACCOUNT and the INTERFACE, never the model. A refusal rate is '
  + 'how often an end-to-end request could not be completed through this path at all; a capacity rate is '
  + 'how often the account had run out of the allowance it is entitled to; a contamination rate is how '
  + 'often the isolation envelope failed to hold. All are excluded from every capability rate, and none '
  + 'may be read as a quality figure or netted against one. Coverage is the share of attempts that '
  + 'produced a measurement at all: a high pass rate over low coverage is a small experiment, not a good '
  + 'model, and the two figures must be read together.';

function rateMilli(count: number, of: number): number {
  return of === 0 ? 0 : Math.round((count * 1000) / of);
}

function emptyCounts(): Record<AttemptDisposition, number> {
  return Object.fromEntries(ATTEMPT_DISPOSITIONS.map((disposition) => [disposition, 0])) as Record<AttemptDisposition, number>;
}

function emptyCases(): Record<AttemptDisposition, string[]> {
  return Object.fromEntries(ATTEMPT_DISPOSITIONS.map((disposition) => [disposition, [] as string[]])) as Record<AttemptDisposition, string[]>;
}

/** A reliability row for a candidate with no attempts, so every caller's fallback is the same shape. */
export function emptyReliability(candidate: string): ProviderReliability {
  return {
    candidate, attempts: 0, answered: 0, notMeasured: 0, notMeasuredRateMilli: 0, measuredCoverageMilli: 0,
    byDisposition: emptyCounts(), casesByDisposition: emptyCases(),
    providerRefusedContentCount: 0, interfaceContaminatedCount: 0, providerCapacityExhaustedCount: 0,
    providerUnauthenticatedCount: 0, providerRejectedRequestCount: 0, transportFailedCount: 0,
    measurementFaultCount: 0,
    providerRefusalRateMilli: 0, interfaceContaminationRateMilli: 0, providerCapacityExhaustionRateMilli: 0,
    providerRefusedCases: [], interfaceContaminatedCases: [],
  };
}

/**
 * Reliability per candidate, from rows that carry a case id and a disposition.
 *
 * Read through `effectiveDisposition`, not `dispositionOf`, so a row whose stored disposition
 * predates this pass is counted under the cause its own recorded detail names. The reliability
 * table and the capability rates therefore always partition the same attempts the same way — a
 * count that disagreed with the denominator it explains would be worse than no count.
 */
export function providerReliability(rows: { candidate: string; caseID: string; status?: unknown; detail?: unknown; disposition?: unknown }[]): ProviderReliability[] {
  const candidates = [...new Set(rows.map((row) => row.candidate))].sort();
  return candidates.map((candidate) => {
    const mine = rows.filter((row) => row.candidate === candidate);
    const byDisposition = emptyCounts();
    const casesByDisposition = emptyCases();
    const seen = new Map<AttemptDisposition, Set<string>>(ATTEMPT_DISPOSITIONS.map((d) => [d, new Set<string>()]));
    for (const row of mine) {
      const disposition = effectiveDisposition(row);
      byDisposition[disposition] += 1;
      seen.get(disposition)!.add(row.caseID);
    }
    for (const disposition of ATTEMPT_DISPOSITIONS) {
      casesByDisposition[disposition] = [...seen.get(disposition)!].sort();
    }
    const answered = byDisposition.modelAnswered;
    const notMeasured = mine.length - answered;
    return {
      candidate,
      attempts: mine.length,
      answered,
      notMeasured,
      notMeasuredRateMilli: rateMilli(notMeasured, mine.length),
      measuredCoverageMilli: rateMilli(answered, mine.length),
      byDisposition,
      casesByDisposition,
      providerRefusedContentCount: byDisposition.providerRefusedContent,
      interfaceContaminatedCount: byDisposition.interfaceContaminated,
      providerCapacityExhaustedCount: byDisposition.providerCapacityExhausted,
      providerUnauthenticatedCount: byDisposition.providerUnauthenticated,
      providerRejectedRequestCount: byDisposition.providerRejectedRequest,
      transportFailedCount: byDisposition.transportFailed,
      measurementFaultCount: byDisposition.measurementFault,
      providerRefusalRateMilli: rateMilli(byDisposition.providerRefusedContent, mine.length),
      interfaceContaminationRateMilli: rateMilli(byDisposition.interfaceContaminated, mine.length),
      providerCapacityExhaustionRateMilli: rateMilli(byDisposition.providerCapacityExhausted, mine.length),
      providerRefusedCases: casesByDisposition.providerRefusedContent,
      interfaceContaminatedCases: casesByDisposition.interfaceContaminated,
    };
  });
}
