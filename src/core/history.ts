// Cernum core · history browsing and comparison over the permanent record (port of `ModelLabHistory`).
// Pure derived views: latest/best WITHIN one cohort only; governance failures surfaced everywhere;
// trends as points, never averages; repetitions as counts, never blended.

import { compareCodePoints, fnv1a64Hex, isoSeconds } from './digest';
import { CandidateID, Measurement } from './candidate';
import { BenchmarkCaseID, BenchmarkSuiteID } from './benchmark';
import { AttemptRecord, RunState, RunSummary, attemptOrderAscending } from './run';
import { CapabilityDimension, EvaluationRecord, EvaluationStatus } from './evaluation';
import { HumanReviewRecord } from './human-review';
import { comparabilitySignature } from './comparability';
import { GovernanceFailureRef, QUALITY_RATE_UNAVAILABLE_REASON } from './profile';

export interface HistoryFilter {
  candidateIDs?: Set<string>;
  providers?: Set<string>;
  exactModelIdentities?: Set<string>;
  runtimeVersions?: Set<string>;
  quantizations?: Set<string>;
  machineIdentifiers?: Set<string>;
  suiteIDs?: Set<string>;
  suiteVersions?: Set<string>;
  evaluatorIDs?: Set<string>;
  evaluatorVersions?: Set<string>;
  from?: Date;
  to?: Date;
  comparabilitySignature?: string;
  onlyGovernanceFailures?: boolean;
  onlyHumanReviewed?: boolean;
  onlyUncertain?: boolean;
}

export function describeHistoryFilter(filter: HistoryFilter): string[] {
  const parts: string[] = [];
  const add = (name: string, set?: Set<string>) => { if (set) parts.push(`${name}=${[...set].sort(compareCodePoints).join(',')}`); };
  add('candidates', filter.candidateIDs); add('providers', filter.providers); add('models', filter.exactModelIdentities);
  add('runtimeVersions', filter.runtimeVersions); add('quantizations', filter.quantizations); add('machines', filter.machineIdentifiers);
  add('suites', filter.suiteIDs); add('suiteVersions', filter.suiteVersions); add('evaluators', filter.evaluatorIDs); add('evaluatorVersions', filter.evaluatorVersions);
  if (filter.from) parts.push(`from=${isoSeconds(filter.from)}`);
  if (filter.to) parts.push(`to=${isoSeconds(filter.to)}`);
  if (filter.comparabilitySignature) parts.push(`cohort=${filter.comparabilitySignature}`);
  if (filter.onlyGovernanceFailures) parts.push('onlyGovernanceFailures');
  if (filter.onlyHumanReviewed) parts.push('onlyHumanReviewed');
  if (filter.onlyUncertain) parts.push('onlyUncertain');
  return parts;
}

export function admitsAttempt(filter: HistoryFilter, attempt: AttemptRecord): boolean {
  if (filter.candidateIDs && !filter.candidateIDs.has(attempt.candidate.id.raw)) return false;
  if (filter.providers && !filter.providers.has(attempt.candidate.provider)) return false;
  if (filter.exactModelIdentities && !filter.exactModelIdentities.has(attempt.candidate.exactModelIdentity)) return false;
  if (filter.runtimeVersions) {
    const v = attempt.environment.inferenceRuntimeVersion;
    if (!('measured' in v) || !filter.runtimeVersions.has(v.measured)) return false;
  }
  if (filter.quantizations && !filter.quantizations.has(attempt.candidate.quantization)) return false;
  if (filter.machineIdentifiers) {
    const machine = 'measured' in attempt.environment.machineIdentifier ? attempt.environment.machineIdentifier.measured : 'unknown';
    if (!filter.machineIdentifiers.has(machine)) return false;
  }
  if (filter.suiteIDs && !filter.suiteIDs.has(attempt.suiteID.raw)) return false;
  if (filter.suiteVersions && !filter.suiteVersions.has(attempt.suiteVersion)) return false;
  if (filter.from && Date.parse(attempt.startedAt) < filter.from.getTime()) return false;
  if (filter.to && Date.parse(attempt.startedAt) > filter.to.getTime()) return false;
  return true;
}

