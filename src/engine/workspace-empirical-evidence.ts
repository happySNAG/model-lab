// Benchmark engine · what a campaign actually SHOWED, read from its sealed records after the fact.
//
// TWO READINGS, BOTH PASSIVE. Nothing here runs anything, changes anything or decides anything. It
// folds the per-cell aggregates `workspace-aggregate.ts` already produces — and, where a finer
// grain is needed, the ledger rows they came from — into two things a reader could not previously
// get without doing the arithmetic by hand.
//
// 1  RECOVERY, COUNTED WHERE IT HAPPENED. A case can be BUILT to observe recovery; a run only
//    EXERCISES it when its first attempt failed and a later attempt was actually made. Until this
//    pass the capability view counted case outcomes under the capability's name, so a tier matrix in
//    which every retry-capable case was passed first time printed "recoveryFromError 3/3" — three
//    first-time passes, presented as three recoveries. The recovery reading below counts
//    OPPORTUNITIES (runs whose first attempt failed and which made another), RECOVERIES and FAILED
//    RECOVERIES, computes a rate only over opportunities, and reports the reading as unavailable when
//    there were none. It is also TAG-INDEPENDENT: the one measured recovery in the whole Tier 1
//    matrix happened on `ws.broken-sum.mean`, which allows two attempts and does not declare
//    `recoveryFromError`, and a reading that looked only at tagged cases would have lost the only real
//    evidence there is. The capability rows still read tagged cases only, because a tag is what
//    a capability row is about; this reading is what recovery is about.
//
// 2  DISCRIMINATION, RELATIVE TO THE CANDIDATES THAT RAN. Per case: which candidates passed every
//    repeat, which failed every repeat, which split, which pairs that separates, and which failure
//    shapes candidates share. From that a case reads as saturated, failed by all, separating, split
//    or not yet readable — FOR THIS CANDIDATE SET, on this occasion. A case twelve-for-twelve today
//    is saturated for these four candidates and says nothing about the next four; a case one
//    candidate passes three times and three fail three times strongly separates THESE four, which is
//    not the same thing as being intrinsically hard. Every reading carries that sentence.
//
// WHAT THIS DELIBERATELY DOES NOT DO. There is no overall score, no ranking, no ordering of
// candidates, no "winner", and no weighting of one case against another — for the reasons
// `workspace-aggregate.ts` gives. A candidate's name is data carried through from the records; the
// engine never looks for, or treats specially, any particular one.

import { Quantity, measuredQuantity, unavailableQuantity } from './frontier-metrics';
import { WorkspaceCellAggregate, WorkspaceRunRow, STATUSES_THAT_MEASURED_NO_WORK } from './workspace-aggregate';
import { WORKSPACE_STRUCTURE_IS_NOT_DISCRIMINATION } from './workspace-discriminator';

/** Carried on every recovery reading, so a reader meeting one cannot mistake a tag for a measurement. */
export const WORKSPACE_RECOVERY_REQUIRES_A_FAILED_ATTEMPT =
  'Recovery is exercised only by a run whose first attempt FAILED and which then made another attempt after the '
  + 'engine\'s verification reported the failure. A pass on the first attempt — on any case, however it is tagged — '
  + 'is not evidence of recovery, and a case that allows one attempt can never produce any. The rate is taken over '
  + 'opportunities alone, and with no opportunity it is unavailable: not zero, and not perfect.';

/** Carried on every discrimination reading. */
export const WORKSPACE_DISCRIMINATION_IS_RELATIVE =
  'A discrimination reading describes how ONE SET OF CANDIDATES did on a case on one occasion. "Saturated" means '
  + 'every candidate in this set passed every repeat; "separating" means this set split into candidates that passed '
  + 'every repeat and candidates that failed every repeat. Neither is a property of the case alone, neither ranks '
  + 'candidates, and neither predicts how a different candidate will do. There is no overall score here.';

const rateMilli = (numerator: number, denominator: number, unavailableReason: string): Quantity =>
  (denominator === 0 ? unavailableQuantity(unavailableReason) : measuredQuantity(Math.round((numerator * 1000) / denominator)));

// MARK: - Recovery

