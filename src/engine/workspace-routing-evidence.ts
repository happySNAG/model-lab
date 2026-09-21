// Benchmark engine · what a matrix says when it is read BY DIFFICULTY and BY CAPABILITY.
//
// WHAT THIS IS FOR. A per-cell table answers "how did this model do on this case". The question
// behind the tiers is a different one — "how far up does this model go before it stops being
// reliable" — and answering it means grouping cells, which is exactly the operation this engine has
// so far refused to do. So the rules it is allowed to do it under are written down first, and every
// one of them is a rule `workspace-aggregate.ts` already lives by.
//
//   1  NO COMPOSITE IS AVERAGED ACROSS CASES. `compositeMilli` weighs the dimensions WITHIN one case
//      under weights that case froze. Averaging four cases' composites would weigh the CASES against
//      each other under weights nobody declared, and would hide the thing a four-case pack exists to
//      show. A tier row therefore carries SUCCESS COUNTS and rates derived from them — a count over
//      a count, which needs no weighting — and per-case detail. It carries no tier score.
//
//   2  THERE IS NO WINNER AND NO ORDER. Nothing here sorts candidates, and nothing here returns a
//      "best" anything. A reader ranks; this publishes.
//
//   3  UNAVAILABLE STAYS UNAVAILABLE. A rate with nothing in its denominator is unavailable WITH A
//      REASON, never zero. A tier a candidate has no runs at is absent from its rows, not present
//      with zeros — "did not attempt Tier 3" and "failed Tier 3" are different facts and a routing
//      decision made from the second when the first was true is a wrong decision.
//
//   4  A RUN THE HARNESS BROKE IS NOT A FAILURE OF THE MODEL. `notMeasuredRunCount` keeps them out
//      of both halves of every quality rate, exactly as the per-cell aggregate does, and reports
//      them in their own column so a reader can see how much of the matrix measured nothing.
//
// WHY CONSISTENCY IS A COLUMN AND NOT A FOOTNOTE. With three repeats per case, "passed" and "passed
// every time" are different claims, and the gap between them is the whole reason repeats exist. A
// model that passes a tier's four cases twelve times out of twelve and a model that passes seven of
// twelve with no case passing unanimously are not close, and a success rate alone puts them within
// sight of each other. `unanimousCaseCount` is how many of the tier's cases every repeat agreed
// about, in either direction.
//
// WHAT THIS DELIBERATELY DOES NOT DO. It does not route. There is no policy here, no threshold
// baked in, no "use the cheaper model until…" rule and nothing that selects a model for a case.
// `observedAdequacy` answers a threshold QUESTION a caller asks — with the evidence attached and a
// plain statement when the sample is too small to answer — and it is a function of numbers a caller
// supplies, not a decision this file makes. A tier is a property of the task and never a routing
// hint; `WORKSPACE_TIER_IS_A_PROPERTY_OF_THE_TASK` travels on every row here saying so.

import {
  Quantity, measuredQuantity, sumQuantities, unavailableQuantity,
} from './frontier-metrics';
import { NumericSpread, WorkspaceCellAggregate, spreadOf } from './workspace-aggregate';
import { WorkspaceCase, WorkspaceDimension } from './workspace-case';
import {
  WORKSPACE_TIER_IS_A_PROPERTY_OF_THE_TASK, WorkspaceDifficultyProfile, WorkspaceDifficultyTier,
  workspaceDifficultyProfileFor,
} from './workspace-difficulty';

/** Carried on every row, so a reader meeting one cannot read it as a score. */
export const WORKSPACE_TIER_EVIDENCE_IS_NOT_A_SCORE =
  'A tier row reports COUNTS and rates derived from them, never an average of per-case composites: a composite '
  + 'weighs the dimensions inside ONE case under weights that case froze, and averaging four of them would weigh the '
  + 'cases against each other under weights nobody declared. There is no tier score, no ordering of candidates and no '
  + 'overall winner in this file. A rate with an empty denominator is unavailable with a reason, and a tier a '
  + 'candidate never ran is absent rather than zero.';