export function admitsEvaluation(filter: HistoryFilter, evaluation: EvaluationRecord, attempt: AttemptRecord, reviewCount: number): boolean {
  if (!admitsAttempt(filter, attempt)) return false;
  if (filter.evaluatorIDs && !filter.evaluatorIDs.has(evaluation.evaluatorID)) return false;
  if (filter.evaluatorVersions && !filter.evaluatorVersions.has(evaluation.evaluatorVersion)) return false;
  if (filter.comparabilitySignature && comparabilitySignature(evaluation) !== filter.comparabilitySignature) return false;
  if (filter.onlyGovernanceFailures && evaluation.verdict.governance.state !== 'violated') return false;
  if (filter.onlyHumanReviewed && reviewCount === 0) return false;
  if (filter.onlyUncertain && evaluation.verdict.status !== 'indeterminate' && evaluation.verdict.status !== 'requiresHumanReview') return false;
  return true;
}

export interface RunOverview {
  runID: string;
  suiteID: BenchmarkSuiteID;
  suiteVersion: string;
  candidateIDs: CandidateID[];
  state?: RunState;
  plannedAttemptCount?: number;
  recordedAttemptCount: number;
  terminalStatusCounts: Record<string, number>;
  evaluationStatusCounts: Record<string, number>;
  governanceFailureCount: number;
  earliestStartedAt?: string;
  latestFinishedAt?: string;
}

export interface CohortRunQuality {
  runID: string;
  comparabilitySignature: string;
  sampleSize: number;
  qualityRateMilli: Measurement<number>;
  disqualifications: GovernanceFailureRef[];
  indeterminateCount: number;
  requiresHumanReviewCount: number;
  notApplicableCount: number;
  earliestStartedAt: string;
}

export interface CohortComparison {
  comparabilitySignature: string;
  runs: CohortRunQuality[];
  latest?: CohortRunQuality;
  best?: CohortRunQuality;
}

export interface TrendPoint {
  attemptID: string;
  runID: string;
  caseID: BenchmarkCaseID;
  startedAt: string;
  status: EvaluationStatus;
  disqualified: boolean;
  comparabilitySignature: string;
  evaluatorVersion: string;
  suiteVersion: string;
}

export interface RepetitionConsistency {
  caseID: BenchmarkCaseID;
  comparabilityKey: string;
  attemptCount: number;
  terminalStatusCounts: Record<string, number>;
  evaluationStatusCounts: Record<string, number>;
  disqualificationCount: number;
  distinctOutputCount: number;
}

function earliest(a: string, b: string): boolean {
  return Date.parse(a) < Date.parse(b);
}

export function matchingEvaluations(evaluations: EvaluationRecord[], attempts: AttemptRecord[], reviews: HumanReviewRecord[],
                                    filter: HistoryFilter): Array<{ evaluation: EvaluationRecord; attempt: AttemptRecord }> {
  const attemptsByID = new Map<string, AttemptRecord>();
  for (const a of attempts) if (!attemptsByID.has(a.attemptID)) attemptsByID.set(a.attemptID, a);
  const reviewCounts = new Map<string, number>();
  for (const r of reviews) reviewCounts.set(r.attemptID, (reviewCounts.get(r.attemptID) ?? 0) + 1);
  const joined: Array<{ evaluation: EvaluationRecord; attempt: AttemptRecord }> = [];
  for (const evaluation of evaluations) {
    const attempt = attemptsByID.get(evaluation.attemptID);
    if (!attempt) continue;
    if (!admitsEvaluation(filter, evaluation, attempt, reviewCounts.get(evaluation.attemptID) ?? 0)) continue;
    joined.push({ evaluation, attempt });
  }
  return joined.sort((a, b) => compareCodePoints(a.evaluation.evaluationID, b.evaluation.evaluationID));
}