export interface WorkspaceRecoveryCounts {
  /** Scored runs of cases that allow more than one attempt: the only runs recovery could ever appear in. */
  retryCapableScoredRunCount: number;
  /** Of those, passed on attempt 1. Successes — and, for recovery, exactly no evidence. */
  firstAttemptSuccessCount: number;
  /** Scored runs whose first attempt failed and which made another. THE denominator. */
  opportunityCount: number;
  /** Opportunities that ended in a pass. */
  recoveredCount: number;
  /** Opportunities that did not. */
  failedRecoveryCount: number;
  /**
   * Retry-capable runs whose first attempt failed and which made NO second attempt — an operator's
   * attempt cap, usually. Not an opportunity, and reported so the gap is visible rather than silent.
   */
  firstAttemptFailureWithoutRetryCount: number;
  /** `recoveredCount / opportunityCount`. Unavailable when there were no opportunities. */
  recoveryRateMilli: Quantity;
  /** True exactly when at least one opportunity occurred. */
  measured: boolean;
}

export function recoveryCountsOf(cells: WorkspaceCellAggregate[], noOpportunityReason: string): WorkspaceRecoveryCounts {
  const retryCapable = cells.filter((cell) => cell.caseMaximumAttempts > 1);
  const scored = retryCapable.reduce((sum, cell) => sum + cell.quality.scoredRunCount, 0);
  const firstAttempt = retryCapable.reduce((sum, cell) => sum + cell.quality.firstAttemptSuccessCount, 0);
  // Counted over EVERY cell, not only the retry-capable ones: a row that used a second attempt is an
  // opportunity whatever the case says, and a disagreement between the two would be a finding.
  const opportunities = cells.reduce((sum, cell) => sum + cell.quality.runsThatRetriedCount, 0);
  const recovered = cells.reduce((sum, cell) => sum + cell.quality.recoverySuccessCount, 0);
  return {
    retryCapableScoredRunCount: scored,
    firstAttemptSuccessCount: firstAttempt,
    opportunityCount: opportunities,
    recoveredCount: recovered,
    failedRecoveryCount: opportunities - recovered,
    firstAttemptFailureWithoutRetryCount: Math.max(0, scored - firstAttempt
      - retryCapable.reduce((sum, cell) => sum + cell.quality.runsThatRetriedCount, 0)),
    recoveryRateMilli: rateMilli(recovered, opportunities, noOpportunityReason),
    measured: opportunities > 0,
  };
}

/** One candidate's recovery evidence across every case it ran, whatever those cases are tagged. */
export interface WorkspaceRecoveryEvidence extends WorkspaceRecoveryCounts {
  candidate: string;
  provider: string;
  requestedModelID: string;
  /** Cases on which an opportunity actually occurred. The places a reader should look. */
  casesWithOpportunities: string[];
  /** Every retry-capable case this candidate ran, whether or not anything was retried on it. */
  retryCapableCases: string[];
  statement: string;
  disclosure: string;
}

export function workspaceRecoveryEvidence(cells: WorkspaceCellAggregate[]): WorkspaceRecoveryEvidence[] {
  const byCandidate = new Map<string, WorkspaceCellAggregate[]>();
  for (const cell of cells) byCandidate.set(cell.candidate, [...(byCandidate.get(cell.candidate) ?? []), cell]);
  return [...byCandidate.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([candidate, group]) => {
      const counts = recoveryCountsOf(group,
        `no run of ${candidate} failed its first attempt and then made another, so recovery was never exercised. `
        + 'This is not a recovery rate of zero, and it is not a perfect one.');
      const first = group[0];
      return {
        candidate,
        provider: first.provider,
        requestedModelID: first.requestedModelID,
        ...counts,
        casesWithOpportunities: [...new Set(group.filter((cell) => cell.quality.runsThatRetriedCount > 0)
          .map((cell) => cell.caseID))].sort(),
        retryCapableCases: [...new Set(group.filter((cell) => cell.caseMaximumAttempts > 1)
          .map((cell) => cell.caseID))].sort(),
        statement: counts.measured
          ? `${candidate}: ${counts.recoveredCount} of ${counts.opportunityCount} failed first attempt(s) recovered on a `
            + `later attempt (${counts.failedRecoveryCount} did not). Measured recovery.`
          : `${candidate}: recovery NOT MEASURED — ${counts.retryCapableScoredRunCount} retry-capable run(s), `
            + `${counts.firstAttemptSuccessCount} passed first time and none failed and retried.`,
        disclosure: WORKSPACE_RECOVERY_REQUIRES_A_FAILED_ATTEMPT,
      };
    });
}

