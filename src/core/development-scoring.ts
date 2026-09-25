// Cernum core · the scoring contract for the development benchmark.
//
// TWO TIERS, NAMED, AND THE DIFFERENCE IS NOT COSMETIC.
//
//   STRUCTURAL   decided by reading the repository the attempt left behind. Pure, total,
//                deterministic, and available on every machine this engine runs on. Every metric in
//                this tier is measured today.
//   EXECUTED     decided by RUNNING the code the candidate wrote — do the new tests pass, does the
//                project still build. Nothing in this tier is measured today, and this file says so
//                in the contract rather than in a footnote.
//
// WHY THE EXECUTED TIER IS DECLARED BUT NOT MEASURED. `docs/ENGINE.md` records the standing position
// that executing untrusted candidate CODE — as opposed to scoring candidate TEXT — stays out of this
// product until there is a real sandbox to put it in. `engine/isolation.ts` is honest about what it
// is: a temp directory, a path fence and a scrubbed environment, explicitly NOT an OS sandbox, and
// explicitly unable to stop a child process from opening a socket. Running `node` over
// model-authored source inside that is not isolation; it is a model-authored program with this
// machine's network and a different working directory.
//
// So the contract DECLARES the executed metrics, refuses to fill them in, and refuses to award full
// credit without them. The alternative — quietly dropping "do the tests pass" from the dimension
// list — would produce a development benchmark that claims to measure correctness and measures
// shape. The alternative in the other direction — scoring an unmeasured metric as zero — is the
// thing this engine says everywhere it can: missing evidence is not a zero score.
//
// WHAT STRUCTURAL SCORING CAN STILL PROVE, and it is more than it sounds. Held-out assertions over
// the resulting file contents are how implementation correctness is approached without execution: a
// candidate is told to add a per-region surcharge and is never told the rate table's pointer, the
// stage name, or which of two files the generator reads. Getting those right is not shape.
//
// A ONE-FILE PATCH CANNOT RECEIVE FULL CREDIT, AND THAT IS ENFORCED IN TWO PLACES. The task
// validator refuses a multi-file-editing task whose required-file set is smaller than
// MINIMUM_REQUIRED_FILES_FOR_MULTI_FILE_EDIT, so a single-file task cannot be authored. And
// `gradeTask` requires every gating metric to clear its bar, including `requiredFilesPresent`, so a
// patch that edits one of four required files fails the gate however good that one file is.

import { Measurement, measured, unavailable } from './candidate';
import { seal, compareCodePoints } from './digest';
import { AssertionOutcome, DevelopmentAssertion } from './development-assertions';

/** The two development dimensions Cernum did not measure before this pass. */
export type DevelopmentDimension = 'repositoryUnderstanding' | 'multiFileEditing';
export const ALL_DEVELOPMENT_DIMENSIONS: DevelopmentDimension[] = ['repositoryUnderstanding', 'multiFileEditing'];

export type MetricTier = 'structural' | 'executed';

export type DevelopmentMetricID =
  // Repository understanding
  | 'answerAccuracy'
  | 'evidenceGrounding'
  | 'irrelevantFileRestraint'
  | 'omissionAvoidance'
  // Multi-file editing
  | 'correctFilesEdited'
  | 'requiredFilesPresent'
  | 'unrelatedFilesUntouched'
  | 'implementationCorrectness'
  | 'testsAddedOrUpdated'
  | 'existingTestsPreserved'
  | 'repositoryStructurallyValid'
  | 'churnRestraint'
  | 'retryBehaviour'
  // Executed tier — declared, never filled in until there is a sandbox
  | 'newTestsPass'
  | 'existingTestsPass'
  | 'buildSucceeds';

export interface DevelopmentMetricSpec {
  id: DevelopmentMetricID;
  dimension: DevelopmentDimension;
  tier: MetricTier;
  summary: string;
  /**
   * A metric that must hold for FULL credit. A non-gating metric is still measured and still
   * reported; it shapes the partial score without being able to withhold the gate on its own.
   */
  gating: boolean;
  /** The share of assertions carrying this metric that must hold, in thousandths. */
  passBarMilli: number;
}

export const EXECUTED_TIER_NOT_MEASURED_REASON =
  'this metric requires running candidate-authored code, and Cernum has no OS sandbox to run it in. '
  + '`engine/isolation.ts` provides a disposable workspace, a path fence and a scrubbed environment, '
  + 'and states plainly that it is not a sandbox and does not stop a child process from opening a '
  + 'socket. Executing candidate code inside that would be a model-authored program with this '
  + "machine's network and a different working directory, so the metric is reported as not measured "
  + 'rather than scored as a zero or quietly dropped from the dimension.';