const rateMilli = (numerator: number, denominator: number, unavailableReason: string): Quantity =>
  (denominator === 0 ? unavailableQuantity(unavailableReason) : measuredQuantity(Math.round((numerator * 1000) / denominator)));

// MARK: - By difficulty tier

/** One case's contribution to a tier row, kept so the row can never hide which case carried it. */
export interface WorkspaceTierCaseOutcome {
  caseID: string;
  caseVersion: string;
  scoredRunCount: number;
  notMeasuredRunCount: number;
  successCount: number;
  /** True when every scored run of this case agreed — all passed, or all failed. */
  unanimous: boolean;
  /** `undefined` when nothing was scored: a case with no scored run agreed about nothing. */
  passedEveryTime?: boolean;
}

/** One candidate at one difficulty tier. */
export interface WorkspaceTierEvidence {
  candidate: string;
  provider: string;
  requestedModelID: string;
  tier: WorkspaceDifficultyTier;
  /** The packs whose cells fed this row. Usually one; more than one when tables were combined. */
  packs: string[];

  caseCount: number;
  /** Runs whose outcome was a reading of the model's work. The denominator of every rate below. */
  scoredRunCount: number;
  /** Runs excluded because a harness, driver or envelope fault measured no work. */
  notMeasuredRunCount: number;
  successCount: number;

  successRateMilli: Quantity;
  firstAttemptSuccessRateMilli: Quantity;
  /** Over the runs that RETRIED. Unavailable when none did — not zero. */
  recoverySuccessRateMilli: Quantity;

  /** Cases every scored run passed. The strongest claim this row can make. */
  casesPassedEveryTime: number;
  /** Cases some runs passed and others did not. The variance a single sample would have hidden. */
  casesPassedSometimes: number;
  /** Cases no scored run passed. */
  casesNeverPassed: number;
  /** Cases every scored run agreed about, in either direction. */
  unanimousCaseCount: number;
  consistencyRateMilli: Quantity;

  /** Model wall clock across every scored run at this tier. */
  wallClockMilliseconds: NumericSpread;
  /** Provider-reported tokens across every run at this tier, including the ones that measured nothing. */
  totalTokens: Quantity;
  /** Subscription allowance consumed at this tier. Unavailable when no run reported any. */
  allowanceMicroUSD: Quantity;
  /** What the runs at this tier actually cost the user. Zero for a subscription CLI, and it says so. */
  effectiveUserCostMicroUSD: Quantity;

  perCase: WorkspaceTierCaseOutcome[];
  tierDisclosure: string;
  evidenceDisclosure: string;
}

/**
 * Group a matrix's cells by candidate and tier.
 *
 * A CELL WITH NO PROFILE IS LEFT OUT, not filed under a default. A tier row is a claim about
 * difficulty, and a cell nobody judged the difficulty of would make that claim on evidence that does
 * not exist.
 */
