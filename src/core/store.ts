// Model Lab core · durable, append-only result store contract + in-memory implementation
// (port of `ModelLabResultStore`). PERMANENT EVALUATION HISTORY IS A PRIMARY PRODUCT REQUIREMENT:
// nothing is ever overwritten; there is deliberately no delete method at all.

import { compareCodePoints, seal } from './digest';
import { CandidateID } from './candidate';
import { BenchmarkCaseID } from './benchmark';
import { AttemptRecord, DerivedScoreRecord, RunPlan, RunSummary, attemptOrderAscending } from './run';
import { EvaluationRecord } from './evaluation';
import { HumanReviewRecord } from './human-review';
import { OwnerRecommendationRecord } from './recommendation';

export type StoreErrorCode =
  | 'duplicateRun' | 'duplicateAttempt' | 'duplicateScore' | 'duplicateEvaluation' | 'duplicateHumanReview'
  | 'duplicateRecommendation' | 'duplicateSummary' | 'unknownRun' | 'corruptRecord' | 'unsupportedSchemaVersion' | 'ioFailure';

export class ResultStoreError extends Error {
  constructor(public readonly code: StoreErrorCode, message: string, public readonly identity?: string) {
    super(message);
    this.name = 'ResultStoreError';
  }
}

export interface StoreIntegrity { totalRecords: number; decodableRecords: number; corruptRecords: number }

export interface EvidenceBundle {
  storeSchemaVersion: number;
  plans: RunPlan[];
  attempts: AttemptRecord[];
  scores: DerivedScoreRecord[];
  evaluations: EvaluationRecord[];
  humanReviews: HumanReviewRecord[];
  recommendations: OwnerRecommendationRecord[];
  summaries: RunSummary[];
}
export const EVIDENCE_BUNDLE_SCHEMA_VERSION = 1;
export const STORE_SCHEMA_VERSION = 1;

/** Deterministic, sorted bundle exactly like the Swift initializer builds. */
export function makeEvidenceBundle(parts: Partial<EvidenceBundle> & { storeSchemaVersion: number }): EvidenceBundle {
  const by = <T>(key: (v: T) => string) => (a: T, b: T) => compareCodePoints(key(a), key(b));
  return {
    storeSchemaVersion: parts.storeSchemaVersion,
    plans: [...(parts.plans ?? [])].sort(by((p) => p.runID)),
    attempts: [...(parts.attempts ?? [])].sort((a, b) => (a.runID !== b.runID ? compareCodePoints(a.runID, b.runID) : a.ordinal - b.ordinal)),
    scores: [...(parts.scores ?? [])].sort(by((s) => s.scoreID)),
    evaluations: [...(parts.evaluations ?? [])].sort(by((e) => e.evaluationID)),
    humanReviews: [...(parts.humanReviews ?? [])].sort(by((r) => r.reviewID)),
    recommendations: [...(parts.recommendations ?? [])].sort(by((r) => r.recommendationID)),
    summaries: [...(parts.summaries ?? [])].sort(by((s) => s.runID)),
  };
}

export function bundleDigest(bundle: EvidenceBundle): string {
  return seal(bundle, 'mle1:');
}

/** The append-only store. Implementations refuse every overwrite and surface every corruption. */
export interface ResultStore {
  appendPlan(plan: RunPlan): Promise<void>;
  appendAttempt(record: AttemptRecord): Promise<void>;
  appendScore(record: DerivedScoreRecord): Promise<void>;
  appendEvaluation(record: EvaluationRecord): Promise<void>;
  appendHumanReview(record: HumanReviewRecord): Promise<void>;
  appendRecommendation(record: OwnerRecommendationRecord): Promise<void>;
  appendSummary(summary: RunSummary): Promise<void>;

  runIDs(): Promise<string[]>;
  plan(runID: string): Promise<RunPlan | undefined>;
  summary(runID: string): Promise<RunSummary | undefined>;
  attempts(runID: string): Promise<AttemptRecord[]>;
  attempt(attemptID: string): Promise<AttemptRecord | undefined>;
  attemptHistoryForCandidate(candidateID: CandidateID): Promise<AttemptRecord[]>;
  attemptHistoryForCase(caseID: BenchmarkCaseID): Promise<AttemptRecord[]>;
  scores(attemptID: string): Promise<DerivedScoreRecord[]>;
  evaluations(attemptID: string): Promise<EvaluationRecord[]>;
  allEvaluations(): Promise<EvaluationRecord[]>;
  humanReviews(attemptID: string): Promise<HumanReviewRecord[]>;
  allHumanReviews(): Promise<HumanReviewRecord[]>;
  recommendations(candidateID: CandidateID): Promise<OwnerRecommendationRecord[]>;
  allRecommendations(): Promise<OwnerRecommendationRecord[]>;

  integrity(): Promise<StoreIntegrity>;
  exportAll(): Promise<EvidenceBundle>;
}

export class InMemoryResultStore implements ResultStore {
  private plans = new Map<string, RunPlan>();
  private summaries = new Map<string, RunSummary>();
  private attemptsByID = new Map<string, AttemptRecord>();
  private scoresByID = new Map<string, DerivedScoreRecord>();
  private evaluationsByID = new Map<string, EvaluationRecord>();
  private humanReviewsByID = new Map<string, HumanReviewRecord>();
  private recommendationsByID = new Map<string, OwnerRecommendationRecord>();