export const DEVELOPMENT_METRICS: DevelopmentMetricSpec[] = [
  { id: 'answerAccuracy', dimension: 'repositoryUnderstanding', tier: 'structural', gating: true, passBarMilli: 1_000,
    summary: 'every required element of the answer — file paths, symbols, ordering — matches the fixture\'s own ground truth' },
  { id: 'evidenceGrounding', dimension: 'repositoryUnderstanding', tier: 'structural', gating: true, passBarMilli: 1_000,
    summary: 'the answer cites repository evidence that exists, rather than asserting a cause with nothing behind it' },
  { id: 'irrelevantFileRestraint', dimension: 'repositoryUnderstanding', tier: 'structural', gating: true, passBarMilli: 1_000,
    summary: 'no file is named that has nothing to do with the question; confident irrelevance is a failure, not a near miss' },
  { id: 'omissionAvoidance', dimension: 'repositoryUnderstanding', tier: 'structural', gating: true, passBarMilli: 1_000,
    summary: 'nothing the question required is left out of the answer' },

  { id: 'correctFilesEdited', dimension: 'multiFileEditing', tier: 'structural', gating: true, passBarMilli: 1_000,
    summary: 'each file the change genuinely needs was actually modified or added' },
  { id: 'requiredFilesPresent', dimension: 'multiFileEditing', tier: 'structural', gating: true, passBarMilli: 1_000,
    summary: 'no required file was omitted; this is the gate a one-file patch cannot pass' },
  { id: 'unrelatedFilesUntouched', dimension: 'multiFileEditing', tier: 'structural', gating: true, passBarMilli: 1_000,
    summary: 'nothing outside the change was edited, deleted, or reformatted' },
  { id: 'implementationCorrectness', dimension: 'multiFileEditing', tier: 'structural', gating: true, passBarMilli: 1_000,
    summary: 'the held-out assertions over the resulting contents hold — the change does what was asked, in the place it belongs' },
  { id: 'testsAddedOrUpdated', dimension: 'multiFileEditing', tier: 'structural', gating: true, passBarMilli: 1_000,
    summary: 'test material covering the new behaviour was added or updated' },
  { id: 'existingTestsPreserved', dimension: 'multiFileEditing', tier: 'structural', gating: true, passBarMilli: 1_000,
    summary: 'existing test cases were not deleted, weakened, or rewritten to accommodate the change' },
  { id: 'repositoryStructurallyValid', dimension: 'multiFileEditing', tier: 'structural', gating: true, passBarMilli: 1_000,
    summary: 'every data file still parses and the declared source-of-truth relationships still hold' },
  { id: 'churnRestraint', dimension: 'multiFileEditing', tier: 'structural', gating: false, passBarMilli: 1_000,
    summary: 'the change did not carry unnecessary rewriting along with it' },
  { id: 'retryBehaviour', dimension: 'multiFileEditing', tier: 'structural', gating: false, passBarMilli: 1_000,
    summary: 'how the attempt behaved when it failed: whether it retried, and whether the retry converged or thrashed' },

  { id: 'newTestsPass', dimension: 'multiFileEditing', tier: 'executed', gating: true, passBarMilli: 1_000,
    summary: 'the tests the candidate added actually pass when run' },
  { id: 'existingTestsPass', dimension: 'multiFileEditing', tier: 'executed', gating: true, passBarMilli: 1_000,
    summary: 'the tests that passed before the change still pass after it' },
  { id: 'buildSucceeds', dimension: 'multiFileEditing', tier: 'executed', gating: true, passBarMilli: 1_000,
    summary: 'the repository still builds' },
];

export const METRIC_SPEC_BY_ID: Map<DevelopmentMetricID, DevelopmentMetricSpec> =
  new Map(DEVELOPMENT_METRICS.map((spec) => [spec.id, spec]));

export function metricsForDimension(dimension: DevelopmentDimension): DevelopmentMetricSpec[] {
  return DEVELOPMENT_METRICS.filter((spec) => spec.dimension === dimension);
}

export function isDevelopmentMetricID(value: unknown): value is DevelopmentMetricID {
  return typeof value === 'string' && METRIC_SPEC_BY_ID.has(value as DevelopmentMetricID);
}

/**
 * The smallest number of distinct files a multi-file-editing task may require.
 *
 * Three, not two. Two is "change the thing and change its caller", which a competent single-file
 * habit reaches by accident. Three is the smallest set that forces the shape this dimension exists
 * to measure: the implementation, the declaration it must stay consistent with, and the test.
 */
export const MINIMUM_REQUIRED_FILES_FOR_MULTI_FILE_EDIT = 3;

