// Benchmark engine · two answers to two different questions about one JSON output.
//
// THE PASS 6 FINDING THIS FILE EXISTS FOR. Twelve configurations were asked for a JSON object with
// one key. All twelve produced one. Six emitted it bare and scored 100%; four wrapped it in a
// ```json fence and scored 75% or 50%. Every non-pass in the whole 48-attempt pilot was a Claude
// row, and four of the five were valid JSON inside a fence. The published ranking was a ranking of
// punctuation, and nothing in the report could have told a reader that from the numbers alone.
//
// THERE ARE TWO HONEST ANSWERS AND CERNUM NOW PUBLISHES BOTH.
//
//   strict transport compliance   can this output be handed to `JSON.parse` — or to Swift's
//                                 `JSONSerialization`, which is the parity target — exactly as it
//                                 arrived? A fence makes the answer no. This is the FROZEN result,
//                                 computed by the same evaluator under the same sealed policy
//                                 version, and it is the campaign's terminal status.
//   semantic JSON/schema          was the object right? At most one enclosing fence is removed and
//                                 the SAME strict parse is applied to what is inside.
//
// WHAT THIS IS NOT. It is not a looser scorer. The strict verdict is not recomputed, not relaxed and
// not replaced: `scoringPolicyVersion` is untouched, so every row Pass 6 measured stays comparable
// with every row measured after this. The semantic verdict is recorded in its own columns, ranked in
// its own table, and labelled everywhere it appears. A strict failure that the semantic view passes
// is reported as exactly that — a divergence — and never as a pass.
//
// WHY THE DIVERGENCE IS THE INTERESTING COLUMN. A candidate whose two views agree told Cernum one
// thing. A candidate whose views disagree told it two: the object was right AND the transport was
// not. That is a fact about an integration, and it is the fact the Pass 6 ranking hid.

import { BenchmarkCase } from '../core/benchmark';
import { EvaluationEngine } from '../core/engine';
import { policyCatalog } from '../core/catalog';
import { isViolation } from '../core/evaluation';
import { structuredSchemaSemanticEvaluator, structuredSchemaSemanticProfile } from '../core/evaluators';
import { unwrapSingleJSONFence } from '../core/json';
import { PlanSlot, TerminalSlotStatus } from './ledger';
import { attemptRecordForScoring, terminalStatusFor } from './scoring';

/** Both readings of one JSON answer, with the difference between them stated. */
export interface JSONViewAdjudication {
  /** The frozen result. Identical to the campaign's terminal status for this slot. */
  strictTransportStatus: TerminalSlotStatus;
  /** The second reading. NEVER substituted for the status above. */
  semanticSchemaStatus: TerminalSlotStatus;
  semanticGovernanceViolated: boolean;
  semanticDetail: string;
  /** True when one enclosing markdown fence was removed for the semantic reading. */
  fenceRemoved: boolean;
  /** The fence's info string — `json`, usually — when there was one. */
  fenceInfoString?: string;
  /** Why a fence was NOT removed from text that looked fenced. The refusals matter as much as the strips. */
  fenceRefusedBecause?: string;
  /** True when the two readings disagree. The column a reader should look at first. */
  divergent: boolean;
  /** Plain language, for a surface that has room for one sentence and not two tables. */
  divergenceExplanation: string;
  semanticEvaluatorID: string;
  semanticEvaluatorVersion: string;
}

export const NO_DIVERGENCE = 'both readings of this answer agree';

/**
 * Adjudicate one answer under both views.
 *
 * Returns undefined for a case that does not declare a JSON response format: there is no transport
 * question to ask about plain prose, and manufacturing a second verdict for it would put two columns
 * on every row in the campaign to say the same thing twice.
 */
export function adjudicateJSONViews(options: {
  benchmarkCase: BenchmarkCase;
  slot: PlanSlot;
  answerText: string;
  strictStatus: TerminalSlotStatus;
  now?: () => Date;
}): JSONViewAdjudication | undefined {
  if (options.benchmarkCase.responseFormat !== 'json') return undefined;

  const engine = new EvaluationEngine(policyCatalog, options.now ?? (() => new Date()));
  const attempt = attemptRecordForScoring(options.benchmarkCase, options.slot, options.answerText);
  // The SAME sealed policy the strict verdict was produced under, delegation already followed. A
  // second reading judged against a policy this caller chose would be a second benchmark.
  const policy = engine.leafPolicyFor(attempt);
  const verdict = structuredSchemaSemanticEvaluator.evaluate(attempt.observation, 'json', policy);

  const semanticSchemaStatus = terminalStatusFor(verdict.status);
  const unwrap = unwrapSingleJSONFence(options.answerText);

  return {
    strictTransportStatus: options.strictStatus,
    semanticSchemaStatus,
    semanticGovernanceViolated: isViolation(verdict.governance),
    semanticDetail: verdict.disqualificationReason
      ?? (verdict.metrics.map((metric) => metric.detail).filter(Boolean).join('; ')
        || `${structuredSchemaSemanticProfile.evaluatorID} returned ${verdict.status}`),
    fenceRemoved: unwrap.fenceRemoved,
    fenceInfoString: unwrap.infoString,
    fenceRefusedBecause: unwrap.refusedBecause,
    divergent: semanticSchemaStatus !== options.strictStatus,
    divergenceExplanation: explainDivergence(options.strictStatus, semanticSchemaStatus, unwrap.fenceRemoved),
    semanticEvaluatorID: structuredSchemaSemanticProfile.evaluatorID,
    semanticEvaluatorVersion: structuredSchemaSemanticProfile.version,
  };
}

/**
 * The one sentence a reader needs when the two views disagree.
 *
 * Written in both directions. A semantic pass over a strict failure is the fence case and is the
 * common one; a semantic FAILURE over a strict pass would mean the strict parse accepted an object
 * whose contents do not satisfy the schema, which would be a defect in the strict path and must be
 * shouted about rather than smoothed over.
 */
export function explainDivergence(strict: TerminalSlotStatus, semantic: TerminalSlotStatus, fenceRemoved: boolean): string {
  if (strict === semantic) return NO_DIVERGENCE;
  if (semantic === 'pass' && strict !== 'pass') {
    return fenceRemoved
      ? 'the object was right and the transport was not: this answer is valid JSON wrapped in one markdown fence, so it '
        + `fails strict transport compliance (recorded: ${strict}) and passes the semantic reading. Both are true. `
        + 'The strict failure stands as the campaign result.'
      : `the semantic reading passes where strict transport compliance records ${strict}, and no fence was removed — `
        + 'so the difference is not a formatting convention and should be investigated before either result is used.';
  }
  if (strict === 'pass' && semantic !== 'pass') {
    return `strict transport compliance passed and the semantic reading did not (${semantic}). The strict parse accepted `
      + 'an object that does not satisfy the declared schema, which is a defect in the strict path rather than a '
      + 'property of the answer. Do not use either result until it is explained.';
  }
  return `the two readings disagree: strict transport compliance ${strict}, semantic schema ${semantic}.`;
}
