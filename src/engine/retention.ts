// Benchmark engine · retention recommendations.
//
// THESE ARE INTERPRETATION, AND THEY SAY SO IN THEIR OWN HEADING. A recommendation to keep or drop
// a model is a judgement about what the owner needs, not a fact the benchmark established. The
// measurements are in `ranking.ts`; this module reads them and offers an opinion, labelled as one,
// with the evidence it rests on attached so the owner can disagree without re-deriving anything.
//
// NOTHING HERE DELETES ANYTHING. The engine has no delete path for a model, by design. A retention
// recommendation is a sentence for a person to read, and the decision stays theirs.

import { Measurement } from '../core/candidate';
import { CandidateRanking, FinalRankings } from './ranking';

export type RetentionOutcome = 'keep' | 'keepForOneRole' | 'replace' | 'insufficientEvidence' | 'disqualified';

export interface RetentionPolicy {
  /** A model at or above this overall pass rate earns an unqualified keep. */
  keepPassRateMilli: number;
  /** Below this, the recommendation is to replace it. */
  replacePassRateMilli: number;
  /** Fewer scored outcomes than this and no recommendation is offered at all. */
  minimumScoredOutcomes: number;
  /** A model this much slower than the cohort median is called out, whatever its quality. */
  slowerThanMedianMultiplierMilli: number;
}

export const STANDARD_RETENTION_POLICY: RetentionPolicy = {
  keepPassRateMilli: 800,
  replacePassRateMilli: 600,
  minimumScoredOutcomes: 12,
  slowerThanMedianMultiplierMilli: 2_500,
};

export const RETENTION_HEADING = 'Retention recommendations — INTERPRETATION, not measurement';

export const RETENTION_PREAMBLE = [
  'Everything above this heading is a measurement read off the ledger under rules fixed before the first request.',
  'Everything below it is a judgement about what these measurements mean for the work at hand, and a different owner with different work could reasonably reach a different one.',
  'No model is deleted by this engine. These are sentences to read, not actions taken.',
];

export interface RetentionRecommendation {
  candidate: string;
  outcome: RetentionOutcome;
  /** One sentence, in plain language, that a person can act on. */
  statement: string;
  /** The measurements this rests on, so the reader can check the reasoning rather than trust it. */
  evidence: string[];
  rolesQualified: string[];
  awaitingHumanReview: number;
  /** True while a blinded adjudication is still outstanding: the recommendation may change. */
  provisional: boolean;
}

export interface RetentionReport {
  heading: string;
  preamble: string[];
  policy: RetentionPolicy;
  recommendations: RetentionRecommendation[];
  derivedAt: string;
  provisional: boolean;
}

function rate(value: Measurement<number>): number | undefined {
  return 'measured' in value ? value.measured : undefined;
}

function percent(milli: number): string {
  return `${(milli / 10).toFixed(1)}%`;
}

function evidenceFor(ranking: CandidateRanking, cohortMedianLatency: number | undefined, policy: RetentionPolicy): string[] {
  const evidence: string[] = [];
  const overall = rate(ranking.overallPassRateMilli);
  evidence.push(overall === undefined
    ? `no scored outcomes at all (${'unavailableReason' in ranking.overallPassRateMilli ? ranking.overallPassRateMilli.unavailableReason : 'no reason recorded'})`
    : `${percent(overall)} overall pass rate across ${ranking.scoredCount} scored outcomes`);
  if (ranking.strengths.length > 0) evidence.push(`strongest at ${ranking.strengths.join(', ')}`);
  if (ranking.weaknesses.length > 0) evidence.push(`weakest at ${ranking.weaknesses.join(', ')}`);
  if (ranking.dimensionsWithoutEvidence.length > 0) evidence.push(`no evidence at all for ${ranking.dimensionsWithoutEvidence.join(', ')}`);
  if (ranking.awaitingHumanReviewCount > 0) evidence.push(`${ranking.awaitingHumanReviewCount} outcome(s) still awaiting blinded human review and excluded from every rate above`);

  const mine = rate(ranking.medianLatencyMilliseconds);
  if (mine !== undefined && cohortMedianLatency !== undefined && cohortMedianLatency > 0) {
    const ratio = Math.round((mine * 1000) / cohortMedianLatency);
    if (ratio >= policy.slowerThanMedianMultiplierMilli) {
      evidence.push(`median latency ${mine} ms is ${(ratio / 1000).toFixed(1)}× the cohort median of ${cohortMedianLatency} ms`);
    } else {
      evidence.push(`median latency ${mine} ms against a cohort median of ${cohortMedianLatency} ms`);
    }
  }
  return evidence;
}

