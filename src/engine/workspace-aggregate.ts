// Benchmark engine · combining the durable records of a comparative workspace matrix into one row
// per `provider:model` × case, without inventing a winner and without inventing a number.
//
// WHAT THIS IS FOR. A matrix produces N independent records per cell — three of them, for the
// foundation pack — each sealed in its own directory with its own manifest and its own ledger. That
// is the right shape for evidence and the wrong shape for reading: nobody can hold forty-eight
// directories in their head. This folds them into one row per cell, and it is the only place in the
// engine that does.
//
// THREE RULES, DECIDED BEFORE THE FIRST MATRIX RAN.
//
//   1  NO COMPOSITE OF COMPOSITES, AND NO LEAGUE TABLE. There is deliberately no overall "score"
//      across cases, and no ordering of candidates. `WorkspaceScorecard.compositeMilli` already
//      weighs the dimensions WITHIN one case, under weights that case froze; averaging four cases'
//      composites into one number would weigh the CASES against each other under weights nobody
//      declared, and the resulting figure would hide exactly the thing a four-case pack exists to
//      show — that a model can be excellent at a one-line fix and poor at a three-layer change.
//      Every dimension is published; the reader does the ranking.
//
//   2  A MISSING NUMBER IS NEVER A ZERO, AND NEVER SILENTLY DROPPED. Every figure is a `Quantity`
//      carrying its provenance, every mean and median comes from `sumQuantities`/`medianQuantity`
//      which refuse to average around an `unavailable` term, and a rate with nothing in its
//      denominator is `unavailable` WITH A REASON. `aggregateWorkspaceRuns` does not own a second
//      opinion about any of this: the token, cost, allowance and timing columns are produced by
//      `attemptMetricsFromRow` and `aggregateCandidateMetrics`, the same two functions the prose
//      side has used since Pass 3, applied to one cell instead of one candidate.
//
//   3  A RUN THE HARNESS BROKE IS NOT A FAILURE OF THE MODEL. A `runtimeError`, a `safetyAbort` or
//      an `envelopeFailure` measured the driver, the sandbox or the tool's availability — not the
//      work. Those rows leave the numerator AND the denominator of every quality rate and are
//      reported in their own count, exactly as `ranking.ts` rule 7 treats a provider refusal. They
//      stay in the ECONOMICS, because tokens spent on a run that broke were still spent. A
//      `timeout`, by contrast, IS a result: the model was given a deadline and did not finish.
//
// WHERE THE ROWS COME FROM. The ledger row, not the derived `workspace-record.json`. The record is
// a convenience derived from the row and says so; the row carries the verification outcomes, the
// per-metric readings and the scope assessment that half the columns below are computed from.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { CanonicalValue } from './canonical';
import { Ledger } from './ledger';
import {
  FrontierAttemptMetrics, FrontierCandidateMetrics, Provenance, Quantity, aggregateCandidateMetrics,
  attemptMetricsFromRow, measuredQuantity, unavailableQuantity, worstProvenance,
} from './frontier-metrics';
import { WORKSPACE_REPEAT_IS_NOT_RETRY } from './workspace-pack';
import { workspaceRecordPaths, workspaceRecordRoot } from './workspace-campaign';

export class WorkspaceAggregateError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'WorkspaceAggregateError';
  }
}

/**
 * Statuses that measured the HARNESS rather than the model. Excluded from every quality rate.
 *
 * `timeout` is deliberately not here. A deadline that passed with work in flight is a fact about
 * the model's pace on this task, and a benchmark that excused it would rank a model that never
 * finishes above one that finishes badly.
 */
export const STATUSES_THAT_MEASURED_NO_WORK = ['runtimeError', 'safetyAbort', 'envelopeFailure'];

export const NO_QUALITY_DENOMINATOR =
  'no run of this cell measured the model\'s work — every one of them ended as a harness, driver or envelope fault. '
  + 'A rate with nothing in its denominator is unavailable rather than zero.';

// MARK: - One run, as the aggregate needs to see it

/**
 * One sealed workspace run, read back off disk.
 *
 * `row` is the ledger row verbatim and is the authority for everything below. `recordRoot` is
 * carried so a reader of an aggregate can go straight to the evidence a number came from.
 */
export interface WorkspaceRunRow {
  recordRoot: string;
  row: Record<string, unknown>;
}

const text = (row: Record<string, unknown>, key: string): string | undefined =>
  (typeof row[key] === 'string' ? row[key] as string : undefined);
const number = (row: Record<string, unknown>, key: string): number | undefined =>
  (typeof row[key] === 'number' ? row[key] as number : undefined);