export const DEVELOPMENT_SCORING_CONTRACT_ID = 'contract.cernum.development';
/**
 * The contract's version. It is in every task digest and every comparability key, so a result
 * graded under one version is never ranked beside a result graded under another.
 *
 *   1   a repository-understanding answer is read strictly, or after removing at most one fence
 *       that encloses the whole reply. Prose before the answer made it unreadable.
 *   2   adds the TERMINAL-OBJECT reading: optional prose, then exactly one JSON object ending the
 *       reply (see `extractTerminalJSONObject`). Every accepted reading must also have the exact
 *       shape the task states. The strict reading is still recorded on every row, separately, as
 *       the compliance fact. The metrics, their bars and multi-file-edit grading are unchanged.
 */
export const DEVELOPMENT_SCORING_CONTRACT_VERSION = '2';

/** How a repository-understanding answer may be read under a contract version. */
export type AnswerReadingRules = 'strictOrSingleFence' | 'strictSingleFenceOrTerminalObject';

export const ANSWER_READING_RULES_BY_CONTRACT_VERSION: Record<string, AnswerReadingRules> = {
  '1': 'strictOrSingleFence',
  '2': 'strictSingleFenceOrTerminalObject',
};

/** The reading rules of the current contract, sealed into its digest. */
export const DEVELOPMENT_ANSWER_READING = {
  rules: ANSWER_READING_RULES_BY_CONTRACT_VERSION[DEVELOPMENT_SCORING_CONTRACT_VERSION],
  readings: ['strict', 'singleFence', 'terminalObject'],
  terminalObject: 'optional prose containing no JSON object and no fence, a line break, then exactly one JSON '
    + 'object (optionally in the reply\'s only fence) as the last thing in the reply; nothing after it',
  shape: 'every accepted reading must carry exactly the keys the task declares, with the declared types',
  strictReadingRecorded: true,
};

/** `mldc1:` — the sealed identity of the whole contract. Bound into every verdict. */
export function developmentContractDigest(): string {
  return seal({
    id: DEVELOPMENT_SCORING_CONTRACT_ID,
    version: DEVELOPMENT_SCORING_CONTRACT_VERSION,
    metrics: DEVELOPMENT_METRICS,
    minimumRequiredFiles: MINIMUM_REQUIRED_FILES_FOR_MULTI_FILE_EDIT,
    answerReading: DEVELOPMENT_ANSWER_READING,
  }, 'mldc1:');
}

// MARK: - Verdicts

export type MetricStatus = 'pass' | 'fail' | 'notMeasured' | 'notApplicable';

export interface DevelopmentMetricResult {
  id: DevelopmentMetricID;
  tier: MetricTier;
  status: MetricStatus;
  /** The share of this metric's assertions that held, in thousandths. Unavailable when unmeasured. */
  valueMilli: Measurement<number>;
  /** Assertion ids that carried this metric, sorted. Empty when the metric has no assertions here. */
  assertionIDs: string[];
  detail: string;
}

export type Credit = 'full' | 'partial' | 'none';

export interface DevelopmentTaskGrade {
  /** Over the structural tier alone: what this engine can actually decide today. */
  structuralCredit: Credit;
  /** Over the executed tier. `notMeasured` until there is a sandbox — never `full`, never `none`. */
  executedCredit: Credit | 'notMeasured';
  /**
   * The overall credit, and the one a routing decision must read.
   *
   * It can never be `full` while any gating executed metric is unmeasured, because a task graded
   * `full` would be asserting that the candidate's code was run and worked. It was not run.
   */
  credit: Credit;
  creditReason: string;
  metrics: DevelopmentMetricResult[];
  shortcutSuspected: boolean;
  shortcutReasons: string[];
  /** Held-out assertions that held, over held-out assertions evaluated. The understanding figure. */
  heldOutPassRateMilli: Measurement<number>;
}

function rateMilli(held: number, total: number): Measurement<number> {
  return total === 0
    ? unavailable('no assertion carried this metric for this task, so there is nothing to compute a rate over')
    : measured(Math.round((held * 1_000) / total));
}

/**
 * Grade one attempt from its assertion outcomes.
 *
 * `applicableMetrics` is the task's own declared metric set: a repository-understanding task does
 * not have a `churnRestraint` result and must not be reported as having failed one. A metric that is
 * applicable but carries no assertion is `notApplicable` with a reason, never a silent pass.
 */
