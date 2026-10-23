// Cernum core · capability profiles (port of `ModelLabCapabilityProfile`).
// A derived view over immutable records: per-dimension tallies, disqualifications listed OUTSIDE
// every average, quality rate unavailable (never zero) when nothing applicable exists.

import { isoSeconds, compareCodePoints } from './digest';
import { CandidateID, Measurement } from './candidate';
import { BenchmarkCaseID } from './benchmark';
import { AttemptRecord } from './run';
import { ALL_DIMENSIONS, CapabilityDimension, EvaluationRecord } from './evaluation';
import { HumanReviewRecord } from './human-review';
import { comparabilitySignature } from './comparability';

export interface ProfileFilter {
  suiteVersions?: Set<string>;
  evaluatorVersions?: Set<string>;
  quantizations?: Set<string>;
  machineIdentifiers?: Set<string>;
  from?: Date;
  to?: Date;
  comparabilitySignature?: string;
}

export function describeProfileFilter(filter: ProfileFilter): string[] {
  const parts: string[] = [];
  const set = (name: string, values?: Set<string>) => { if (values) parts.push(`${name}=${[...values].sort(compareCodePoints).join(',')}`); };
  set('suiteVersions', filter.suiteVersions);
  set('evaluatorVersions', filter.evaluatorVersions);
  set('quantizations', filter.quantizations);
  set('machines', filter.machineIdentifiers);
  if (filter.from) parts.push(`from=${isoSeconds(filter.from)}`);
  if (filter.to) parts.push(`to=${isoSeconds(filter.to)}`);
  if (filter.comparabilitySignature) parts.push(`cohort=${filter.comparabilitySignature}`);
  return parts;
}

export interface GovernanceFailureRef {
  evaluationID: string;
  attemptID: string;
  caseID: BenchmarkCaseID;
  ruleID: string;
  reason: string;
}

export interface DimensionProfile {
  dimension: CapabilityDimension;
  sampleSize: number;
  statusCounts: Record<string, number>;
  disqualifications: GovernanceFailureRef[];
  qualityRateMilli: Measurement<number>;
  distinctComparabilityCohorts: number;
  indeterminateCount: number;
  requiresHumanReviewCount: number;
  notApplicableCount: number;
  suiteVersions: string[];
  evaluatorVersions: string[];
  distinctCaseCount: number;
  humanReviewsRecorded: number;
}

export interface CapabilityProfile {
  candidateID: CandidateID;
  derivationVersion: string;
  filterRestrictions: string[];
  totalEvaluationsConsidered: number;
  dimensions: DimensionProfile[];
  missingDimensions: CapabilityDimension[];
  hardGovernanceFailureTotal: number;
  derivedAt: string;
}
export const PROFILE_DERIVATION_VERSION = 'profile.derivation.v1';

export const QUALITY_RATE_UNAVAILABLE_REASON = 'no applicable, non-disqualified results — missing evidence is not a zero score';