/**
 * The terminal row of one workspace record.
 *
 * A workspace record holds exactly one slot and therefore at most one terminal row; a record whose
 * run was refused before it started has none, and `undefined` is the honest answer for it.
 */
export function readWorkspaceRunRow(recordRoot: string): WorkspaceRunRow | undefined {
  const paths = workspaceRecordPaths(recordRoot);
  if (!Ledger.exists(paths.ledger)) return undefined;
  const ledger = Ledger.open(paths.ledger);
  const [first] = [...ledger.results.values()];
  if (first === undefined) return undefined;
  return { recordRoot, row: first as unknown as Record<string, unknown> };
}

/**
 * Every workspace record under a campaign root, in directory order.
 *
 * Deliberately tolerant of a directory that is not a record — a half-written run, a directory
 * somebody made by hand — because refusing to report forty-seven good records because of one bad
 * one would make the aggregate less useful than the directory listing it replaced.
 */
export function collectWorkspaceRunRows(campaignRoot: string): WorkspaceRunRow[] {
  const root = workspaceRecordRoot(campaignRoot);
  if (!fs.existsSync(root)) return [];
  const rows: WorkspaceRunRow[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!entry.isDirectory()) continue;
    const found = readWorkspaceRunRow(path.join(root, entry.name));
    if (found !== undefined) rows.push(found);
  }
  return rows;
}

// MARK: - Spread

/**
 * The shape of a set of numbers, for the columns where the spread is the point.
 *
 * VARIANCE IS WHY REPEATS EXIST. A model that passes three times out of three and a model that
 * passes twice have the same mean on a two-value scale and are not the same model; a model whose
 * three runs took 40 s, 45 s and 400 s is not described by "162 s". So every numeric column that a
 * matrix repeats gets min, max, median and a spread beside its mean.
 *
 * INTEGER-SCALED, like every number in this engine, because `canonicalJSON` refuses a float: the
 * standard deviation is rounded to the unit of the values it was computed from, and `spread` is
 * simply max − min, which is the one dispersion figure that needs no rounding argument at all.
 */
export interface NumericSpread {
  count: number;
  minimum: Quantity;
  maximum: Quantity;
  mean: Quantity;
  median: Quantity;
  /** max − min. Exact, and the figure to read when there are three samples. */
  spread: Quantity;
  /** Population standard deviation, rounded to the values' own unit. */
  standardDeviation: Quantity;
}

export function spreadOf(quantities: Quantity[], unavailableReason: string): NumericSpread {
  const usable = quantities.filter((quantity) => quantity.provenance !== 'unavailable' && quantity.value !== undefined);
  if (usable.length === 0) {
    const nothing = unavailableQuantity(unavailableReason);
    return { count: 0, minimum: nothing, maximum: nothing, mean: nothing, median: nothing, spread: nothing, standardDeviation: nothing };
  }
  // The worst provenance of the terms, carried onto every figure derived from them: a median of
  // three provider-reported numbers is provider-reported, not measured.
  const provenance: Provenance = worstProvenance(usable);
  const values = usable.map((quantity) => quantity.value as number).sort((a, b) => a - b);
  const total = values.reduce((sum, value) => sum + value, 0);
  const mean = total / values.length;
  const middle = Math.floor(values.length / 2);
  const median = values.length % 2 === 1 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
  const variance = values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / values.length;
  const at = (value: number): Quantity => ({ provenance, value: Math.round(value) });

  // A single sample has no dispersion to report, and reporting zero would say the three runs agreed
  // when there were not three runs. Stated as unavailable with the reason.
  const oneSample = unavailableQuantity(
    'one run of this cell was recorded, so there is no spread to report. A zero here would claim that repeated runs '
    + 'agreed, and there were no repeated runs.');

  return {
    count: values.length,
    minimum: at(values[0]),
    maximum: at(values[values.length - 1]),
    mean: at(mean),
    median: at(median),
    spread: values.length === 1 ? oneSample : at(values[values.length - 1] - values[0]),
    standardDeviation: values.length === 1 ? oneSample : at(Math.sqrt(variance)),
  };
}

// MARK: - The aggregate

/** Every quality figure for one cell. Counts first, then rates derived from them. */
export interface WorkspaceQualityAggregate {
  /** Runs whose outcome was a reading of the model's work. The denominator of every rate here. */
  scoredRunCount: number;
  /** Runs excluded because a harness, driver or envelope fault measured no work. */
  notMeasuredRunCount: number;
  successCount: number;
  /** Passes reached without a retry. Counted over ALL scored runs, including one-attempt cases. */
  firstAttemptSuccessCount: number;
  /** Passes reached only after this engine's verification reported a failure. */
  recoverySuccessCount: number;
  /** Scored runs that used more than one attempt, whatever they ended as. The recovery denominator. */
  runsThatRetriedCount: number;