export function workspaceTierEvidence(
  cells: WorkspaceCellAggregate[], profiles: WorkspaceDifficultyProfile[],
): WorkspaceTierEvidence[] {
  const groups = new Map<string, { tier: WorkspaceDifficultyTier; cells: WorkspaceCellAggregate[] }>();
  for (const cell of cells) {
    const profile = workspaceDifficultyProfileFor(profiles, cell.caseID);
    if (profile === undefined) continue;
    const key = `${cell.candidate}\u0000${profile.tier}`;
    const found = groups.get(key);
    if (found === undefined) groups.set(key, { tier: profile.tier, cells: [cell] });
    else found.cells.push(cell);
  }

  return [...groups.values()].map(({ tier, cells: group }) => {
    const first = group[0];
    const scoredRunCount = group.reduce((sum, cell) => sum + cell.quality.scoredRunCount, 0);
    const notMeasuredRunCount = group.reduce((sum, cell) => sum + cell.quality.notMeasuredRunCount, 0);
    const successCount = group.reduce((sum, cell) => sum + cell.quality.successCount, 0);
    const firstAttemptSuccessCount = group.reduce((sum, cell) => sum + cell.quality.firstAttemptSuccessCount, 0);
    const recoverySuccessCount = group.reduce((sum, cell) => sum + cell.quality.recoverySuccessCount, 0);
    const runsThatRetriedCount = group.reduce((sum, cell) => sum + cell.quality.runsThatRetriedCount, 0);

    const perCase: WorkspaceTierCaseOutcome[] = group.map((cell) => {
      const scored = cell.quality.scoredRunCount;
      const passed = cell.quality.successCount;
      return {
        caseID: cell.caseID,
        caseVersion: cell.caseVersion,
        scoredRunCount: scored,
        notMeasuredRunCount: cell.quality.notMeasuredRunCount,
        successCount: passed,
        unanimous: scored > 0 && (passed === scored || passed === 0),
        passedEveryTime: scored === 0 ? undefined : passed === scored,
      };
    }).sort((a, b) => (a.caseID < b.caseID ? -1 : a.caseID > b.caseID ? 1 : 0));

    const casesWithAScoredRun = perCase.filter((entry) => entry.scoredRunCount > 0);
    const casesPassedEveryTime = casesWithAScoredRun.filter((entry) => entry.passedEveryTime === true).length;
    const casesNeverPassed = casesWithAScoredRun.filter((entry) => entry.successCount === 0).length;
    const unanimousCaseCount = casesWithAScoredRun.filter((entry) => entry.unanimous).length;

    return {
      candidate: first.candidate,
      provider: first.provider,
      requestedModelID: first.requestedModelID,
      tier,
      packs: [...new Set(group.map((cell) => (cell.packID === undefined ? '(no pack)' : `${cell.packID}@${cell.packVersion ?? ''}`)))].sort(),

      caseCount: group.length,
      scoredRunCount,
      notMeasuredRunCount,
      successCount,

      successRateMilli: rateMilli(successCount, scoredRunCount,
        `no run of this candidate at ${tier} produced a scorable outcome, so there is no success rate to compute`),
      firstAttemptSuccessRateMilli: rateMilli(firstAttemptSuccessCount, scoredRunCount,
        `no run of this candidate at ${tier} produced a scorable outcome`),
      recoverySuccessRateMilli: rateMilli(recoverySuccessCount, runsThatRetriedCount,
        `no run of this candidate at ${tier} used a second attempt, so there is nothing to compute a recovery rate `
        + 'from. This is not a recovery rate of zero.'),

      casesPassedEveryTime,
      casesPassedSometimes: casesWithAScoredRun.length - casesPassedEveryTime - casesNeverPassed,
      casesNeverPassed,
      unanimousCaseCount,
      consistencyRateMilli: rateMilli(unanimousCaseCount, casesWithAScoredRun.length,
        `no case of this candidate at ${tier} has a scored run, so there is nothing for repeats to agree about`),

      wallClockMilliseconds: spreadOf(
        group.map((cell) => cell.wallClockMilliseconds.median),
        `no run of this candidate at ${tier} recorded model wall clock`),
      totalTokens: sumQuantities(group.map((cell) => cell.metrics.totalTokens),
        `no run of this candidate at ${tier} carried a provider-reported token count`),
      allowanceMicroUSD: sumQuantities(group.map((cell) => cell.metrics.subscriptionIncludedUsageMicroUSD),
        `no run of this candidate at ${tier} reported subscription allowance`),
      effectiveUserCostMicroUSD: sumQuantities(group.map((cell) => cell.metrics.effectiveUserCostMicroUSD),
        `no run of this candidate at ${tier} reported what it cost`),

      perCase,
      tierDisclosure: WORKSPACE_TIER_IS_A_PROPERTY_OF_THE_TASK,
      evidenceDisclosure: WORKSPACE_TIER_EVIDENCE_IS_NOT_A_SCORE,
    };
  });
}

// MARK: - By capability dimension

