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

import { ADMISSION_STAMP_SHORT } from './identity-admission';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CanonicalValue } from './canonical';
import { Ledger } from './ledger';
import {
  FrontierAttemptMetrics, FrontierCandidateMetrics, Provenance, Quantity, aggregateCandidateMetrics,
  attemptMetricsFromRow, measuredQuantity, sumQuantities, unavailableQuantity, worstProvenance,
} from './frontier-metrics';
import { WORKSPACE_REPEAT_IS_NOT_RETRY } from './workspace-pack';
import { workspaceRecordPaths, workspaceRecordRoot } from './workspace-campaign';
import { EFFORT_VALIDITY_IS_NOT_QUALITY } from './workspace-effort-evidence';

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

/**
 * Why model timing must come from the SAME rows the quality rates come from.
 *
 * A run the provider declined has a wall clock and a first-byte time, and both are real
 * measurements — of how fast a 429 came back. The first sealed Claude matrix recorded forty-seven
 * of them, with first-byte times clustered around 500 ms and wall clocks around 2 s, and the
 * aggregate presented those as the cell's time-to-first-token and its median run duration. A reader
 * would have concluded that Opus answered a three-layer refactor in two seconds. Nothing was
 * fabricated and the number was still a lie, because the column's NAME claims it describes the
 * model.
 *
 * So the model-performance columns are computed over the rows that measured the model's work, and
 * the provider's own response times are kept — not discarded — in a separately named column that
 * says what it is.
 */
export const NO_MODEL_TIMING =
  'no run of this cell measured a model\'s execution: every one of them ended as a harness, driver or envelope fault, '
  + 'and on a provider decline the only interval there is to measure is how fast the provider refused. That is not '
  + 'this model\'s latency, so it is reported under operational timing instead and left unavailable here.';

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

/**
 * Timing, split by what it actually measured.
 *
 * Two families of number that a single "wall clock" column had been quietly mixing: how long the
 * MODEL took, and how long the PROVIDER took to answer at all. Both are kept.
 */
export interface WorkspaceEfficiencyAggregate {
  /** Runs whose timing describes a model doing work. The denominator of the model columns below. */
  modelTimedRunCount: number;
  /** Runs excluded from the model columns because a provider decline or a fault produced them. */
  nonModelTimedRunCount: number;
  /** Of those, the ones the provider itself declined — a rate limit or an expired session. */
  providerDeclinedRunCount: number;

  /** Milliseconds to the first visible output, over model-timed runs only. */
  modelTimeToFirstTokenMilliseconds: NumericSpread;
  /** Whole-run wall clock, over model-timed runs only. The figure a comparison may use. */
  modelWallClockMilliseconds: NumericSpread;

  /**
   * EVERY run's wall clock, declines and faults included. Operational, not comparative.
   *
   * Kept because the evidence is real and occasionally the question: how long the harness spent, or
   * how quickly a provider refused, is a fact about the run even though it says nothing about the
   * model. Never to be read as latency.
   */
  operationalWallClockMilliseconds: NumericSpread;
  /** Wall clock of the declined runs alone — how fast the provider said no. */
  providerDeclineWallClockMilliseconds: NumericSpread;
}

/**
 * RESOURCES SPENT ON EXECUTED WORK THAT PRODUCED NO SCORABLE OUTCOME.
 *
 * A DIFFERENT QUESTION FROM `wastedTokens`, WHICH KEEPS ITS MEANING. `FrontierAttemptMetrics.
 * wastedTokens` has meant one thing since Pass 3 — tokens spent INSIDE a run on attempts that did
 * not decide it, the cost of getting it wrong first — and redefining it would silently change every
 * prose figure that has ever been published under that name. So it stays exactly as it is, and the
 * thing it cannot express gets its own name here.
 *
 * WHAT IT CANNOT EXPRESS. In the first sealed Claude matrix, one Haiku run on `receipt-refunds`
 * spent 86,332 tokens and $0.032535 of plan allowance building a change, and was then cut off by
 * the session limit before verification could produce a result. It used ONE attempt, so nothing was
 * retried, so `wastedTokens` is 0 — correctly, under its own definition. And yet the matrix spent
 * 86,332 tokens on that cell and got no outcome from it. Both facts are true and only one of them
 * was reported.
 *
 * THE TWO ARE DISJOINT BY CONSTRUCTION, so they can be added. A run that produced a scorable
 * outcome contributes its intra-run retry waste to `retryWastedTokens` and nothing to
 * `unproductiveTokens`; a run that produced none contributes its WHOLE spend to `unproductiveTokens`
 * and nothing to `retryWastedTokens`. No token is counted under both, and `totalNonResultTokens` is
 * their sum, stated once so that nobody has to decide whether adding them is legitimate.
 */