  successRateMilli: Quantity;
  firstAttemptSuccessRateMilli: Quantity;
  /** Of the runs that RETRIED, how many ended in a pass. Unavailable when none retried. */
  recoverySuccessRateMilli: Quantity;

  compositeMilli: NumericSpread;

  /** Checks that passed before the change and not after it, summed across the cell's runs. */
  regressionCount: number;
  /** Runs whose change went outside the paths the case declared, or ran an executable off the list. */
  scopeViolationRunCount: number;
  /** Runs whose patch carried no conflict markers or residue, over the runs where it was checked. */
  patchCleanRateMilli: Quantity;
  /** Required verification checks that passed, over every required check the cell's runs ran. */
  verificationPassRateMilli: Quantity;
  /** Every terminal status this cell produced, with how often. Nothing is merged into anything. */
  statusCounts: Record<string, number>;
}

/** One `provider:model` × case cell of a comparative matrix. */
export interface WorkspaceCellAggregate {
  candidate: string;
  provider: string;
  requestedModelID: string;
  executionClass: string;
  billingBasis: string;
  /** The weakest identity state any run of this cell carried. An aggregate is only as attributable as its worst row. */
  bindingIdentityState: string;

  caseID: string;
  caseVersion: string;
  caseDigest: string;
  comparabilityKey: string;
  scoringPolicy: string;
  /** How many attempts the frozen case allows. The ceiling a retry is bounded by; never a repeat count. */
  caseMaximumAttempts: number;

  packID?: string;
  packVersion?: string;
  repeatGroupID?: string;
  /** How many independent runs the pack asked for. Absent when these runs were not planned as a set. */
  repeatsPlanned?: number;
  /** How many independent runs are actually in this aggregate. Less than planned means some are missing. */
  runCount: number;
  /** Where each run's evidence is. One entry per run, in the order they were combined. */
  recordRoots: string[];
  /** What a repeat is, and what it is not, carried on the row rather than left to a footnote. */
  repeatDisclosure: string;

  quality: WorkspaceQualityAggregate;

  /**
   * EVERY TOKEN, COST, ALLOWANCE AND TIMING COLUMN, from the engine's existing aggregator.
   *
   * `aggregateCandidateMetrics` is applied to this CELL's runs rather than to a candidate's whole
   * campaign — it takes a list of attempt metrics and a success count and knows nothing else, so
   * pointing it at four runs of one case is exactly as correct as pointing it at four hundred of
   * many. Reusing it is what keeps a workspace cost-per-success and a prose cost-per-success the
   * same arithmetic, including the rule that spend on failed runs counts toward it.
   */
  metrics: FrontierCandidateMetrics;

  /** The spread of the columns a reader actually compares across repeats. */
  wallClockMilliseconds: NumericSpread;
  totalTokens: NumericSpread;

  /** The worst provenance anywhere in this row. The honest quality of the aggregate. */
  measurementQuality: Provenance;
}

const rateMilli = (numerator: number, denominator: number, unavailableReason: string): Quantity =>
  (denominator === 0 ? unavailableQuantity(unavailableReason)
    : measuredQuantity(Math.round((numerator * 1000) / denominator)));

function quantityFromRow(row: Record<string, unknown>, key: string, unavailableReason: string): Quantity {
  const value = number(row, key);
  return value === undefined ? unavailableQuantity(unavailableReason) : measuredQuantity(value);
}

function compositeQuantity(row: Record<string, unknown>): Quantity {
  const value = number(row, 'compositeMilli');
  if (value !== undefined) return measuredQuantity(value);
  const reason = text(row, 'compositeUnavailableReason');
  return unavailableQuantity(reason ?? 'this run recorded no composite score');
}

interface CheckOutcome { required?: unknown; passed?: unknown }

function requiredCheckCounts(row: Record<string, unknown>): { passed: number; total: number } {
  const lists = [row.verificationOutcomes, row.hiddenOutcomes]
    .filter((value): value is CheckOutcome[] => Array.isArray(value));
  let passed = 0;
  let total = 0;
  for (const list of lists) {
    for (const outcome of list) {
      if (outcome.required !== true) continue;
      total += 1;
      if (outcome.passed === true) passed += 1;
    }
  }
  return { passed, total };
}

