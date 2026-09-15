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
export const ATTEMPT_DISPOSITIONS = ['modelAnswered', 'providerRefusedContent', 'interfaceContaminated'] as const;
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

// MARK: - Provider reliability, which is the reporting half

export interface ProviderReliability {
  candidate: string;
  attempts: number;
  /** Attempts on which a model answered and the row was therefore scoreable. */
  answered: number;
  providerRefusedContentCount: number;
  interfaceContaminatedCount: number;
  /** Per thousand attempts, so it sits beside the pass rates in the same units. */
  providerRefusalRateMilli: number;
  interfaceContaminationRateMilli: number;
  /** The cases that were refused or contaminated, named so the loss is visible and not just counted. */
  providerRefusedCases: string[];
  interfaceContaminatedCases: string[];
}

export const PROVIDER_RELIABILITY_MEANS =
  'These rates describe the PROVIDER and the INTERFACE, never the model. A refusal rate is how often '
  + 'an end-to-end request could not be completed through this path at all; a contamination rate is how '
  + 'often the isolation envelope failed to hold. Both are excluded from every capability rate, and '
  + 'neither may be read as a quality figure or netted against one.';

function rateMilli(count: number, of: number): number {
  return of === 0 ? 0 : Math.round((count * 1000) / of);
}

/** Reliability per candidate, from rows that carry a case id and a disposition. */
export function providerReliability(rows: { candidate: string; caseID: string; disposition?: unknown }[]): ProviderReliability[] {
  const candidates = [...new Set(rows.map((row) => row.candidate))].sort();
  return candidates.map((candidate) => {
    const mine = rows.filter((row) => row.candidate === candidate);
    const refused = mine.filter((row) => dispositionOf(row) === 'providerRefusedContent');
    const contaminated = mine.filter((row) => dispositionOf(row) === 'interfaceContaminated');
    const answered = mine.filter((row) => dispositionOf(row) === 'modelAnswered');
    return {
      candidate,
      attempts: mine.length,
      answered: answered.length,
      providerRefusedContentCount: refused.length,
      interfaceContaminatedCount: contaminated.length,
      providerRefusalRateMilli: rateMilli(refused.length, mine.length),
      interfaceContaminationRateMilli: rateMilli(contaminated.length, mine.length),
      providerRefusedCases: [...new Set(refused.map((row) => row.caseID))].sort(),
      interfaceContaminatedCases: [...new Set(contaminated.map((row) => row.caseID))].sort(),
    };
  });
}