export function describeWorkspaceRecoveryEvidence(evidence: WorkspaceRecoveryEvidence): string {
  const rate = evidence.recoveryRateMilli.value;
  return [
    evidence.candidate.padEnd(30),
    `${evidence.opportunityCount} opportunit${evidence.opportunityCount === 1 ? 'y' : 'ies'}`.padStart(16),
    `${evidence.recoveredCount} recovered`.padStart(12),
    `${evidence.failedRecoveryCount} failed`.padStart(9),
    `${evidence.firstAttemptSuccessCount}/${evidence.retryCapableScoredRunCount} retry-capable passed first time`.padStart(36),
    evidence.measured && rate !== undefined ? `rate ${(rate / 10).toFixed(1)}%` : 'rate UNAVAILABLE',
    evidence.casesWithOpportunities.length > 0 ? `on ${evidence.casesWithOpportunities.join(', ')}` : '',
  ].join('  ').trimEnd();
}

// MARK: - Discrimination

export type WorkspaceCandidateOutcomePattern = 'passedEveryRun' | 'failedEveryRun' | 'split' | 'notMeasured';

export type WorkspaceRepeatConsensus = 'unanimous' | 'split' | 'unavailable';

/** One failure shape — which checks failed and which invariants did not hold — and how often it occurred. */
export interface WorkspaceFailureSignatureCount {
  signature: string;
  runCount: number;
}

/** How one candidate did on one case, across its repeats. */
export interface WorkspaceCandidateCaseOutcome {
  candidate: string;
  scoredRunCount: number;
  notMeasuredRunCount: number;
  successCount: number;
  firstAttemptSuccessCount: number;
  recoveredCount: number;
  pattern: WorkspaceCandidateOutcomePattern;
  repeatConsensus: WorkspaceRepeatConsensus;
  /** Empty when no run rows were supplied, or when every scored run passed. */
  failureSignatures: WorkspaceFailureSignatureCount[];
}

export type WorkspaceCaseDiscriminationReading =
  /** Every candidate in the set passed every scored repeat. */
  | 'saturatedForThisCandidateSet'
  /** Every candidate in the set failed every scored repeat. */
  | 'failedByThisCandidateSet'
  /** Every candidate agreed with itself across repeats, and the set split both ways. */
  | 'separatesThisCandidateSet'
  /** At least one candidate's repeats disagreed. Variance is the finding. */
  | 'splitWithinCandidates'
  /** Fewer than two candidates have a scored run, so there is nothing to compare. */
  | 'insufficientEvidence';

/** A failure shape shared by several candidates — or, with one member, specific to one candidate. */
export interface WorkspaceFailureCluster {
  signature: string;
  candidates: string[];
  runCount: number;
  candidateSpecific: boolean;
}

export interface WorkspaceCaseDiscrimination {
  caseID: string;
  caseVersion: string;
  comparabilityKey: string;
  /** The candidates this reading is relative to. A reading means nothing without it. */
  candidateSet: string[];
  candidates: WorkspaceCandidateCaseOutcome[];
  reading: WorkspaceCaseDiscriminationReading;

  /** Capability boundary evidence, as lists: who passed every repeat, who failed every repeat, who split. */
  passedEveryRun: string[];
  failedEveryRun: string[];
  split: string[];
  notMeasured: string[];
  /** Pairs where one candidate passed every repeat and the other failed every repeat. */
  separatedPairs: { passedEveryRun: string; failedEveryRun: string }[];
  /** `separatedPairs.length`. Zero on a saturated case, and on one where nobody was consistent. */
  empiricalSeparationCount: number;
  /** Candidates whose repeats agreed with each other, in either direction. */
  repeatStableCandidateCount: number;
  failureClusters: WorkspaceFailureCluster[];

  statement: string;
  disclosure: string;
}

export interface WorkspaceEmpiricalDiscrimination {
  candidateSet: string[];
  cases: WorkspaceCaseDiscrimination[];
  summary: {
    caseCount: number;
    saturatedForThisCandidateSet: number;
    failedByThisCandidateSet: number;
    separatesThisCandidateSet: number;
    splitWithinCandidates: number;
    insufficientEvidence: number;
    /** Sum of separated pairs over cases. A count of observations, never a score of anybody. */
    totalSeparatedPairs: number;
  };
  disclosure: string;
  structureDisclosure: string;
}

/**
 * The shape of one failed run: which required checks failed and which invariants did not hold.
 * `undefined` for a pass, and for a run that measured no work.
 */