export function gradeTask(
  dimension: DevelopmentDimension,
  outcomes: AssertionOutcome[],
  options: { retryDetail?: string } = {},
): DevelopmentTaskGrade {
  const specs = metricsForDimension(dimension);
  const byMetric = new Map<string, AssertionOutcome[]>();
  for (const outcome of outcomes) {
    const bucket = byMetric.get(outcome.metric) ?? [];
    bucket.push(outcome);
    byMetric.set(outcome.metric, bucket);
  }

  const metrics: DevelopmentMetricResult[] = specs.map((spec) => {
    if (spec.tier === 'executed') {
      return {
        id: spec.id, tier: spec.tier, status: 'notMeasured' as const,
        valueMilli: unavailable(EXECUTED_TIER_NOT_MEASURED_REASON),
        assertionIDs: [], detail: EXECUTED_TIER_NOT_MEASURED_REASON,
      };
    }
    if (spec.id === 'retryBehaviour') {
      const detail = options.retryDetail;
      return detail === undefined
        ? { id: spec.id, tier: spec.tier, status: 'notMeasured' as const,
            valueMilli: unavailable('the runner recorded no retry history for this attempt'),
            assertionIDs: [], detail: 'the runner recorded no retry history for this attempt' }
        : { id: spec.id, tier: spec.tier, status: 'pass' as const, valueMilli: measured(1_000), assertionIDs: [], detail };
    }
    const bucket = (byMetric.get(spec.id) ?? []).sort((a, b) => compareCodePoints(a.id, b.id));
    if (bucket.length === 0) {
      return {
        id: spec.id, tier: spec.tier, status: 'notApplicable' as const,
        valueMilli: unavailable('this task declares no assertion for this metric'),
        assertionIDs: [], detail: 'this task declares no assertion for this metric, so it is not applicable here rather than passed by default',
      };
    }
    const held = bucket.filter((outcome) => outcome.held);
    const value = rateMilli(held.length, bucket.length);
    const reached = 'measured' in value && value.measured >= spec.passBarMilli;
    const failedDetail = bucket.filter((outcome) => !outcome.held).map((outcome) => outcome.detail);
    return {
      id: spec.id, tier: spec.tier, status: reached ? 'pass' as const : 'fail' as const,
      valueMilli: value,
      assertionIDs: bucket.map((outcome) => outcome.id),
      detail: reached
        ? `${held.length} of ${bucket.length} assertion(s) held`
        : `${held.length} of ${bucket.length} assertion(s) held — ${failedDetail.join('; ')}`,
    };
  });

  const gatingStructural = metrics.filter((result) => result.tier === 'structural' && METRIC_SPEC_BY_ID.get(result.id)!.gating);
  const structuralFailures = gatingStructural.filter((result) => result.status === 'fail');
  const structuralPasses = gatingStructural.filter((result) => result.status === 'pass');
  const structuralCredit: Credit = structuralFailures.length === 0 && structuralPasses.length > 0 ? 'full'
    : structuralPasses.length === 0 ? 'none' : 'partial';

  const heldOut = outcomes.filter((outcome) => outcome.visibility === 'heldOut');
  const heldOutPassRateMilli = heldOut.length === 0
    ? unavailable('this task declares no held-out assertion')
    : rateMilli(heldOut.filter((outcome) => outcome.held).length, heldOut.length);

  const shortcutFailures = outcomes.filter((outcome) => outcome.shortcutProbe && !outcome.held);

  const executedGating = specs.filter((spec) => spec.tier === 'executed' && spec.gating);
  const executedCredit: Credit | 'notMeasured' = executedGating.length === 0 ? 'full' : 'notMeasured';

  const credit: Credit = executedCredit === 'notMeasured'
    ? (structuralCredit === 'none' ? 'none' : 'partial')
    : structuralCredit;

  const creditReason = executedCredit === 'notMeasured'
    ? `structural tier: ${structuralCredit}`
      + (structuralFailures.length > 0 ? ` (${structuralFailures.map((result) => result.id).join(', ')} below bar)` : '')
      + `. Full credit is withheld because ${executedGating.length} gating executed metric(s) — `
      + `${executedGating.map((spec) => spec.id).join(', ')} — were not measured: ${EXECUTED_TIER_NOT_MEASURED_REASON}`
    : structuralCredit === 'full'
      ? 'every gating metric in both tiers reached its bar'
      : `structural tier: ${structuralCredit} (${structuralFailures.map((result) => result.id).join(', ')} below bar)`;

  return {
    structuralCredit,
    executedCredit,
    credit,
    creditReason,
    metrics,
    shortcutSuspected: shortcutFailures.length > 0,
    shortcutReasons: shortcutFailures.map((outcome) => `${outcome.id}: ${outcome.detail}`),
    heldOutPassRateMilli,
  };
}

/** Every metric id an assertion set references, for the task validator to check against the tier. */
export function referencedMetrics(assertions: DevelopmentAssertion[]): string[] {
  return [...new Set(assertions.map((assertion) => assertion.metric))].sort(compareCodePoints);
}
