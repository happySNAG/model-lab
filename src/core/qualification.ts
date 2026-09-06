// Model Lab core · qualification vocabulary (port of `ModelLabQualification`).
// "Approved for production" is STRUCTURALLY unreachable: the assessor's return type has no such value.

import { CandidateDescriptor, claimFor, permitsPlanning } from './candidate';
import { BenchmarkSuite } from './benchmark';
import { AttemptRecord, DerivedScoreRecord, RunSummary } from './run';
import { EvaluationRecord, isDisqualified } from './evaluation';

/** What benchmark machinery may conclude. Deliberately has no approval value. */
export type AssessorVerdict =
  | 'registered' | 'unavailable' | 'compatible' | 'incompatible' | 'evaluated'
  | 'evaluationIncomplete' | 'failedGovernanceRequirements' | 'eligibleForFurtherReview';

export function assessQualification(candidate: CandidateDescriptor, suite: BenchmarkSuite, recordedAttempts: AttemptRecord[],
                                    recordedScores: DerivedScoreRecord[], runSummaries: RunSummary[],
                                    recordedEvaluations: EvaluationRecord[] = []): AssessorVerdict {
  if (candidate.availability.state === 'unavailable') return 'unavailable';
  const required = new Set(suite.cases.flatMap((c) => c.requiredCapabilities));
  if ([...required].some((c) => !permitsPlanning(claimFor(candidate, c)))) return 'incompatible';
  const candidateAttempts = recordedAttempts.filter((a) => a.candidate.id.raw === candidate.id.raw);
  if (candidateAttempts.length === 0) return required.size === 0 ? 'registered' : 'compatible';
  const attemptIDs = new Set(candidateAttempts.map((a) => a.attemptID));
  const governanceFailedInScores = recordedScores.some((s) => attemptIDs.has(s.attemptID) && s.governanceOutcomes.some((o) => o.startsWith('violation:')));
  const governanceFailedInEvaluations = recordedEvaluations.some((e) => attemptIDs.has(e.attemptID) && isDisqualified(e));
  if (governanceFailedInScores || governanceFailedInEvaluations) return 'failedGovernanceRequirements';
  const runIDs = new Set(candidateAttempts.map((a) => a.runID));
  const summariesByRun = new Map(runSummaries.map((s) => [s.runID, s]));
  if (![...runIDs].every((id) => summariesByRun.get(id)?.state === 'completed')) return 'evaluationIncomplete';
  const hasScores = recordedScores.some((s) => attemptIDs.has(s.attemptID));
  const hasEvaluations = recordedEvaluations.some((e) => attemptIDs.has(e.attemptID));
  return hasScores || hasEvaluations ? 'eligibleForFurtherReview' : 'evaluated';
}