export interface WorkspaceUnproductiveSpend {
  /** Executed runs that consumed resources and yielded no scorable quality outcome. */
  unproductiveRunCount: number;
  /** Of those, the ones the provider declined rather than the harness breaking. */
  providerDeclinedRunCount: number;
  /** Every token those runs consumed. Zero — truly — when there were no such runs. */
  unproductiveTokens: Quantity;
  /** Plan allowance those runs consumed, at the provider's list value, where it reported one. */
  unproductiveAllowanceMicroUSD: Quantity;
  /** Real money billed for those runs. A true zero on every subscription route. */
  unproductiveMarginalChargeMicroUSD: Quantity;

  /** Retry waste inside runs that DID produce an outcome. Disjoint from `unproductiveTokens`. */
  retryWastedTokens: Quantity;
  /** `unproductiveTokens + retryWastedTokens`. Safe to read as a total; nothing is double-counted. */
  totalNonResultTokens: Quantity;

  /** What each figure above means, carried on the row so it cannot be read under the wrong name. */
  definition: string;
}

export const UNPRODUCTIVE_SPEND_DEFINITION =
  'unproductiveTokens counts every token consumed by an EXECUTED run that yielded no scorable quality outcome — a '
  + 'provider decline, a harness fault or an envelope failure — whether or not that run retried. retryWastedTokens '
  + 'counts tokens spent on non-deciding attempts INSIDE runs that did yield an outcome. The two sets of runs are '
  + 'disjoint, so no token appears in both and their sum is a real total. A run that was never executed contributes '
  + 'nothing to either: no resources were spent on it.';

/** Identity confidence for one cell. Counted, never folded into a score. */
export interface WorkspaceCellIdentityProvenance {
  /** Runs whose pre-run identity was admitted as requestAcceptedIdentityUnverifiable rather than established. */
  admittedUnverifiableRunCount: number;
  /** `workspaceMatrix` for a matrix admission; absent entries for a single-record admission. */
  admissionScopes: string[];
  matrixAdmissionDigests: string[];
  matrixAdmissionEntryDigests: string[];
  /** Each per-record admission seal, one per admitted run. */
  recordAdmissionDigests: string[];
  /** How many runs ended with each execution identity verdict: unverifiable, substituted, verified… */
  executionIdentityVerdicts: Record<string, number>;
  /** Runs whose own execution reported another model (a Codex reroute). Each failed. */
  substitutedRunCount: number;
  /** The models those runs reported, distinct. Never a claim about which model answered the others. */
  reportedSubstitutes: string[];
  identityLimitation?: string;
  disclosure: string;
}

/**
 * Applied-effort validity for one cell. Counted beside the quality figures, never folded into them.
 *
 * A cell whose runs carry no applied-effort verdict has no such block — every Claude cell, and every
 * aggregate written before this existed, reads exactly as it did.
 */
export interface WorkspaceCellEffortProvenance {
  requestedEffort: string;
  /** How many runs ended with each verdict: appliedEffortVerified, appliedEffortMismatch, … */
  verdicts: Record<string, number>;
  /** Runs by the effort the telemetry measured; `unmeasured` and `mixed` are named, never folded. */
  appliedEffortDistribution: Record<string, number>;
  verifiedRunCount: number;
  mismatchRunCount: number;
  /** True only when every run of this cell verified the requested effort. */
  qualifiedForRequestedEffort: boolean;
  /** Runs that are NOT evidence for the requested effort. Their scores stay in the quality figures, labelled here. */
  mismatchedRecordRoots: string[];
  disclosure: string;
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
  /**
   * How attributable this cell's runs are, beside — never inside — its quality figures.
   *
   * PRESENT ONLY WHEN THERE IS SOMETHING TO SAY: a run admitted under an identity admission, or a run
   * whose own execution reported a different model. A cell of verified runs carries no such field, so
   * every aggregate that existed before admissions reads exactly as it did.
   */
  identityProvenance?: WorkspaceCellIdentityProvenance;
  /** Whether these runs ran at the requested effort, beside — never inside — the quality figures. */
  effortProvenance?: WorkspaceCellEffortProvenance;

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