/**
 * One candidate on one capability dimension.
 *
 * A CASE COUNTS UNDER EVERY DIMENSION IT DECLARED, and therefore appears in several of these rows.
 * That is deliberate and is why there is no total across dimensions: the rows are VIEWS of the same
 * runs, not a partition of them, and adding them up would count a run once per dimension it happened
 * to exercise. `caseIDs` is on the row so a reader can see exactly which runs are behind a number
 * and can tell two dimensions that rest on the same three cases from two that do not.
 *
 * NOTHING IS MANUFACTURED. A dimension no case in the matrix declared produces no row at all, rather
 * than a row of zeros or a rate over an empty denominator.
 */
export interface WorkspaceCapabilityEvidence {
  candidate: string;
  provider: string;
  requestedModelID: string;
  dimension: WorkspaceDimension;
  /** The tiers the contributing cases sit at. A dimension read across tiers says so. */
  tiers: WorkspaceDifficultyTier[];
  caseIDs: string[];

  scoredRunCount: number;
  notMeasuredRunCount: number;
  successCount: number;
  successRateMilli: Quantity;
  casesPassedEveryTime: number;
  casesNeverPassed: number;

  evidenceDisclosure: string;
}

/**
 * Group a matrix's cells by candidate and capability dimension.
 *
 * `cases` is how a dimension is found: the dimensions are on the sealed CASE, not on the cell, and
 * reading them from anywhere else would let a surface decide after the fact what a case measured.
 */
export function workspaceCapabilityEvidence(
  cells: WorkspaceCellAggregate[], cases: WorkspaceCase[], profiles: WorkspaceDifficultyProfile[],
): WorkspaceCapabilityEvidence[] {
  const groups = new Map<string, { dimension: WorkspaceDimension; cells: WorkspaceCellAggregate[] }>();
  for (const cell of cells) {
    const c = cases.find((entry) => entry.id === cell.caseID);
    if (c === undefined) continue;
    for (const dimension of c.dimensions) {
      const key = `${cell.candidate}\u0000${dimension}`;
      const found = groups.get(key);
      if (found === undefined) groups.set(key, { dimension, cells: [cell] });
      else found.cells.push(cell);
    }
  }

  return [...groups.values()].map(({ dimension, cells: group }) => {
    const first = group[0];
    const scoredRunCount = group.reduce((sum, cell) => sum + cell.quality.scoredRunCount, 0);
    const successCount = group.reduce((sum, cell) => sum + cell.quality.successCount, 0);
    const withAScoredRun = group.filter((cell) => cell.quality.scoredRunCount > 0);
    return {
      candidate: first.candidate,
      provider: first.provider,
      requestedModelID: first.requestedModelID,
      dimension,
      tiers: [...new Set(group
        .map((cell) => workspaceDifficultyProfileFor(profiles, cell.caseID)?.tier)
        .filter((tier): tier is WorkspaceDifficultyTier => tier !== undefined))].sort(),
      caseIDs: [...new Set(group.map((cell) => cell.caseID))].sort(),

      scoredRunCount,
      notMeasuredRunCount: group.reduce((sum, cell) => sum + cell.quality.notMeasuredRunCount, 0),
      successCount,
      successRateMilli: rateMilli(successCount, scoredRunCount,
        `no run of this candidate on a case declaring ${dimension} produced a scorable outcome`),
      casesPassedEveryTime: withAScoredRun.filter((cell) => cell.quality.successCount === cell.quality.scoredRunCount).length,
      casesNeverPassed: withAScoredRun.filter((cell) => cell.quality.successCount === 0).length,

      evidenceDisclosure: WORKSPACE_TIER_EVIDENCE_IS_NOT_A_SCORE,
    };
  });
}

// MARK: - Asking a threshold question, without answering a routing question

/**
 * Whether an observed rate clears a threshold a CALLER named, and whether the sample can say.
 *
 * THIS IS NOT A ROUTING POLICY. It selects nothing, it names no model and it carries no threshold of
 * its own: a caller that wants to know "did this candidate pass at least 90% of Tier 2, over at
 * least nine runs" asks, and gets back the answer together with the evidence and — when the sample
 * is too small — a plain statement that the question cannot be answered yet rather than a `false`
 * that reads like a failure. `adequate: false` and `meets: false` are different findings and a
 * caller that treated them alike would be routing on absence of evidence.
 */