export function failureSignatureOf(row: Record<string, unknown>): string | undefined {
  if (row.status === 'pass' || STATUSES_THAT_MEASURED_NO_WORK.includes(String(row.status))) return undefined;
  const parts: string[] = [];
  for (const key of ['verificationOutcomes', 'hiddenOutcomes']) {
    const list = Array.isArray(row[key]) ? row[key] as Record<string, unknown>[] : [];
    for (const outcome of list) {
      if (outcome.required === true && outcome.passed !== true) parts.push(`check:${String(outcome.commandID)}`);
    }
  }
  const invariants = Array.isArray(row.invariantOutcomes) ? row.invariantOutcomes as Record<string, unknown>[] : [];
  for (const invariant of invariants) if (invariant.satisfied === false) parts.push(`invariant:${String(invariant.path)}`);
  if (row.scopeClean === false) parts.push('scope');
  if (row.timedOut === true) parts.push('timeout');
  return parts.length === 0 ? `status:${String(row.status)}` : parts.sort().join(' + ');
}

function patternOf(scored: number, passed: number): WorkspaceCandidateOutcomePattern {
  if (scored === 0) return 'notMeasured';
  if (passed === scored) return 'passedEveryRun';
  if (passed === 0) return 'failedEveryRun';
  return 'split';
}

/**
 * Read each case of a campaign against the candidates that ran it.
 *
 * `runs` is optional and only adds failure shapes; every other figure comes from the cells, so an
 * aggregate file with no records beside it can still be read. Cases are keyed by comparability key,
 * never by id alone, for the reason `aggregateWorkspaceRuns` gives.
 */
export function workspaceEmpiricalDiscrimination(
  cells: WorkspaceCellAggregate[], runs: WorkspaceRunRow[] = [],
): WorkspaceEmpiricalDiscrimination {
  const candidateSet = [...new Set(cells.map((cell) => cell.candidate))].sort();
  const byCase = new Map<string, WorkspaceCellAggregate[]>();
  for (const cell of cells) byCase.set(cell.comparabilityKey, [...(byCase.get(cell.comparabilityKey) ?? []), cell]);

  const cases: WorkspaceCaseDiscrimination[] = [...byCase.values()].map((group) => {
    const first = group[0];
    const candidates: WorkspaceCandidateCaseOutcome[] = group
      .sort((a, b) => (a.candidate < b.candidate ? -1 : a.candidate > b.candidate ? 1 : 0))
      .map((cell) => {
        const signatures = new Map<string, number>();
        for (const run of runs) {
          if (run.row.candidate !== cell.candidate || run.row.comparabilityKey !== cell.comparabilityKey) continue;
          const signature = failureSignatureOf(run.row);
          if (signature !== undefined) signatures.set(signature, (signatures.get(signature) ?? 0) + 1);
        }
        const pattern = patternOf(cell.quality.scoredRunCount, cell.quality.successCount);
        return {
          candidate: cell.candidate,
          scoredRunCount: cell.quality.scoredRunCount,
          notMeasuredRunCount: cell.quality.notMeasuredRunCount,
          successCount: cell.quality.successCount,
          firstAttemptSuccessCount: cell.quality.firstAttemptSuccessCount,
          recoveredCount: cell.quality.recoverySuccessCount,
          pattern,
          repeatConsensus: pattern === 'notMeasured' ? 'unavailable' : pattern === 'split' ? 'split' : 'unanimous',
          failureSignatures: [...signatures.entries()]
            .map(([signature, runCount]) => ({ signature, runCount }))
            .sort((a, b) => (a.signature < b.signature ? -1 : a.signature > b.signature ? 1 : 0)),
        };
      });

    const named = (pattern: WorkspaceCandidateOutcomePattern) =>
      candidates.filter((entry) => entry.pattern === pattern).map((entry) => entry.candidate);
    const passedEveryRun = named('passedEveryRun');
    const failedEveryRun = named('failedEveryRun');
    const split = named('split');
    const notMeasured = named('notMeasured');
    const measuredCount = candidates.length - notMeasured.length;

    const reading: WorkspaceCaseDiscriminationReading = measuredCount < 2 ? 'insufficientEvidence'
      : split.length > 0 ? 'splitWithinCandidates'
        : failedEveryRun.length === 0 ? 'saturatedForThisCandidateSet'
          : passedEveryRun.length === 0 ? 'failedByThisCandidateSet'
            : 'separatesThisCandidateSet';

    const separatedPairs = passedEveryRun.flatMap((passed) =>
      failedEveryRun.map((failed) => ({ passedEveryRun: passed, failedEveryRun: failed })));

    const clusterMap = new Map<string, { candidates: Set<string>; runCount: number }>();
    for (const entry of candidates) {
      for (const { signature, runCount } of entry.failureSignatures) {
        const found = clusterMap.get(signature) ?? { candidates: new Set<string>(), runCount: 0 };
        found.candidates.add(entry.candidate);
        found.runCount += runCount;
        clusterMap.set(signature, found);
      }
    }
    const failureClusters: WorkspaceFailureCluster[] = [...clusterMap.entries()]
      .map(([signature, found]) => ({
        signature,
        candidates: [...found.candidates].sort(),
        runCount: found.runCount,
        candidateSpecific: found.candidates.size === 1,
      }))
      .sort((a, b) => (a.signature < b.signature ? -1 : a.signature > b.signature ? 1 : 0));

    const set = candidates.map((entry) => entry.candidate);
    const statement = {
      saturatedForThisCandidateSet: `saturated for this candidate set: all ${measuredCount} candidates passed every scored `
        + 'repeat. It no longer separates these candidates; it says nothing about others.',
      failedByThisCandidateSet: `failed by this candidate set: all ${measuredCount} candidates failed every scored repeat.`,
      separatesThisCandidateSet: `separates this candidate set: ${passedEveryRun.length} passed every repeat, `
        + `${failedEveryRun.length} failed every repeat (${separatedPairs.length} separated pair(s)).`,
      splitWithinCandidates: `split within candidates: ${split.length} candidate(s) passed some repeats and failed others, `
        + 'so repeat variance is part of what this case shows.',
      insufficientEvidence: `insufficient evidence: ${measuredCount} candidate(s) with a scored run; a reading needs two.`,
    }[reading];

    return {
      caseID: first.caseID,
      caseVersion: first.caseVersion,
      comparabilityKey: first.comparabilityKey,
      candidateSet: set,
      candidates,
      reading,
      passedEveryRun,
      failedEveryRun,
      split,
      notMeasured,
      separatedPairs,
      empiricalSeparationCount: separatedPairs.length,
      repeatStableCandidateCount: passedEveryRun.length + failedEveryRun.length,
      failureClusters,
      statement,
      disclosure: WORKSPACE_DISCRIMINATION_IS_RELATIVE,
    };
  }).sort((a, b) => (a.caseID < b.caseID ? -1 : a.caseID > b.caseID ? 1 : 0));

  const count = (reading: WorkspaceCaseDiscriminationReading) => cases.filter((entry) => entry.reading === reading).length;
  return {
    candidateSet,
    cases,
    summary: {
      caseCount: cases.length,
      saturatedForThisCandidateSet: count('saturatedForThisCandidateSet'),
      failedByThisCandidateSet: count('failedByThisCandidateSet'),
      separatesThisCandidateSet: count('separatesThisCandidateSet'),
      splitWithinCandidates: count('splitWithinCandidates'),
      insufficientEvidence: count('insufficientEvidence'),
      totalSeparatedPairs: cases.reduce((sum, entry) => sum + entry.empiricalSeparationCount, 0),
    },
    disclosure: WORKSPACE_DISCRIMINATION_IS_RELATIVE,
    structureDisclosure: WORKSPACE_STRUCTURE_IS_NOT_DISCRIMINATION,
  };
}