export function runOverviews(attempts: AttemptRecord[], summaries: RunSummary[], evaluations: EvaluationRecord[], filter: HistoryFilter = {}): RunOverview[] {
  const filtered = attempts.filter((a) => admitsAttempt(filter, a));
  const summariesByRun = new Map<string, RunSummary>();
  for (const s of summaries) if (!summariesByRun.has(s.runID)) summariesByRun.set(s.runID, s);
  const evaluationsByAttempt = new Map<string, EvaluationRecord[]>();
  for (const e of evaluations) evaluationsByAttempt.set(e.attemptID, [...(evaluationsByAttempt.get(e.attemptID) ?? []), e]);
  const byRun = new Map<string, AttemptRecord[]>();
  for (const a of filtered) byRun.set(a.runID, [...(byRun.get(a.runID) ?? []), a]);
  const overviews: RunOverview[] = [];
  for (const [runID, runAttempts] of byRun) {
    const terminalCounts: Record<string, number> = {};
    const evaluationCounts: Record<string, number> = {};
    let governanceFailures = 0;
    const candidateIDs = new Set<string>();
    for (const attempt of runAttempts) {
      terminalCounts[attempt.terminalStatus] = (terminalCounts[attempt.terminalStatus] ?? 0) + 1;
      candidateIDs.add(attempt.candidate.id.raw);
      for (const evaluation of evaluationsByAttempt.get(attempt.attemptID) ?? []) {
        evaluationCounts[evaluation.verdict.status] = (evaluationCounts[evaluation.verdict.status] ?? 0) + 1;
        if (evaluation.verdict.governance.state === 'violated') governanceFailures += 1;
      }
    }
    const summary = summariesByRun.get(runID);
    const sample = [...runAttempts].sort(attemptOrderAscending)[0];
    const starts = runAttempts.map((a) => a.startedAt).sort((a, b) => Date.parse(a) - Date.parse(b));
    const ends = runAttempts.map((a) => a.finishedAt).sort((a, b) => Date.parse(a) - Date.parse(b));
    overviews.push({
      runID, suiteID: sample.suiteID, suiteVersion: sample.suiteVersion,
      candidateIDs: [...candidateIDs].sort(compareCodePoints).map((raw) => ({ raw })),
      state: summary?.state, plannedAttemptCount: summary?.plannedAttemptCount, recordedAttemptCount: runAttempts.length,
      terminalStatusCounts: terminalCounts, evaluationStatusCounts: evaluationCounts, governanceFailureCount: governanceFailures,
      earliestStartedAt: starts[0], latestFinishedAt: ends[ends.length - 1],
    });
  }
  return overviews.sort((a, b) => {
    if (a.earliestStartedAt && b.earliestStartedAt && a.earliestStartedAt !== b.earliestStartedAt) return earliest(a.earliestStartedAt, b.earliestStartedAt) ? -1 : 1;
    return compareCodePoints(a.runID, b.runID);
  });
}

export function cohortComparisons(candidateID: CandidateID, evaluations: EvaluationRecord[], attempts: AttemptRecord[],
                                  reviews: HumanReviewRecord[] = [], filter: HistoryFilter = {}): CohortComparison[] {
  const scoped: HistoryFilter = { ...filter, candidateIDs: new Set([candidateID.raw]) };
  const joined = matchingEvaluations(evaluations, attempts, reviews, scoped);
  const byCohort = new Map<string, typeof joined>();
  for (const pair of joined) {
    const signature = comparabilitySignature(pair.evaluation);
    byCohort.set(signature, [...(byCohort.get(signature) ?? []), pair]);
  }
  const comparisons: CohortComparison[] = [];
  for (const [signature, pairs] of byCohort) {
    const byRun = new Map<string, typeof pairs>();
    for (const pair of pairs) byRun.set(pair.attempt.runID, [...(byRun.get(pair.attempt.runID) ?? []), pair]);
    const runs: CohortRunQuality[] = [];
    for (const [runID, runPairs] of byRun) {
      let pass = 0, partial = 0, applicable = 0, indeterminate = 0, humanReview = 0, notApplicable = 0;
      const disqualifications: GovernanceFailureRef[] = [];
      for (const { evaluation } of runPairs) {
        if (evaluation.verdict.governance.state === 'violated') {
          disqualifications.push({ evaluationID: evaluation.evaluationID, attemptID: evaluation.attemptID, caseID: evaluation.caseID,
                                   ruleID: evaluation.verdict.governance.ruleID, reason: evaluation.verdict.governance.reason });
          continue;
        }
        switch (evaluation.verdict.status) {
          case 'pass': pass += 1; applicable += 1; break;
          case 'partial': partial += 1; applicable += 1; break;
          case 'fail': applicable += 1; break;
          case 'indeterminate': indeterminate += 1; break;
          case 'requiresHumanReview': humanReview += 1; break;
          case 'notApplicable': notApplicable += 1; break;
        }
      }
      const rate: Measurement<number> = applicable === 0
        ? { unavailableReason: QUALITY_RATE_UNAVAILABLE_REASON }
        : { measured: Math.floor((pass * 1_000 + partial * 500) / applicable) };
      const starts = runPairs.map((p) => p.attempt.startedAt).sort((a, b) => Date.parse(a) - Date.parse(b));
      runs.push({ runID, comparabilitySignature: signature, sampleSize: runPairs.length, qualityRateMilli: rate,
                  disqualifications: disqualifications.sort((a, b) => compareCodePoints(a.evaluationID, b.evaluationID)),
                  indeterminateCount: indeterminate, requiresHumanReviewCount: humanReview, notApplicableCount: notApplicable, earliestStartedAt: starts[0] });
    }
    runs.sort((a, b) => {
      if (a.earliestStartedAt !== b.earliestStartedAt) return earliest(a.earliestStartedAt, b.earliestStartedAt) ? -1 : 1;
      return compareCodePoints(a.runID, b.runID);
    });
    const latest = runs[runs.length - 1];
    let best: CohortRunQuality | undefined;
    for (const run of runs) {
      if (!('measured' in run.qualityRateMilli)) continue;
      if (!best) { best = run; continue; }
      const rb = (best.qualityRateMilli as { measured: number }).measured;
      const ra = run.qualityRateMilli.measured;
      // Swift `max(by:)`: keeps the LAST maximal element under the comparator "a < b".
      const less = ra !== rb ? rb < ra : best.sampleSize !== run.sampleSize ? best.sampleSize < run.sampleSize : compareCodePoints(best.runID, run.runID) > 0;
      if (less) best = run;
    }
    comparisons.push({ comparabilitySignature: signature, runs, latest, best });
  }
  return comparisons.sort((a, b) => compareCodePoints(a.comparabilitySignature, b.comparabilitySignature));
}

