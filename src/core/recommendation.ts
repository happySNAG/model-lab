// Cernum core · the explicit recommendation workflow (port of `ModelLabRecommendation`).
// Four outcomes, no approval case anywhere; every record carries its evidence and the boundary statement.

import { seal, isoSeconds, compareCodePoints } from './digest';
import { CandidateID, Measurement } from './candidate';
import { CapabilityDimension } from './evaluation';
import { CapabilityProfile, DimensionProfile, GovernanceFailureRef } from './profile';

export type RecommendationOutcome = 'recommended' | 'notRecommended' | 'insufficientEvidence' | 'disqualified';

export interface RecommendationPolicy {
  minimumSamplesPerDimension: number;
  minimumDimensionsWithEvidence: number;
  recommendQualityThresholdMilli: number;
}
export const RECOMMENDATION_POLICY_VERSION = 'recommendation.policy.v1';
export const standardRecommendationPolicy: RecommendationPolicy = { minimumSamplesPerDimension: 3, minimumDimensionsWithEvidence: 6, recommendQualityThresholdMilli: 800 };

export function recommendationPolicyDigest(policy: RecommendationPolicy): string {
  return seal(policy, 'mlrp1:');
}

export interface RecommendationDimensionEvidence {
  dimension: CapabilityDimension;
  sampleSize: number;
  qualityRateMilli: Measurement<number>;
  disqualificationCount: number;
  indeterminateCount: number;
  requiresHumanReviewCount: number;
  comparabilityCohortCount: number;
  suiteVersions: string[];
  evaluatorVersions: string[];
  countedAsCovered: boolean;
}

export const AUTHORIZATION_BOUNDARY =
  "A recommendation is evidence for a human decision, not authorization: it activates nothing, changes no configuration, and Skippy's production behavior is unchanged unless the owner later acts through Skippy's existing governance.";

export interface OwnerRecommendationRecord {
  recommendationID: string;
  candidateID: CandidateID;
  sequence: number;
  outcome: RecommendationOutcome;
  reasons: string[];
  policy: RecommendationPolicy;
  policyDigest: string;
  profileDerivationVersion: string;
  filterRestrictions: string[];
  totalEvaluationsConsidered: number;
  dimensionEvidence: RecommendationDimensionEvidence[];
  governanceFailures: GovernanceFailureRef[];
  missingDimensions: CapabilityDimension[];
  humanReviewsConsidered: number;
  authorizationBoundary: string;
  derivedAt: string;
}
export const RECOMMENDATION_SCHEMA_VERSION = 1;

export function deriveRecommendation(profile: CapabilityProfile, humanReviewsConsidered: number, policy: RecommendationPolicy,
                                     sequence: number, now: Date): OwnerRecommendationRecord {
  const reasons: string[] = [];
  const governanceFailures: GovernanceFailureRef[] = [];
  const evidence: RecommendationDimensionEvidence[] = [];
  const covered: DimensionProfile[] = [];
  for (const dimension of profile.dimensions) {
    governanceFailures.push(...dimension.disqualifications);
    const isCovered = 'measured' in dimension.qualityRateMilli && dimension.sampleSize >= policy.minimumSamplesPerDimension;
    if (isCovered) covered.push(dimension);
    evidence.push({
      dimension: dimension.dimension, sampleSize: dimension.sampleSize, qualityRateMilli: dimension.qualityRateMilli,
      disqualificationCount: dimension.disqualifications.length, indeterminateCount: dimension.indeterminateCount,
      requiresHumanReviewCount: dimension.requiresHumanReviewCount, comparabilityCohortCount: dimension.distinctComparabilityCohorts,
      suiteVersions: dimension.suiteVersions, evaluatorVersions: dimension.evaluatorVersions, countedAsCovered: isCovered,
    });
  }
  const rate = (d: DimensionProfile) => ('measured' in d.qualityRateMilli ? d.qualityRateMilli.measured : 0);
  let outcome: RecommendationOutcome;
  if (profile.hardGovernanceFailureTotal > 0) {
    outcome = 'disqualified';
    reasons.push(`hard-governance failures recorded: ${profile.hardGovernanceFailureTotal} — a governance failure disqualifies regardless of quality`);
    for (const failure of [...governanceFailures].sort((a, b) => compareCodePoints(a.evaluationID, b.evaluationID))) {
      reasons.push(`governance failure ${failure.ruleID} on ${failure.caseID.raw}: ${failure.reason}`);
    }
  } else if (profile.totalEvaluationsConsidered === 0) {
    outcome = 'insufficientEvidence';
    reasons.push('no evaluations exist for this candidate under the given filter');
  } else if (covered.length < policy.minimumDimensionsWithEvidence) {
    outcome = 'insufficientEvidence';
    reasons.push(`only ${covered.length} of the required ${policy.minimumDimensionsWithEvidence} dimensions have ≥${policy.minimumSamplesPerDimension} applicable samples and a measurable quality rate`);
    for (const dimension of profile.dimensions) {
      if (covered.includes(dimension)) continue;
      if ('unavailableReason' in dimension.qualityRateMilli) reasons.push(`${dimension.dimension}: rate unavailable — ${dimension.qualityRateMilli.unavailableReason}`);
      else reasons.push(`${dimension.dimension}: only ${dimension.sampleSize} samples (needs ${policy.minimumSamplesPerDimension})`);
    }
    if (profile.missingDimensions.length > 0) reasons.push(`no evidence at all for: ${profile.missingDimensions.join(', ')}`);
  } else {
    const below = covered.filter((d) => rate(d) < policy.recommendQualityThresholdMilli);
    if (below.length === 0) {
      outcome = 'recommended';
      for (const d of covered) reasons.push(`${d.dimension}: ${rate(d)}/1000 over ${d.sampleSize} samples meets the ${policy.recommendQualityThresholdMilli}/1000 threshold`);
    } else {
      outcome = 'notRecommended';
      for (const d of below) reasons.push(`${d.dimension}: ${rate(d)}/1000 is below the ${policy.recommendQualityThresholdMilli}/1000 threshold`);
    }
    if (profile.missingDimensions.length > 0) {
      reasons.push(`dimensions without evidence (excluded from the verdict, stated honestly): ${profile.missingDimensions.join(', ')}`);
    }
  }
  return {
    recommendationID: `recommendation:${profile.candidateID.raw}:${sequence}`,
    candidateID: profile.candidateID,
    sequence,
    outcome,
    reasons,
    policy,
    policyDigest: recommendationPolicyDigest(policy),
    profileDerivationVersion: profile.derivationVersion,
    filterRestrictions: profile.filterRestrictions,
    totalEvaluationsConsidered: profile.totalEvaluationsConsidered,
    dimensionEvidence: evidence,
    governanceFailures: [...governanceFailures].sort((a, b) => compareCodePoints(a.evaluationID, b.evaluationID)),
    missingDimensions: profile.missingDimensions,
    humanReviewsConsidered,
    authorizationBoundary: AUTHORIZATION_BOUNDARY,
    derivedAt: isoSeconds(now),
  };
}