/** Lines for a terminal: one per case, then one per candidate beneath it. No ordering of candidates. */
export function describeWorkspaceEmpiricalDiscrimination(discrimination: WorkspaceEmpiricalDiscrimination): string[] {
  const lines: string[] = [];
  for (const entry of discrimination.cases) {
    lines.push(`${entry.caseID.padEnd(34)} ${entry.reading}`);
    lines.push(`  ${entry.statement}`);
    for (const candidate of entry.candidates) {
      lines.push(`    ${candidate.candidate.padEnd(30)} ${`${candidate.successCount}/${candidate.scoredRunCount}`.padStart(5)}  `
        + `${candidate.pattern}${candidate.recoveredCount > 0 ? ` (${candidate.recoveredCount} by recovery)` : ''}`);
    }
    for (const cluster of entry.failureClusters) {
      lines.push(`    failure shape ${cluster.candidateSpecific ? '(one candidate)' : `(${cluster.candidates.length} candidates)`}: `
        + `${cluster.signature} — ${cluster.candidates.join(', ')} · ${cluster.runCount} run(s)`);
    }
  }
  const summary = discrimination.summary;
  lines.push(`${summary.caseCount} case(s) over ${discrimination.candidateSet.length} candidate(s): `
    + `${summary.saturatedForThisCandidateSet} saturated, ${summary.separatesThisCandidateSet} separating, `
    + `${summary.splitWithinCandidates} split, ${summary.failedByThisCandidateSet} failed by all, `
    + `${summary.insufficientEvidence} not yet readable.`);
  return lines;
}