  /** Timing, split by what it measured. Model columns and operational columns, never merged. */
  efficiency: WorkspaceEfficiencyAggregate;
  /** Resources spent on executed runs that produced no result. See `WorkspaceUnproductiveSpend`. */
  unproductiveSpend: WorkspaceUnproductiveSpend;

  /**
   * The spread of the columns a reader actually compares across repeats.
   *
   * `wallClockMilliseconds` is MODEL wall clock — the same values as
   * `efficiency.modelWallClockMilliseconds`, kept under the name every existing reader already uses,
   * and narrowed in this pass to exclude provider declines. `efficiency.operationalWallClock`
   * holds what it used to contain.
   */
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

/** Did this run measure a model doing work? The same test every quality rate's denominator uses. */
function measuredModelWork(row: Record<string, unknown>): boolean {
  return !STATUSES_THAT_MEASURED_NO_WORK.includes(String(row.status));
}

/**
 * Did the PROVIDER decline this run, rather than the harness breaking?
 *
 * Two independent spellings of the same fact are accepted because both are written by the engine
 * and a row from either era must read correctly: `providerThrottled` is the scorecard's own flag,
 * and `terminationReason: providerDeclined` is what `workspace-transcript.ts` records for the two
 * failure kinds that set it.
 */
function providerDeclined(row: Record<string, unknown>): boolean {
  return row.providerThrottled === true || text(row, 'terminationReason') === 'providerDeclined';
}

/**
 * Split this cell's timing into what measured a model and what measured a provider's refusal.
 *
 * Nothing is discarded and nothing becomes a zero: a run excluded from the model columns appears in
 * the operational ones, and a cell with no model-timed run at all reports its model columns as
 * unavailable WITH the reason rather than as an empty average.
 */
function efficiencyOf(rows: Record<string, unknown>[]): WorkspaceEfficiencyAggregate {
  const modelTimed = rows.filter(measuredModelWork);
  const declined = rows.filter((row) => !measuredModelWork(row) && providerDeclined(row));

  const wallOf = (list: Record<string, unknown>[]): Quantity[] => list.map((row) =>
    quantityFromRow(row, 'wallClockMilliseconds', 'this run recorded no wall-clock time'));
  const firstTokenOf = (list: Record<string, unknown>[]): Quantity[] => list.map((row) =>
    quantityFromRow(row, 'timeToFirstTokenMilliseconds', 'this run observed no first visible output'));

  return {
    modelTimedRunCount: modelTimed.length,
    nonModelTimedRunCount: rows.length - modelTimed.length,
    providerDeclinedRunCount: declined.length,
    modelTimeToFirstTokenMilliseconds: spreadOf(firstTokenOf(modelTimed), NO_MODEL_TIMING),
    modelWallClockMilliseconds: spreadOf(wallOf(modelTimed), NO_MODEL_TIMING),
    operationalWallClockMilliseconds: spreadOf(wallOf(rows),
      'no run of this cell recorded a wall-clock time'),
    providerDeclineWallClockMilliseconds: spreadOf(wallOf(declined),
      'no run of this cell was declined by the provider, so there is no decline latency to report'),
  };
}

/**
 * Resources this cell spent on executed runs that produced nothing scorable.
 *
 * THE DISJOINTNESS IS ENFORCED HERE, in two lines: `unproductive` is the runs that measured no
 * model work, `productive` is its complement, and the retry-waste sum is taken over the complement
 * alone. A run cannot contribute to both because a run cannot be in both sets.
 *
 * A TRUE ZERO IS ALLOWED, and only here. When no run of this cell was unproductive, the
 * unproductive spend really is zero — it is a count over an empty set, not a measurement that went
 * missing — so it is reported as a measured zero rather than as unavailable. When there ARE
 * unproductive runs and one of them reported no token count, `sumQuantities` makes the total
 * unavailable, which is the correct answer for a total that would otherwise be an undercount.
 */
function unproductiveSpendOf(rows: Record<string, unknown>[]): WorkspaceUnproductiveSpend {
  const unproductive = rows.filter((row) => !measuredModelWork(row));
  const productive = rows.filter(measuredModelWork);

  const metricsOf = (list: Record<string, unknown>[]): FrontierAttemptMetrics[] => list
    .map((row) => attemptMetricsFromRow(row))
    .filter((entry): entry is FrontierAttemptMetrics => entry !== undefined);

  const unproductiveMetrics = metricsOf(unproductive);
  const productiveMetrics = metricsOf(productive);

  const zeroBecauseNone = (what: string): Quantity => ({ provenance: 'measured', value: 0, note: what });

  /**
   * Sum over a set of runs, refusing to under-report one whose row could not be read at all.
   *
   * A row `attemptMetricsFromRow` rejected is not a row that spent nothing; it is a row nothing can
   * be said about. Summing the readable remainder would publish an undercount as a total.
   */
  const sumOver = (all: Record<string, unknown>[], readable: FrontierAttemptMetrics[],
                   pick: (entry: FrontierAttemptMetrics) => Quantity, noneNote: string,
                   missingNote: string): Quantity => {
    if (all.length === 0) return zeroBecauseNone(noneNote);
    if (readable.length !== all.length) return unavailableQuantity(missingNote);
    return sumQuantities(readable.map(pick), missingNote);
  };

  const unproductiveTokens = sumOver(unproductive, unproductiveMetrics, (entry) => entry.totalTokens,
    'every executed run of this cell produced a scorable outcome, so no tokens were spent without one',
    'at least one run of this cell produced no outcome AND reported no token count, so what it consumed is not '
    + 'known. It is not zero: the run executed.');

  const unproductiveAllowance = sumOver(unproductive, unproductiveMetrics,
    (entry) => entry.subscriptionIncludedUsageMicroUSD,
    'every executed run of this cell produced a scorable outcome, so no allowance was spent without one',
    'at least one run of this cell produced no outcome AND reported no allowance valuation, so what it consumed of '
    + 'the plan is not known. It is not zero.');

  const unproductiveCharge = sumOver(unproductive, unproductiveMetrics,
    (entry) => entry.marginalAPIChargeMicroUSD,
    'every executed run of this cell produced a scorable outcome, so nothing was billed without one',
    'at least one run of this cell produced no outcome AND has no marginal charge recorded');

  const retryWasted = sumOver(productive, productiveMetrics, (entry) => entry.wastedTokens,
    'no run of this cell produced a scorable outcome, so no run of it retried toward one',
    'at least one run of this cell that produced an outcome cannot say how many of its tokens went on '
    + 'non-deciding attempts');

  const total = unproductiveTokens.provenance === 'unavailable' || retryWasted.provenance === 'unavailable'
    ? unavailableQuantity('a total of non-result tokens needs both halves, and one of them is not known')
    : {
      provenance: worstProvenance([unproductiveTokens, retryWasted]),
      value: (unproductiveTokens.value ?? 0) + (retryWasted.value ?? 0),
    };

  return {
    unproductiveRunCount: unproductive.length,
    providerDeclinedRunCount: unproductive.filter(providerDeclined).length,
    unproductiveTokens,
    unproductiveAllowanceMicroUSD: unproductiveAllowance,
    unproductiveMarginalChargeMicroUSD: unproductiveCharge,
    retryWastedTokens: retryWasted,
    totalNonResultTokens: total,
    definition: UNPRODUCTIVE_SPEND_DEFINITION,
  };
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
  //
  // OVER EVERY ROW, DELIBERATELY. This is the ECONOMICS aggregate, and rule 3 in this file's header
  // is that tokens spent on a run that broke were still spent. The model-PERFORMANCE columns are
  // computed separately below, from the scored rows alone.
  const attemptMetrics = rows
    .map((row) => attemptMetricsFromRow(row))
    .filter((metrics): metrics is FrontierAttemptMetrics => metrics !== undefined);
  const metrics = aggregateCandidateMetrics(text(first, 'candidate') ?? '', attemptMetrics, passes.length);

  const efficiency = efficiencyOf(rows);
  const unproductiveSpend = unproductiveSpendOf(rows);

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
    ...identityProvenanceOf(rows),
    ...effortProvenanceOf(ordered),

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
    efficiency,
    unproductiveSpend,
    wallClockMilliseconds: efficiency.modelWallClockMilliseconds,
    totalTokens,
    measurementQuality: worstProvenance([
      metrics.inputTokens, metrics.visibleOutputTokens, metrics.costPerRunMicroUSD,
      quality.compositeMilli.mean,
    ]),
  };
}