  async appendPlan(plan: RunPlan): Promise<void> {
    if (this.plans.has(plan.runID)) throw new ResultStoreError('duplicateRun', `store already holds run ${plan.runID}`, plan.runID);
    this.plans.set(plan.runID, plan);
  }
  async appendAttempt(record: AttemptRecord): Promise<void> {
    if (!this.plans.has(record.runID)) throw new ResultStoreError('unknownRun', `store holds no run ${record.runID}`, record.runID);
    if (this.attemptsByID.has(record.attemptID)) throw new ResultStoreError('duplicateAttempt', `store already holds attempt ${record.attemptID}`, record.attemptID);
    this.attemptsByID.set(record.attemptID, record);
  }
  async appendScore(record: DerivedScoreRecord): Promise<void> {
    if (this.scoresByID.has(record.scoreID)) throw new ResultStoreError('duplicateScore', `store already holds score ${record.scoreID}`, record.scoreID);
    this.scoresByID.set(record.scoreID, record);
  }
  async appendEvaluation(record: EvaluationRecord): Promise<void> {
    if (this.evaluationsByID.has(record.evaluationID)) throw new ResultStoreError('duplicateEvaluation', `store already holds evaluation ${record.evaluationID}`, record.evaluationID);
    this.evaluationsByID.set(record.evaluationID, record);
  }
  async appendHumanReview(record: HumanReviewRecord): Promise<void> {
    if (this.humanReviewsByID.has(record.reviewID)) throw new ResultStoreError('duplicateHumanReview', `store already holds human review ${record.reviewID}`, record.reviewID);
    this.humanReviewsByID.set(record.reviewID, record);
  }
  async appendRecommendation(record: OwnerRecommendationRecord): Promise<void> {
    if (this.recommendationsByID.has(record.recommendationID)) throw new ResultStoreError('duplicateRecommendation', `store already holds recommendation ${record.recommendationID}`, record.recommendationID);
    this.recommendationsByID.set(record.recommendationID, record);
  }
  async appendSummary(summary: RunSummary): Promise<void> {
    if (!this.plans.has(summary.runID)) throw new ResultStoreError('unknownRun', `store holds no run ${summary.runID}`, summary.runID);
    if (this.summaries.has(summary.runID)) throw new ResultStoreError('duplicateSummary', `store already holds a summary for run ${summary.runID}`, summary.runID);
    this.summaries.set(summary.runID, summary);
  }

  async runIDs(): Promise<string[]> { return [...this.plans.keys()].sort(compareCodePoints); }
  async plan(runID: string): Promise<RunPlan | undefined> { return this.plans.get(runID); }
  async summary(runID: string): Promise<RunSummary | undefined> { return this.summaries.get(runID); }
  async attempts(runID: string): Promise<AttemptRecord[]> {
    return [...this.attemptsByID.values()].filter((a) => a.runID === runID).sort((a, b) => a.ordinal - b.ordinal);
  }
  async attempt(attemptID: string): Promise<AttemptRecord | undefined> { return this.attemptsByID.get(attemptID); }
  async attemptHistoryForCandidate(candidateID: CandidateID): Promise<AttemptRecord[]> {
    return [...this.attemptsByID.values()].filter((a) => a.candidate.id.raw === candidateID.raw).sort(attemptOrderAscending);
  }
  async attemptHistoryForCase(caseID: BenchmarkCaseID): Promise<AttemptRecord[]> {
    return [...this.attemptsByID.values()].filter((a) => a.caseID.raw === caseID.raw).sort(attemptOrderAscending);
  }
  async scores(attemptID: string): Promise<DerivedScoreRecord[]> {
    return [...this.scoresByID.values()].filter((s) => s.attemptID === attemptID).sort((a, b) => compareCodePoints(a.scoreID, b.scoreID));
  }
  async evaluations(attemptID: string): Promise<EvaluationRecord[]> {
    return [...this.evaluationsByID.values()].filter((e) => e.attemptID === attemptID).sort((a, b) => compareCodePoints(a.evaluationID, b.evaluationID));
  }
  async allEvaluations(): Promise<EvaluationRecord[]> {
    return [...this.evaluationsByID.values()].sort((a, b) => compareCodePoints(a.evaluationID, b.evaluationID));
  }
  async humanReviews(attemptID: string): Promise<HumanReviewRecord[]> {
    return [...this.humanReviewsByID.values()].filter((r) => r.attemptID === attemptID).sort((a, b) => compareCodePoints(a.reviewID, b.reviewID));
  }
  async allHumanReviews(): Promise<HumanReviewRecord[]> {
    return [...this.humanReviewsByID.values()].sort((a, b) => compareCodePoints(a.reviewID, b.reviewID));
  }
  async recommendations(candidateID: CandidateID): Promise<OwnerRecommendationRecord[]> {
    return [...this.recommendationsByID.values()].filter((r) => r.candidateID.raw === candidateID.raw).sort((a, b) => a.sequence - b.sequence);
  }
  async allRecommendations(): Promise<OwnerRecommendationRecord[]> {
    return [...this.recommendationsByID.values()].sort((a, b) => compareCodePoints(a.recommendationID, b.recommendationID));
  }
  async integrity(): Promise<StoreIntegrity> {
    const total = this.plans.size + this.summaries.size + this.attemptsByID.size + this.scoresByID.size
      + this.evaluationsByID.size + this.humanReviewsByID.size + this.recommendationsByID.size;
    return { totalRecords: total, decodableRecords: total, corruptRecords: 0 };
  }
  async exportAll(): Promise<EvidenceBundle> {
    return makeEvidenceBundle({
      storeSchemaVersion: STORE_SCHEMA_VERSION,
      plans: [...this.plans.values()],
      attempts: [...this.attemptsByID.values()],
      scores: [...this.scoresByID.values()],
      evaluations: [...this.evaluationsByID.values()],
      humanReviews: [...this.humanReviewsByID.values()],
      recommendations: [...this.recommendationsByID.values()],
      summaries: [...this.summaries.values()],
    });
  }
}