/** `metricsMilli.patchClean`, when the run was measurable enough to have one. */
function patchCleanReading(row: Record<string, unknown>): boolean | undefined {
  const metrics = row.metricsMilli as Record<string, { valueMilli?: unknown }> | undefined;
  const reading = metrics?.patchClean;
  return typeof reading?.valueMilli === 'number' ? reading.valueMilli >= 1000 : undefined;
}

/**
 * Fold the runs of a matrix into one row per `provider:model` × case.
 *
 * GROUPED BY CANDIDATE AND COMPARABILITY KEY, never by case id. `cwk1:` binds the fixture digest,
 * the scope, the tool policy, the environment allow-list, the attempt ceiling, every verification
 * command and the scoring policy — so two runs that share it ran the same experiment, and two runs
 * of "the same case id" across a fixture edit do not and must not land on one row.
 */
export function aggregateWorkspaceRuns(runs: WorkspaceRunRow[]): WorkspaceCellAggregate[] {
  const cells = new Map<string, WorkspaceRunRow[]>();
  for (const run of runs) {
    const candidate = text(run.row, 'candidate');
    const comparabilityKey = text(run.row, 'comparabilityKey');
    if (candidate === undefined || comparabilityKey === undefined) continue;
    const key = `${candidate}\u0000${comparabilityKey}`;
    cells.set(key, [...(cells.get(key) ?? []), run]);
  }
  return [...cells.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([, members]) => aggregateWorkspaceCell(members));
}

export function aggregateWorkspaceCell(runs: WorkspaceRunRow[]): WorkspaceCellAggregate {
  if (runs.length === 0) {
    throw new WorkspaceAggregateError('emptyCell',
      'a cell with no runs in it is not an aggregate of anything. Leave it out rather than publishing an empty row.');
  }
  // Ordered by which repeat they are, so `recordRoots` reads in the order the matrix planned them
  // rather than in whatever order a directory listing produced.
  const ordered = [...runs].sort((a, b) =>
    (number(a.row, 'repeatIndex') ?? 0) - (number(b.row, 'repeatIndex') ?? 0));
  const rows = ordered.map((run) => run.row);
  const first = rows[0];

  const scored = rows.filter((row) => !STATUSES_THAT_MEASURED_NO_WORK.includes(String(row.status)));
  const notMeasured = rows.length - scored.length;
  const passes = scored.filter((row) => row.status === 'pass');
  const firstAttemptPasses = passes.filter((row) => (number(row, 'attemptsUsed') ?? 1) <= 1);
  const recoveries = passes.filter((row) => (number(row, 'attemptsUsed') ?? 1) > 1);
  const retried = scored.filter((row) => (number(row, 'attemptsUsed') ?? 1) > 1);

  const statusCounts: Record<string, number> = {};
  for (const row of rows) {
    const status = String(row.status);
    statusCounts[status] = (statusCounts[status] ?? 0) + 1;
  }

  const checks = scored.map(requiredCheckCounts);
  const checksPassed = checks.reduce((sum, entry) => sum + entry.passed, 0);
  const checksTotal = checks.reduce((sum, entry) => sum + entry.total, 0);

  const patchReadings = scored.map(patchCleanReading).filter((reading): reading is boolean => reading !== undefined);

  const quality: WorkspaceQualityAggregate = {
    scoredRunCount: scored.length,
    notMeasuredRunCount: notMeasured,
    successCount: passes.length,
    firstAttemptSuccessCount: firstAttemptPasses.length,
    recoverySuccessCount: recoveries.length,
    runsThatRetriedCount: retried.length,
    successRateMilli: rateMilli(passes.length, scored.length, NO_QUALITY_DENOMINATOR),
    firstAttemptSuccessRateMilli: rateMilli(firstAttemptPasses.length, scored.length, NO_QUALITY_DENOMINATOR),
    // THE DENOMINATOR IS THE RUNS THAT ACTUALLY RETRIED, not every run. A model that never needed a
    // second attempt has no recovery rate — not a perfect one and not a zero — because it was never
    // asked the question. This is the same rule `ranking.ts` applies to a dimension with no evidence.
    recoverySuccessRateMilli: rateMilli(recoveries.length, retried.length,
      'no run of this cell used a second attempt, so this model was never asked to recover from a reported failure. '
      + 'A recovery rate over nothing is unavailable, not zero and not perfect.'),
    compositeMilli: spreadOf(rows.map(compositeQuantity),
      'no run of this cell recorded a composite score'),
    regressionCount: scored.reduce((sum, row) => sum + (number(row, 'regressionCount') ?? 0), 0),
    scopeViolationRunCount: scored.filter((row) => row.scopeClean === false).length,
    patchCleanRateMilli: rateMilli(patchReadings.filter(Boolean).length, patchReadings.length,
      'no run of this cell reached the point where patch cleanliness was checked'),
    verificationPassRateMilli: rateMilli(checksPassed, checksTotal,
      'no run of this cell ran a required verification command, so there is no pass rate to compute'),
    statusCounts,
  };

  // The same reader every other surface uses, applied per run. An absence in a row stays an absence
  // here: `attemptMetricsFromRow` returns `unavailable` quantities rather than zeros.
  const attemptMetrics = rows
    .map((row) => attemptMetricsFromRow(row))
    .filter((metrics): metrics is FrontierAttemptMetrics => metrics !== undefined);
  const metrics = aggregateCandidateMetrics(text(first, 'candidate') ?? '', attemptMetrics, passes.length);

  const wallClock = spreadOf(rows.map((row) => quantityFromRow(row, 'wallClockMilliseconds',
    'this run recorded no wall-clock time')), 'no run of this cell recorded a wall-clock time');
  const totalTokens = spreadOf(attemptMetrics.map((entry) => entry.totalTokens),
    'no run of this cell carried a provider-reported token count');

  const repeatsPlanned = number(first, 'repeatsPlanned');

  return {
    candidate: text(first, 'candidate') ?? '',
    provider: text(first, 'provider') ?? 'unknown',
    requestedModelID: text(first, 'requestedModelID') ?? '',
    executionClass: text(first, 'executionClass') ?? 'unknown',
    billingBasis: text(first, 'billingBasis') ?? 'unknown',
    // The weakest, not the first. One run admitted under an identity nobody established makes the
    // whole cell's average an average over an answer nobody can attribute.
    bindingIdentityState: rows.some((row) => text(row, 'bindingIdentityState') !== 'verified')
      ? (rows.map((row) => text(row, 'bindingIdentityState')).find((state) => state !== 'verified') ?? 'verified')
      : 'verified',

    caseID: text(first, 'caseID') ?? '',
    caseVersion: text(first, 'caseVersion') ?? '',
    caseDigest: text(first, 'caseDigest') ?? '',
    comparabilityKey: text(first, 'comparabilityKey') ?? '',
    scoringPolicy: `${text(first, 'scoringPolicyID') ?? ''}@${text(first, 'scoringPolicyVersion') ?? ''}`,
    caseMaximumAttempts: number(first, 'caseMaximumAttempts') ?? 1,

    packID: text(first, 'packID'),
    packVersion: text(first, 'packVersion'),
    repeatGroupID: text(first, 'repeatGroupID'),
    repeatsPlanned,
    runCount: rows.length,
    recordRoots: ordered.map((run) => run.recordRoot),
    repeatDisclosure: WORKSPACE_REPEAT_IS_NOT_RETRY,

    quality,
    metrics,
    wallClockMilliseconds: wallClock,
    totalTokens,
    measurementQuality: worstProvenance([
      metrics.inputTokens, metrics.visibleOutputTokens, metrics.costPerRunMicroUSD,
      quality.compositeMilli.mean,
    ]),
  };
}

