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
import { NOT_PROMOTABLE_BECAUSE } from './identity-admission';

export type RetentionOutcome =
  | 'keep' | 'keepForOneRole' | 'replace' | 'insufficientEvidence' | 'disqualified'
  /**
   * Measured, correctly, on too little of the plan to recommend anything. Distinct from
   * `insufficientEvidence`, which counts scored outcomes: this one is about the attempts that never
   * produced a scored outcome at all, and why — an exhausted allowance, a refused credential, a
   * failed transport. The difference matters to whoever has to decide what to do next: one of these
   * is fixed by running more cases, the other by fixing an account or a connection and re-running.
   */
  | 'evidenceIncomplete'
  /**
   * Measured in full, and no recommendation offered — because nothing established WHICH model
   * produced the measurements. Distinct from `insufficientEvidence`, which means there was not
   * enough data: here there is plenty of data about an answerer nobody can name.
   */
  | 'identityNeverEstablished';

export interface RetentionPolicy {
  /** A model at or above this overall pass rate earns an unqualified keep. */
  keepPassRateMilli: number;
  /** Below this, the recommendation is to replace it. */
  replacePassRateMilli: number;
  /** Fewer scored outcomes than this and no recommendation is offered at all. */
  minimumScoredOutcomes: number;
  /** A model this much slower than the cohort median is called out, whatever its quality. */
  slowerThanMedianMultiplierMilli: number;
  /**
   * Below this share of measured attempts, no recommendation is offered at all.
   *
   * AN EVIDENCE GATE, NOT A SCORING THRESHOLD. It moves no benchmark bar and changes no pass rate:
   * it decides only whether this module is willing to turn a rate into a sentence telling somebody
   * to keep or replace a model. Pass 11's broken candidate would otherwise have been recommended as
   * a `keep` at 94.4% — a figure computed correctly over eighteen of the eighty-eight attempts made
   * for it, and over none of the governance cases that disqualified every candidate beside it.
   * `minimumScoredOutcomes` cannot catch that: eighteen clears it.
   */
  minimumMeasuredCoverageMilli: number;
}

export const STANDARD_RETENTION_POLICY: RetentionPolicy = {
  keepPassRateMilli: 800,
  replacePassRateMilli: 600,
  minimumScoredOutcomes: 12,
  slowerThanMedianMultiplierMilli: 2_500,
  minimumMeasuredCoverageMilli: 750,
};

export const RETENTION_HEADING = 'Retention recommendations — INTERPRETATION, not measurement';

export const RETENTION_PREAMBLE = [
  'Everything above this heading is a measurement read off the ledger under rules fixed before the first request.',
  'Everything below it is a judgement about what these measurements mean for the work at hand, and a different owner with different work could reasonably reach a different one.',
  'No model is deleted by this engine. These are sentences to read, not actions taken.',
  'A candidate whose identity was never established gets no recommendation at all, however well it '
  + 'scored. Its measurements are above and they are real; what is missing is the name to attach them to.',
  'Neither does a candidate most of whose attempts produced no measurement. Its rate is right over what '
  + 'it answered, and it is not an answer to the question these recommendations ask, which is how a model '
  + 'behaves across the whole plan rather than across the part of it that got through.',
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
  // On EVERY candidate, not only the short ones. A coverage line that appears only when it is bad is
  // a line a reader has to know to miss, and its absence would then mean two different things.
  evidence.push(ranking.notMeasuredCount === 0
    ? `every one of ${ranking.attempts} attempt(s) produced a model evaluation`
    : `${ranking.notMeasuredCount} of ${ranking.attempts} attempt(s) produced no model evaluation and are in no rate above `
      + `(coverage ${percent(ranking.measuredCoverageMilli)})`);

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
    // Checked after disqualification and before everything else. A governance failure is a stronger
    // statement and stays sayable — "do not use this" needs no identity to be sound. Every branch
    // below this one, by contrast, ends in a sentence recommending a named model to somebody, and
    // this candidate has no established name to recommend.
    if (!ranking.promotable) {
      return {
        ...base, outcome: 'identityNeverEstablished',
        statement: `No retention recommendation for ${ranking.candidate}, and its measurements above stand: `
          + `${NOT_PROMOTABLE_BECAUSE} To turn these numbers into a decision, establish the identity first — `
          + 'then re-run, and the same measurements will carry a recommendation.',
      };
    }
    // BEFORE the scored-outcome count, because it is the stronger and more specific statement. A
    // candidate that answered eighteen of eighty-eight is not short of scored outcomes — it has
    // plenty — it is short of the plan those outcomes were supposed to cover.
    if (ranking.evidenceIncomplete || ranking.measuredCoverageMilli < policy.minimumMeasuredCoverageMilli) {
      return {
        ...base, outcome: 'evidenceIncomplete',
        // Always provisional: a coverage gap is a thing that can be closed by re-running, and the
        // recommendation withheld here is one a retest can supply.
        provisional: true,
        statement: `No recommendation for ${ranking.candidate}: ${ranking.notMeasuredCount} of its `
          + `${ranking.attempts} attempt(s) produced no model evaluation, so its rates rest on `
          + `${percent(ranking.measuredCoverageMilli)} of the plan and cover only the cases it reached. `
          + `${ranking.evidenceIncompleteBecause || 'The reliability block on its ranking row names what was lost.'} `
          + 'Nothing here is a judgement about the model: re-run the attempts that were never measured, '
          + 'and the same rules will produce a recommendation.',
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