const distinct = (values: (string | undefined)[]): string[] =>
  [...new Set(values.filter((value): value is string => value !== undefined && value.length > 0))].sort();

/**
 * The identity-confidence block of a cell, or nothing when every run is attributable.
 *
 * Deliberately touches no quality figure: an admitted run is scored exactly as any other, and a
 * substituted one is already a failed row. This only COUNTS what the rows say about attribution.
 */
function identityProvenanceOf(rows: Record<string, unknown>[]): { identityProvenance?: WorkspaceCellIdentityProvenance } {
  const admitted = rows.filter((row) => text(row, 'identityAdmissionDigest') !== undefined);
  const substituted = rows.filter((row) => text(row, 'executionIdentityVerdict') === 'substituted');
  if (admitted.length === 0 && substituted.length === 0) return {};
  const verdicts: Record<string, number> = {};
  for (const row of rows) {
    const verdict = text(row, 'executionIdentityVerdict') ?? 'notEstablished';
    verdicts[verdict] = (verdicts[verdict] ?? 0) + 1;
  }
  return {
    identityProvenance: {
      admittedUnverifiableRunCount: admitted
        .filter((row) => text(row, 'bindingIdentityState') === 'requestAcceptedIdentityUnverifiable').length,
      admissionScopes: distinct(admitted.map((row) => text(row, 'identityAdmissionScope') ?? 'singleRecord')),
      matrixAdmissionDigests: distinct(admitted.map((row) => text(row, 'matrixAdmissionDigest'))),
      matrixAdmissionEntryDigests: distinct(admitted.map((row) => text(row, 'matrixAdmissionEntryDigest'))),
      recordAdmissionDigests: admitted.map((row) => text(row, 'identityAdmissionDigest') ?? ''),
      executionIdentityVerdicts: verdicts,
      substitutedRunCount: substituted.length,
      reportedSubstitutes: distinct(substituted.map((row) => text(row, 'reportedModelID'))),
      identityLimitation: distinct(admitted.map((row) => text(row, 'identityLimitation')))[0],
      disclosure: 'Identity confidence, not quality: these runs are scored exactly like verified ones. An admitted run '
        + 'means "what answered when this identifier was requested", not "this model answered".',
    },
  };
}