export interface WorkspaceObservedAdequacy {
  candidate: string;
  tier: WorkspaceDifficultyTier;
  minimumSuccessRateMilli: number;
  minimumScoredRunCount: number;
  observedSuccessRateMilli: Quantity;
  scoredRunCount: number;
  /** Whether there are enough scored runs for the question to have an answer. */
  adequate: boolean;
  /** `undefined` when the sample is not adequate. Never `false` for want of evidence. */
  meets?: boolean;
  statement: string;
}

export function observedAdequacy(
  evidence: WorkspaceTierEvidence,
  question: { minimumSuccessRateMilli: number; minimumScoredRunCount: number },
): WorkspaceObservedAdequacy {
  const observed = evidence.successRateMilli;
  const adequate = evidence.scoredRunCount >= question.minimumScoredRunCount && observed.value !== undefined;
  const meets = adequate ? (observed.value as number) >= question.minimumSuccessRateMilli : undefined;
  const statement = adequate
    ? `${evidence.candidate} passed ${evidence.successCount} of ${evidence.scoredRunCount} scored runs at `
      + `${evidence.tier} (${((observed.value as number) / 10).toFixed(1)}%), which ${meets ? 'meets' : 'does not meet'} `
      + `the ${(question.minimumSuccessRateMilli / 10).toFixed(1)}% this question asked about.`
    : `${evidence.candidate} has ${evidence.scoredRunCount} scored run(s) at ${evidence.tier} and this question asks `
      + `for at least ${question.minimumScoredRunCount}. The question has no answer yet — which is not the same `
      + 'finding as a candidate that fell below the rate.';
  return {
    candidate: evidence.candidate,
    tier: evidence.tier,
    minimumSuccessRateMilli: question.minimumSuccessRateMilli,
    minimumScoredRunCount: question.minimumScoredRunCount,
    observedSuccessRateMilli: observed,
    scoredRunCount: evidence.scoredRunCount,
    adequate,
    meets,
    statement,
  };
}

// MARK: - Printing

/** One line per candidate per tier. Fractions, not only percentages — see `describeWorkspaceCell`. */
export function describeWorkspaceTierEvidence(evidence: WorkspaceTierEvidence): string {
  const rate = evidence.successRateMilli.value;
  const wall = evidence.wallClockMilliseconds.median.value;
  const allowance = evidence.allowanceMicroUSD.value;
  return [
    evidence.candidate.padEnd(30),
    evidence.tier.padEnd(6),
    `${evidence.successCount}/${evidence.scoredRunCount}`.padStart(7),
    (rate === undefined ? 'no rate' : `${(rate / 10).toFixed(1)}%`).padStart(8),
    `${evidence.casesPassedEveryTime}/${evidence.caseCount} cases clean`.padStart(18),
    `${evidence.unanimousCaseCount}/${evidence.caseCount} unanimous`.padStart(16),
    (wall === undefined ? 'no time' : `${Math.round(wall / 1000)}s med`).padStart(10),
    (allowance === undefined ? 'allowance unknown' : `$${(allowance / 1_000_000).toFixed(4)} allow.`).padStart(18),
    evidence.notMeasuredRunCount > 0 ? `${evidence.notMeasuredRunCount} not measured` : '',
  ].join('  ').trimEnd();
}

/** One line per candidate per capability dimension. */
export function describeWorkspaceCapabilityEvidence(evidence: WorkspaceCapabilityEvidence): string {
  const rate = evidence.successRateMilli.value;
  return [
    evidence.candidate.padEnd(30),
    evidence.dimension.padEnd(26),
    `${evidence.successCount}/${evidence.scoredRunCount}`.padStart(7),
    (rate === undefined ? 'no rate' : `${(rate / 10).toFixed(1)}%`).padStart(8),
    `over ${evidence.caseIDs.length} case(s) at ${evidence.tiers.join('+') || 'no tier'}`,
  ].join('  ').trimEnd();
}