export function buildProfile(candidateID: CandidateID, attempts: AttemptRecord[], evaluations: EvaluationRecord[],
                             humanReviews: HumanReviewRecord[] = [], filter: ProfileFilter = {}, now: Date): CapabilityProfile {
  const attemptsByID = new Map<string, AttemptRecord>();
  for (const a of attempts) if (!attemptsByID.has(a.attemptID)) attemptsByID.set(a.attemptID, a);
  const reviewCounts = new Map<string, number>();
  for (const r of humanReviews) reviewCounts.set(r.attemptID, (reviewCounts.get(r.attemptID) ?? 0) + 1);

  const filtered = evaluations.filter((evaluation) => {
    if (evaluation.candidateID.raw !== candidateID.raw) return false;
    const attempt = attemptsByID.get(evaluation.attemptID);
    if (!attempt) return false;
    if (filter.suiteVersions && !filter.suiteVersions.has(evaluation.suiteVersion)) return false;
    if (filter.evaluatorVersions && !filter.evaluatorVersions.has(evaluation.evaluatorVersion)) return false;
    if (filter.quantizations && !filter.quantizations.has(attempt.candidate.quantization)) return false;
    if (filter.machineIdentifiers) {
      const machine = 'measured' in attempt.environment.machineIdentifier ? attempt.environment.machineIdentifier.measured : 'unknown';
      if (!filter.machineIdentifiers.has(machine)) return false;
    }
    if (filter.from && Date.parse(attempt.startedAt) < filter.from.getTime()) return false;
    if (filter.to && Date.parse(attempt.startedAt) > filter.to.getTime()) return false;
    if (filter.comparabilitySignature && comparabilitySignature(evaluation) !== filter.comparabilitySignature) return false;
    return true;
  });

  const dimensionProfiles: DimensionProfile[] = [];
  let governanceTotal = 0;
  for (const dimension of ALL_DIMENSIONS) {
    const group = filtered.filter((e) => e.verdict.dimension === dimension);
    if (group.length === 0) continue;
    const statusCounts: Record<string, number> = {};
    const disqualifications: GovernanceFailureRef[] = [];
    let applicablePass = 0, applicablePartial = 0, applicableCount = 0;
    let indeterminate = 0, humanReview = 0, notApplicable = 0;
    const cohorts = new Set<string>(), suiteVersions = new Set<string>(), evaluatorVersions = new Set<string>(), caseIDs = new Set<string>();
    const reviewedAttemptIDs = new Set<string>();
    let humanReviewsRecorded = 0;
    for (const evaluation of group) {
      statusCounts[evaluation.verdict.status] = (statusCounts[evaluation.verdict.status] ?? 0) + 1;
      cohorts.add(comparabilitySignature(evaluation));
      suiteVersions.add(evaluation.suiteVersion);
      evaluatorVersions.add(evaluation.evaluatorVersion);
      caseIDs.add(evaluation.caseID.raw);
      if (!reviewedAttemptIDs.has(evaluation.attemptID)) {
        reviewedAttemptIDs.add(evaluation.attemptID);
        humanReviewsRecorded += reviewCounts.get(evaluation.attemptID) ?? 0;
      }
      if (evaluation.verdict.governance.state === 'violated') {
        disqualifications.push({ evaluationID: evaluation.evaluationID, attemptID: evaluation.attemptID, caseID: evaluation.caseID,
                                 ruleID: evaluation.verdict.governance.ruleID, reason: evaluation.verdict.governance.reason });
        continue;
      }
      switch (evaluation.verdict.status) {
        case 'pass': applicablePass += 1; applicableCount += 1; break;
        case 'partial': applicablePartial += 1; applicableCount += 1; break;
        case 'fail': applicableCount += 1; break;
        case 'indeterminate': indeterminate += 1; break;
        case 'requiresHumanReview': humanReview += 1; break;
        case 'notApplicable': notApplicable += 1; break;
      }
    }
    const qualityRateMilli: Measurement<number> = applicableCount === 0
      ? { unavailableReason: QUALITY_RATE_UNAVAILABLE_REASON }
      : { measured: Math.floor((applicablePass * 1_000 + applicablePartial * 500) / applicableCount) };
    governanceTotal += disqualifications.length;
    dimensionProfiles.push({
      dimension, sampleSize: group.length, statusCounts,
      disqualifications: disqualifications.sort((a, b) => compareCodePoints(a.evaluationID, b.evaluationID)),
      qualityRateMilli, distinctComparabilityCohorts: cohorts.size,
      indeterminateCount: indeterminate, requiresHumanReviewCount: humanReview, notApplicableCount: notApplicable,
      suiteVersions: [...suiteVersions].sort(compareCodePoints), evaluatorVersions: [...evaluatorVersions].sort(compareCodePoints),
      distinctCaseCount: caseIDs.size, humanReviewsRecorded,
    });
  }
  const present = new Set(dimensionProfiles.map((d) => d.dimension));
  return {
    candidateID,
    derivationVersion: PROFILE_DERIVATION_VERSION,
    filterRestrictions: describeProfileFilter(filter),
    totalEvaluationsConsidered: filtered.length,
    dimensions: dimensionProfiles.sort((a, b) => compareCodePoints(a.dimension, b.dimension)),
    missingDimensions: ALL_DIMENSIONS.filter((d) => !present.has(d)),
    hardGovernanceFailureTotal: governanceTotal,
    derivedAt: isoSeconds(now),
  };
}