/**
 * The applied-effort block of a cell, or nothing when no run of it measured one.
 *
 * Touches no quality figure. A mismatched run's score stays where verification put it, and this block
 * is where a reader learns that the score does not describe the requested effort.
 */
function effortProvenanceOf(runs: WorkspaceRunRow[]): { effortProvenance?: WorkspaceCellEffortProvenance } {
  const measured = runs.filter((run) => text(run.row, 'appliedEffortVerdict') !== undefined);
  if (measured.length === 0) return {};
  const verdicts: Record<string, number> = {};
  const distribution: Record<string, number> = {};
  for (const { row } of measured) {
    const verdict = text(row, 'appliedEffortVerdict') as string;
    verdicts[verdict] = (verdicts[verdict] ?? 0) + 1;
    const attempts = Array.isArray(row.appliedEffortAttempts) ? row.appliedEffortAttempts as Record<string, unknown>[] : [];
    const mixed = attempts.some((attempt) => Array.isArray(attempt.observedEfforts) && attempt.observedEfforts.length > 1);
    const applied = text(row, 'appliedEffort') ?? (mixed ? 'mixed' : 'unmeasured');
    distribution[applied] = (distribution[applied] ?? 0) + 1;
  }
  const verified = verdicts.appliedEffortVerified ?? 0;
  return {
    effortProvenance: {
      requestedEffort: text(measured[0].row, 'requestedEffort') ?? '',
      verdicts,
      appliedEffortDistribution: distribution,
      verifiedRunCount: verified,
      mismatchRunCount: verdicts.appliedEffortMismatch ?? 0,
      // Over EVERY run of the cell: a run that carries no verdict among runs that do is itself unverified.
      qualifiedForRequestedEffort: verified === runs.length,
      mismatchedRecordRoots: measured.filter(({ row }) => text(row, 'appliedEffortVerdict') === 'appliedEffortMismatch')
        .map((run) => run.recordRoot),
      disclosure: EFFORT_VALIDITY_IS_NOT_QUALITY,
    },
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
    // MODEL time, never the provider's refusal latency. A cell whose runs were all declined prints
    // `declined` rather than the half-second it took to be told no.
    (cell.wallClockMilliseconds.median.value !== undefined
      ? `${Math.round(cell.wallClockMilliseconds.median.value / 1000)}s`
      : cell.efficiency.providerDeclinedRunCount > 0 ? 'declined' : 'no time').padStart(8),
    (cell.billingBasis === 'subscriptionIncluded'
      ? (allowance === undefined ? 'allowance unknown' : `$${(allowance / 1_000_000).toFixed(4)} allow.`)
      : (cell.metrics.costPerRunMicroUSD.value === undefined ? 'cost unknown'
        : `$${(cell.metrics.costPerRunMicroUSD.value / 1_000_000).toFixed(4)}`)).padStart(18),
    cell.measurementQuality,
    // THE STAMP, on the same line as the numbers, so no copy of this row loses it. Absent on every
    // verified cell, whose line is unchanged.
    (cell.identityProvenance?.admittedUnverifiableRunCount ?? 0) > 0 ? `[${ADMISSION_STAMP_SHORT}]` : '',
    (cell.identityProvenance?.substitutedRunCount ?? 0) > 0
      ? `[${cell.identityProvenance?.substitutedRunCount} run(s) reported another model]` : '',
    // THE EFFORT VERDICT, on the same line as the numbers, for the same reason. Absent on a cell whose
    // runs measured no effort, whose line is unchanged.
    effortStamp(cell.effortProvenance, cell.runCount),
  ].join('  ').trimEnd();
}

