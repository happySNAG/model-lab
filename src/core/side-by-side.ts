// Model Lab core · side-by-side comparison of two immutable attempts (port of `ModelLabSideBySide`).

import { compareCodePoints } from './digest';
import { AttemptRecord } from './run';
import { EvaluationRecord } from './evaluation';
import { HumanReviewRecord } from './human-review';
import { ALL_COMPARABILITY_REASONS, ComparabilityReason, ComparabilityVerdict, compareEvaluations } from './comparability';

export interface EvaluationPairEligibility { evaluationIDA: string; evaluationIDB: string; verdict: ComparabilityVerdict }

export interface SideBySideComparison {
  a: AttemptRecord;
  b: AttemptRecord;
  evaluationsA: EvaluationRecord[];
  evaluationsB: EvaluationRecord[];
  reviewsA: HumanReviewRecord[];
  reviewsB: HumanReviewRecord[];
  attemptComparabilityKeysMatch: boolean;
  evaluationEligibility: EvaluationPairEligibility[];
  directlyComparable: boolean;
  ineligibilityReasons: ComparabilityReason[];
}

export function buildSideBySide(attemptA: AttemptRecord, evaluationsA: EvaluationRecord[], reviewsA: HumanReviewRecord[],
                                attemptB: AttemptRecord, evaluationsB: EvaluationRecord[], reviewsB: HumanReviewRecord[]): SideBySideComparison {
  const byID = (a: EvaluationRecord, b: EvaluationRecord) => compareCodePoints(a.evaluationID, b.evaluationID);
  const sortedA = [...evaluationsA].sort(byID);
  const sortedB = [...evaluationsB].sort(byID);
  const pairs: EvaluationPairEligibility[] = [];
  const reasons = new Set<ComparabilityReason>();
  let anyDirect = false;
  for (const left of sortedA) {
    for (const right of sortedB) {
      if (left.evaluatorID !== right.evaluatorID) continue;
      const verdict = compareEvaluations(left, right);
      if (verdict.directlyComparable) anyDirect = true;
      for (const r of verdict.reasons) reasons.add(r);
      pairs.push({ evaluationIDA: left.evaluationID, evaluationIDB: right.evaluationID, verdict });
    }
  }
  const keysMatch = attemptA.comparabilityKey === attemptB.comparabilityKey;
  if (!keysMatch) reasons.add('differentResponseComparabilityKey');
  return {
    a: attemptA, b: attemptB, evaluationsA: sortedA, evaluationsB: sortedB,
    reviewsA: [...reviewsA].sort((x, y) => compareCodePoints(x.reviewID, y.reviewID)),
    reviewsB: [...reviewsB].sort((x, y) => compareCodePoints(x.reviewID, y.reviewID)),
    attemptComparabilityKeysMatch: keysMatch,
    evaluationEligibility: pairs,
    directlyComparable: keysMatch && anyDirect,
    ineligibilityReasons: ALL_COMPARABILITY_REASONS.filter((r) => reasons.has(r)),
  };
}