export function trendPoints(candidateID: CandidateID, dimension: CapabilityDimension, evaluations: EvaluationRecord[], attempts: AttemptRecord[],
                            reviews: HumanReviewRecord[] = [], filter: HistoryFilter = {}): TrendPoint[] {
  const scoped: HistoryFilter = { ...filter, candidateIDs: new Set([candidateID.raw]) };
  return matchingEvaluations(evaluations, attempts, reviews, scoped)
    .filter((p) => p.evaluation.verdict.dimension === dimension)
    .map(({ evaluation, attempt }) => ({
      attemptID: attempt.attemptID, runID: attempt.runID, caseID: evaluation.caseID, startedAt: attempt.startedAt,
      status: evaluation.verdict.status, disqualified: evaluation.verdict.governance.state === 'violated',
      comparabilitySignature: comparabilitySignature(evaluation), evaluatorVersion: evaluation.evaluatorVersion, suiteVersion: evaluation.suiteVersion,
    }))
    .sort((a, b) => {
      if (a.startedAt !== b.startedAt) return earliest(a.startedAt, b.startedAt) ? -1 : 1;
      return compareCodePoints(a.attemptID, b.attemptID);
    });
}

export function repetitionConsistency(candidateID: CandidateID, caseID: BenchmarkCaseID, attempts: AttemptRecord[], evaluations: EvaluationRecord[],
                                      filter: HistoryFilter = {}): RepetitionConsistency[] {
  const scoped: HistoryFilter = { ...filter, candidateIDs: new Set([candidateID.raw]) };
  const relevant = attempts.filter((a) => a.caseID.raw === caseID.raw && admitsAttempt(scoped, a));
  const evaluationsByAttempt = new Map<string, EvaluationRecord[]>();
  for (const e of evaluations) evaluationsByAttempt.set(e.attemptID, [...(evaluationsByAttempt.get(e.attemptID) ?? []), e]);
  const byKey = new Map<string, AttemptRecord[]>();
  for (const a of relevant) byKey.set(a.comparabilityKey, [...(byKey.get(a.comparabilityKey) ?? []), a]);
  const results: RepetitionConsistency[] = [];
  for (const [key, group] of byKey) {
    const terminalCounts: Record<string, number> = {};
    const evaluationCounts: Record<string, number> = {};
    let disqualifications = 0;
    const outputDigests = new Set<string>();
    for (const attempt of group) {
      terminalCounts[attempt.terminalStatus] = (terminalCounts[attempt.terminalStatus] ?? 0) + 1;
      outputDigests.add(fnv1a64Hex(attempt.observation.structuredOutputRaw ?? attempt.observation.outputText ?? '«no output»'));
      for (const evaluation of evaluationsByAttempt.get(attempt.attemptID) ?? []) {
        evaluationCounts[evaluation.verdict.status] = (evaluationCounts[evaluation.verdict.status] ?? 0) + 1;
        if (evaluation.verdict.governance.state === 'violated') disqualifications += 1;
      }
    }
    results.push({ caseID, comparabilityKey: key, attemptCount: group.length, terminalStatusCounts: terminalCounts,
                   evaluationStatusCounts: evaluationCounts, disqualificationCount: disqualifications, distinctOutputCount: outputDigests.size });
  }
  return results.sort((a, b) => compareCodePoints(a.comparabilityKey, b.comparabilityKey));
}