function effortStamp(effort: WorkspaceCellEffortProvenance | undefined, runCount: number): string {
  if (effort === undefined) return '';
  if (effort.qualifiedForRequestedEffort) return `[applied effort ${effort.requestedEffort} verified ${runCount}/${runCount}]`;
  if (effort.mismatchRunCount > 0) {
    return `[EFFORT MISMATCH ${effort.mismatchRunCount}/${runCount} — not evidence for @${effort.requestedEffort}]`;
  }
  return `[applied effort UNVERIFIED ${runCount - effort.verifiedRunCount}/${runCount} — not qualified @${effort.requestedEffort}]`;
}

/**
 * One line per cell for the spend a cell got nothing back for.
 *
 * Printed apart from the quality table on purpose: it answers "what did this matrix burn without
 * learning anything", which is an operator's question rather than a comparison between models.
 */
export function describeUnproductiveSpend(cell: WorkspaceCellAggregate): string {
  const spend = cell.unproductiveSpend;
  const tokens = spend.unproductiveTokens.value;
  const allowance = spend.unproductiveAllowanceMicroUSD.value;
  return [
    cell.candidate.padEnd(30),
    cell.caseID.padEnd(30),
    `${spend.unproductiveRunCount}/${cell.runCount} no result`.padStart(18),
    (tokens === undefined ? 'tokens unknown' : `${tokens} tok`).padStart(16),
    (allowance === undefined ? 'allowance unknown' : `$${(allowance / 1_000_000).toFixed(6)} allow.`).padStart(20),
    spend.providerDeclinedRunCount > 0 ? `${spend.providerDeclinedRunCount} provider-declined` : '',
  ].join('  ').trimEnd();
}

/** The aggregate, as a canonical value a surface can write out beside the records it came from. */
export function workspaceCellAsCanonical(cell: WorkspaceCellAggregate): CanonicalValue {
  return cell as unknown as CanonicalValue;
}
