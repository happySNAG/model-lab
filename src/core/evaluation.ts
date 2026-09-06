// Model Lab core · evaluation verdicts and permanent evaluation records (port of `ModelLabEvaluation`).
// Governance is orthogonal to quality; missing evidence is not zero; indeterminate is not passed.

import { Measurement } from './candidate';
import { canonicalJSON } from './digest';
import { BenchmarkCaseID, BenchmarkSuiteID } from './benchmark';
import { DerivedScoreRecord, makeDerivedScore } from './run';
import { CandidateID } from './candidate';

export type CapabilityDimension =
  | 'conversation' | 'memoryHonesty' | 'contextIntegration' | 'calendarReasoning' | 'emotionalUnderstanding'
  | 'privacyAndGovernance' | 'hallucinationResistance' | 'toolUse' | 'planning' | 'longContextRetrieval'
  | 'safetyBoundaries' | 'structuredOutputReliability';

/** Declaration order (the Swift `allCases` order); sorted order is by raw value. */
export const ALL_DIMENSIONS: CapabilityDimension[] = [
  'conversation', 'memoryHonesty', 'contextIntegration', 'calendarReasoning', 'emotionalUnderstanding',
  'privacyAndGovernance', 'hallucinationResistance', 'toolUse', 'planning', 'longContextRetrieval',
  'safetyBoundaries', 'structuredOutputReliability',
];

export type EvaluationStatus = 'pass' | 'partial' | 'fail' | 'indeterminate' | 'requiresHumanReview' | 'notApplicable';

export type GovernanceOutcome =
  | { state: 'notAssessed' }
  | { state: 'satisfied' }
  | { state: 'violated'; ruleID: string; reason: string };

export function isViolation(g: GovernanceOutcome): g is { state: 'violated'; ruleID: string; reason: string } {
  return g.state === 'violated';
}

export interface MetricResult {
  name: string;
  dimension: CapabilityDimension;
  status: EvaluationStatus;
  valueMilli: Measurement<number>;
  detail: string;
}

export interface MissingEvidence { field: string; reason: string }

export interface EvaluationVerdict {
  status: EvaluationStatus;
  dimension: CapabilityDimension;
  governance: GovernanceOutcome;
  metrics: MetricResult[];
  missingEvidence: MissingEvidence[];
  evidenceExcerpts: string[];
  warnings: string[];
  disqualificationReason?: string;
}

export interface EvaluationRecord {
  evaluationID: string;
  attemptID: string;
  candidateID: CandidateID;
  suiteID: BenchmarkSuiteID;
  suiteVersion: string;
  caseID: BenchmarkCaseID;
  caseDigest: string;
  category: string;
  comparabilityKey: string;
  evaluatorID: string;
  evaluatorVersion: string;
  scoringPolicyID: string;
  scoringPolicyVersion: string;
  scoringPolicyDigest: string;
  verdict: EvaluationVerdict;
  evaluatedAt: string;
}
export const EVALUATION_SCHEMA_VERSION = 1;

export function makeEvaluationRecord(fields: Omit<EvaluationRecord, 'evaluationID'>): EvaluationRecord {
  return { evaluationID: `evaluation:${fields.attemptID}:${fields.evaluatorID}:${fields.evaluatorVersion}`, ...fields };
}

export function isDisqualified(record: EvaluationRecord): boolean {
  return isViolation(record.verdict.governance);
}

/** Do two records under the same identity say the SAME THING? Everything but the instant is compared. */
export function agreesInSubstance(a: EvaluationRecord, b: EvaluationRecord): boolean {
  const strip = (r: EvaluationRecord) => canonicalJSON({ ...r, evaluatedAt: undefined });
  return strip(a) === strip(b);
}

/** The compact projection into the Campaign 1 derived-score row — the ONE place score content comes from. */
export function derivedScoreProjection(record: EvaluationRecord): DerivedScoreRecord {
  const metrics: Record<string, number> = {};
  for (const metric of record.verdict.metrics) {
    if ('measured' in metric.valueMilli) metrics[metric.name] = metric.valueMilli.measured;
  }
  const governanceOutcomes: string[] = [];
  if (record.verdict.governance.state === 'violated') governanceOutcomes.push(`violation:${record.verdict.governance.ruleID}`);
  else if (record.verdict.governance.state === 'satisfied') governanceOutcomes.push('satisfied:hard-governance');
  const notes = [...record.verdict.warnings];
  if (record.verdict.disqualificationReason !== undefined) notes.push(`disqualified: ${record.verdict.disqualificationReason}`);
  notes.push(`status:${record.verdict.status}`);
  return makeDerivedScore({
    attemptID: record.attemptID,
    evaluatorID: record.evaluatorID,
    evaluatorVersion: record.evaluatorVersion,
    scoringPolicyID: record.scoringPolicyID,
    scoringPolicyVersion: record.scoringPolicyVersion,
    categoryMetricsMilli: { [record.category]: metrics },
    governanceOutcomes,
    notes,
    evaluatedAt: record.evaluatedAt,
  });
}