/**
 * One line per cell, for a terminal table.
 *
 * Prints the success rate as a FRACTION rather than only as a percentage: "2/3" says how many runs
 * there were, and "66.7%" does not — which on a three-sample matrix is most of what a reader needs.
 */
export function describeWorkspaceCell(cell: WorkspaceCellAggregate): string {
  const composite = cell.quality.compositeMilli.median.value;
  const allowance = cell.metrics.subscriptionIncludedUsageMicroUSD.value;
  return [
    cell.candidate.padEnd(30),
    cell.caseID.padEnd(30),
    `${cell.quality.successCount}/${cell.quality.scoredRunCount}`.padStart(6),
    (composite === undefined ? 'no score' : `${(composite / 10).toFixed(1)}%`).padStart(9),
    (cell.wallClockMilliseconds.median.value === undefined ? 'no time'
      : `${Math.round(cell.wallClockMilliseconds.median.value / 1000)}s`).padStart(7),
    (cell.billingBasis === 'subscriptionIncluded'
      ? (allowance === undefined ? 'allowance unknown' : `$${(allowance / 1_000_000).toFixed(4)} allow.`)
      : (cell.metrics.costPerRunMicroUSD.value === undefined ? 'cost unknown'
        : `$${(cell.metrics.costPerRunMicroUSD.value / 1_000_000).toFixed(4)}`)).padStart(18),
    cell.measurementQuality,
  ].join('  ').trimEnd();
}

/** The aggregate, as a canonical value a surface can write out beside the records it came from. */
export function workspaceCellAsCanonical(cell: WorkspaceCellAggregate): CanonicalValue {
  return cell as unknown as CanonicalValue;
}
