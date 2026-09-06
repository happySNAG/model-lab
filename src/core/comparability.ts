// Model Lab core · explicit comparability policy (port of `ModelLabComparability`).

import { EvaluationRecord } from './evaluation';

export type ComparabilityReason =
  | 'differentCase' | 'differentCaseVersion' | 'differentCaseContent' | 'differentScoringPolicy'
  | 'differentScoringPolicyDigest' | 'differentEvaluator' | 'differentEvaluatorVersion' | 'differentResponseComparabilityKey';

export const ALL_COMPARABILITY_REASONS: ComparabilityReason[] = [
  'differentCase', 'differentCaseVersion', 'differentCaseContent', 'differentScoringPolicy',
  'differentScoringPolicyDigest', 'differentEvaluator', 'differentEvaluatorVersion', 'differentResponseComparabilityKey',
];

export type ComparabilityVerdict = { directlyComparable: true; reasons: [] } | { directlyComparable: false; reasons: ComparabilityReason[] };

export function compareEvaluations(a: EvaluationRecord, b: EvaluationRecord): ComparabilityVerdict {
  const reasons = new Set<ComparabilityReason>();
  if (a.caseID.raw !== b.caseID.raw) reasons.add('differentCase');
  if (a.suiteVersion !== b.suiteVersion) reasons.add('differentCaseVersion');
  if (a.caseDigest !== b.caseDigest) reasons.add('differentCaseContent');
  if (a.comparabilityKey !== b.comparabilityKey) reasons.add('differentResponseComparabilityKey');
  if (a.scoringPolicyID !== b.scoringPolicyID || a.scoringPolicyVersion !== b.scoringPolicyVersion) reasons.add('differentScoringPolicy');
  if (a.scoringPolicyDigest !== b.scoringPolicyDigest) reasons.add('differentScoringPolicyDigest');
  if (a.evaluatorID !== b.evaluatorID) reasons.add('differentEvaluator');
  if (a.evaluatorVersion !== b.evaluatorVersion) reasons.add('differentEvaluatorVersion');
  const ordered = ALL_COMPARABILITY_REASONS.filter((r) => reasons.has(r));
  return ordered.length === 0 ? { directlyComparable: true, reasons: [] } : { directlyComparable: false, reasons: ordered };
}

/** The deterministic like-for-like cohort signature. */
export function comparabilitySignature(record: EvaluationRecord): string {
  return [record.comparabilityKey, record.scoringPolicyID, record.scoringPolicyVersion, record.scoringPolicyDigest, record.evaluatorID, record.evaluatorVersion].join('|');
}