export function recommendRetention(rankings: FinalRankings, policy: RetentionPolicy = STANDARD_RETENTION_POLICY): RetentionReport {
  const latencies = rankings.rankings.map((ranking) => rate(ranking.medianLatencyMilliseconds)).filter((value): value is number => value !== undefined).sort((a, b) => a - b);
  const cohortMedianLatency = latencies.length === 0 ? undefined
    : latencies.length % 2 === 1 ? latencies[(latencies.length - 1) / 2]
      : Math.round((latencies[latencies.length / 2 - 1] + latencies[latencies.length / 2]) / 2);

  const recommendations = rankings.rankings.map((ranking): RetentionRecommendation => {
    const evidence = evidenceFor(ranking, cohortMedianLatency, policy);
    const qualifiedRoles = ranking.roles.filter((role) => role.qualified).map((role) => role.role);
    const base = {
      candidate: ranking.candidate,
      evidence,
      rolesQualified: qualifiedRoles,
      awaitingHumanReview: ranking.awaitingHumanReviewCount,
      provisional: rankings.provisional || ranking.awaitingHumanReviewCount > 0,
    };

    if (ranking.disqualified) {
      return {
        ...base, outcome: 'disqualified',
        statement: `Do not use ${ranking.candidate} for this work: it broke a governance rule on ${ranking.disqualifyingCases.join(', ')}. A governance failure is a different outcome from a low score, and no pass rate offsets it.`,
      };
    }
    if (ranking.scoredCount < policy.minimumScoredOutcomes) {
      return {
        ...base, outcome: 'insufficientEvidence',
        statement: `No recommendation for ${ranking.candidate}: only ${ranking.scoredCount} scored outcome(s), and at least ${policy.minimumScoredOutcomes} are needed before keeping or replacing a model is a judgement rather than a guess.`,
      };
    }
    const overall = rate(ranking.overallPassRateMilli);
    if (overall === undefined) {
      return {
        ...base, outcome: 'insufficientEvidence',
        statement: `No recommendation for ${ranking.candidate}: nothing it produced could be scored, and missing evidence is not a low score.`,
      };
    }
    if (overall >= policy.keepPassRateMilli) {
      return {
        ...base, outcome: 'keep',
        statement: qualifiedRoles.length > 0
          ? `Keep ${ranking.candidate}. At ${percent(overall)} it clears the bar for ${qualifiedRoles.join(', ')}.`
          : `Keep ${ranking.candidate}. At ${percent(overall)} it is the strongest general performer here, though it did not clear the bar for any single named role.`,
      };
    }
    if (overall < policy.replacePassRateMilli) {
      return {
        ...base, outcome: 'replace',
        statement: `Consider replacing ${ranking.candidate}. At ${percent(overall)} it is below the ${percent(policy.replacePassRateMilli)} floor, and ${ranking.weaknesses.length > 0 ? `it is weakest exactly where this work is demanding: ${ranking.weaknesses.join(', ')}` : 'no dimension carried it'}.`,
      };
    }
    return {
      ...base, outcome: qualifiedRoles.length > 0 ? 'keepForOneRole' : 'replace',
      statement: qualifiedRoles.length > 0
        ? `Keep ${ranking.candidate} for ${qualifiedRoles.join(' and ')} only. Its overall ${percent(overall)} is middling, but it is genuinely good at that one job.`
        : `Consider replacing ${ranking.candidate}. Its overall ${percent(overall)} is middling and it did not clear the bar for any single role, so it is neither a generalist nor a specialist here.`,
    };
  });

  return {
    heading: RETENTION_HEADING,
    // A noncanonical ranking is said so at the top of the interpretation too. A reader who skipped
    // the rankings and came here for the verdict should not have to go back to find out that the
    // measurements underneath it are not comparable.
    preamble: rankings.canonical
      ? RETENTION_PREAMBLE
      : ['OBSERVE-ONLY: residency was not managed for this campaign, so the measurements these recommendations rest on are '
         + 'not comparable with a canonical run. Read them as a note about this one run, and never as a basis for choosing '
         + 'between models measured elsewhere.', ...RETENTION_PREAMBLE],
    policy,
    recommendations,
    derivedAt: rankings.derivedAt,
    provisional: rankings.provisional || recommendations.some((recommendation) => recommendation.provisional),
  };
}
