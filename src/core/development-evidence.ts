// Cernum core · development capability evidence, and the routing statements built on it.
//
// THE DEFAULT IS "NOT MEASURED", AND IT IS THE DEFAULT BY CONSTRUCTION. `noDevelopmentEvidence` is
// what every candidate has until it runs these suites, and it is what the ranking layer fills in
// when it is given nothing. There is no code path in which a candidate with no development run
// acquires a development rate, because there is no table the two could be joined through: the text
// registry and the development registry are separate, and nothing imputes across them.
//
// That matters more than it sounds. Twelve configurations have been measured by Cernum on twelve
// text dimensions. None of them has ever been asked to read a repository or change four files at
// once. A benchmark that added the dimensions and left those rows at their old ranks would be
// asserting something about them that no experiment supports — and it would be asserting it most
// confidently about the models that scored best on the questions that were asked.
//
// THREE ROLES, AND ONLY ONE OF THEM CAN QUALIFY TODAY.
//
//   repository reader           needs `repositoryUnderstanding` only, which is decided entirely by
//                               structural assertions over a JSON answer. Fully measurable now.
//   multi-file editor           needs `multiFileEditing`, whose contract declares three EXECUTED
//                               metrics that this engine cannot fill in. It reports its structural
//                               standing in full and it does not qualify, and the reason names the
//                               sandbox rather than the model.
//   development routing         both, at a higher bar. Blocked for the same reason.
//
// Publishing the structural standing beside a role that cannot qualify is deliberate. The
// measurement is real and a reader is entitled to it; what is withheld is the instruction built on
// top of it. That is the same line `ranking.ts` already draws for a candidate whose identity was
// never established.

import { Measurement, measured, unavailable } from './candidate';
import { compareCodePoints } from './digest';
import { DevelopmentProvenance, provenanceIsComplete } from './development-benchmark';
import { DevelopmentTaskResult } from './development-evaluation';
import {
  ALL_DEVELOPMENT_DIMENSIONS, Credit, DevelopmentDimension, DevelopmentMetricID, EXECUTED_TIER_NOT_MEASURED_REASON,
  MetricTier, metricsForDimension,
} from './development-scoring';

export const DEVELOPMENT_NOT_MEASURED_REASON =
  'this candidate has not run the development suites. Cernum measured it on the text benchmark, which asks '
  + 'nothing about reading a repository or changing several files coherently, and no rate from those suites '
  + 'is evidence about these dimensions. Missing evidence is not a zero score and is not a low rank: it is '
  + 'an experiment that has not been run.';

export type DevelopmentEvidenceState =
  /** No task on this dimension was graded for this candidate. */
  | 'notMeasured'
  /** Some tasks were graded and some were not. The rate is real and the experiment is partial. */
  | 'partiallyMeasured'
  /** Every planned task on this dimension was graded. */
  | 'measured';

export interface DevelopmentMetricRate {
  metric: DevelopmentMetricID;
  tier: MetricTier;
  passCount: number;
  failCount: number;
  notMeasuredCount: number;
  notApplicableCount: number;
  /** Passes per thousand DECIDED results. Unavailable — never zero — when nothing was decided. */
  passRateMilli: Measurement<number>;
}

/**
 * One task's standing across its repeats.
 *
 * COVERAGE IS COUNTED HERE, PER TASK, AND NOWHERE ELSE. A task with one of two repeats graded is not
 * half-measured and is not measured: it is INCOMPLETE, and it stays incomplete however well that one
 * repeat went. The quality of the repeats it does have is still reported, because a real grade is
 * still real — what is withheld is the claim that the experiment on this task was finished.
 */
export interface DevelopmentTaskCoverage {
  taskID: string;
  dimension: DevelopmentDimension;
  requiredRepeats: number;
  /** Repeat identities that were graded, sorted. Each counts once, however many rows claimed it. */
  gradedRepeats: number[];
  /** Repeat identities on which no model answered — transport, account, refusal. Visible, never scored. */
  excludedRepeats: number[];
  /** Repeat identities with no terminal record at all. */
  missingRepeats: number[];
  /** True only when every required repeat was graded. */
  measured: boolean;
  /** Graded repeats at full structural credit. */
  structuralFullRepeatCount: number;
  /** Graded repeats by overall credit. */
  creditCounts: Record<Credit, number>;
  /** Graded repeats at full structural credit, per thousand graded repeats. Unavailable when none were graded. */
  structuralScoreMilli: Measurement<number>;
  /**
   * Whether the graded repeats agreed with one another.
   *
   *   consistent     every graded repeat reached the same structural and overall credit
   *   mixed          they did not — the task score is the share of repeats that reached full credit
   *   singleRepeat   one graded repeat, so there is nothing to compare it with
   *   notMeasured    none was graded
   */
  stability: 'consistent' | 'mixed' | 'singleRepeat' | 'notMeasured';
  /** Per graded repeat, what it earned. The raw material for any variance a reader wants to compute. */
  repeatCredits: { repeat: number; structuralCredit: Credit; credit: Credit }[];
}

export interface DevelopmentDimensionEvidence {
  dimension: DevelopmentDimension;
  state: DevelopmentEvidenceState;
  because: string;
  /** Unique tasks planned on this dimension. The coverage denominator — never a row count. */
  plannedTaskCount: number;
  /** Tasks with EVERY required repeat graded. The coverage numerator. */
  gradedTaskCount: number;
  /** Tasks with at least one graded repeat: the tasks the rate below is computed over. */
  scoredTaskCount: number;
  /** Valid graded repeats each task needs before it counts as measured. */
  requiredRepeats: number;
  /** plannedTaskCount × requiredRepeats. */
  requiredRepeatCount: number;
  gradedRepeatCount: number;
  /** Repeats on which no model answered. They reduce completeness and never reduce a score. */
  excludedRepeatCount: number;
  missingRepeatCount: number;
  /** Scored tasks whose graded repeats disagreed. */
  mixedTaskCount: number;
  /** Tasks where EVERY graded repeat reached full structural credit. */
  structuralFullCreditCount: number;
  /** Tasks where every graded repeat was graded `full` overall. Zero while any gating executed metric is unmeasured. */
  fullCreditCount: number;
  /**
   * The mean, over scored tasks, of each task's share of graded repeats at full structural credit.
   *
   * Averaged per TASK, not per repeat, so a task is weighted once whatever its repeat count — and a
   * task whose repeats disagree contributes the share it actually earned rather than a coin flip.
   */
  structuralPassRateMilli: Measurement<number>;
  /** Over held-out assertions only: the share the prompt did not give away. Per task, then across tasks. */
  heldOutPassRateMilli: Measurement<number>;
  /** Tasks on which any graded repeat tripped a shortcut probe. */
  shortcutSuspectedCount: number;
  /** False whenever this dimension's contract declares an executed metric. */
  executedTierMeasured: boolean;
  executedTierBecause: string;
  /** Per metric, over every graded repeat. */
  metrics: DevelopmentMetricRate[];
  /** Scored task ids, sorted. */
  taskIDs: string[];
  tasks: DevelopmentTaskCoverage[];
}

export interface DevelopmentEvidence {
  candidate: string;
  dimensions: DevelopmentDimensionEvidence[];
  /** One record per graded repeat. Empty when nothing was measured. */
  provenance: DevelopmentProvenance[];
  provenanceComplete: boolean;
  /** Named gaps: `<taskID>: <field>`. A result whose provenance is incomplete is still published. */
  provenanceGaps: string[];
  derivedAt: string;
}

export interface DevelopmentPlan {
  /** How many tasks the registry holds for each dimension. The denominator for coverage. */
  plannedTaskCounts: Record<DevelopmentDimension, number>;
  /**
   * Valid graded repeats a task needs before it counts as measured. Absent means one, which is what
   * every caller that predates repeats meant.
   */
  requiredRepeats?: number;
  /**
   * The exact task ids planned, when the caller knows them. Present, coverage is checked by id — a
   * record for a task that was not planned is not part of this experiment and is ignored — and a
   * planned task with no record at all still appears, as missing.
   */
  plannedTaskIDs?: Record<DevelopmentDimension, string[]>;
}

/**
 * One repeat of one task, as the evidence layer reads it.
 *
 * `repeat` is the plan's repeat identity. Two records naming the same task and repeat are ONE repeat
 * — the first wins, exactly as `ledger.ts` lets the first terminal record per slot win — so a retried
 * or duplicated row can never add coverage that was not planned.
 */
export interface DevelopmentRepeatRecord {
  taskID: string;
  dimension: DevelopmentDimension;
  repeat: number;
  /** Present when a model answered and the attempt was graded. */
  result?: DevelopmentTaskResult;
  /** Why this repeat carries no grade. A record with neither this nor `result` is treated as excluded. */
  excludedBecause?: string;
  disposition?: string;
}

function rateMilli(passes: number, decided: number, noneReason: string): Measurement<number> {
  return decided === 0 ? unavailable(noneReason) : measured(Math.round((passes * 1_000) / decided));
}

function meanMilli(values: number[], noneReason: string): Measurement<number> {
  return values.length === 0
    ? unavailable(noneReason)
    : measured(Math.round(values.reduce((sum, value) => sum + value, 0) / values.length));
}

function dimensionDeclaresExecutedTier(dimension: DevelopmentDimension): boolean {
  return metricsForDimension(dimension).some((spec) => spec.tier === 'executed');
}

function executedTierBecauseFor(dimension: DevelopmentDimension): string {
  return dimensionDeclaresExecutedTier(dimension)
    ? EXECUTED_TIER_NOT_MEASURED_REASON
    : 'this dimension declares no executed metric; nothing is missing from it';
}

function requiredRepeatsOf(plan: DevelopmentPlan): number {
  const required = plan.requiredRepeats ?? 1;
  return Number.isInteger(required) && required >= 1 ? required : 1;
}

function plannedCountOf(plan: DevelopmentPlan, dimension: DevelopmentDimension): number {
  return plan.plannedTaskIDs ? new Set(plan.plannedTaskIDs[dimension]).size : plan.plannedTaskCounts[dimension];
}

/** The state of a candidate that has never run these suites. Every ranking starts here. */
export function noDevelopmentEvidence(candidate: string, plan: DevelopmentPlan, derivedAt: string): DevelopmentEvidence {
  const required = requiredRepeatsOf(plan);
  return {
    candidate,
    dimensions: ALL_DEVELOPMENT_DIMENSIONS.map((dimension) => {
      const planned = plannedCountOf(plan, dimension);
      return {
        dimension,
        state: 'notMeasured' as const,
        because: DEVELOPMENT_NOT_MEASURED_REASON,
        plannedTaskCount: planned,
        gradedTaskCount: 0,
        scoredTaskCount: 0,
        requiredRepeats: required,
        requiredRepeatCount: planned * required,
        gradedRepeatCount: 0,
        excludedRepeatCount: 0,
        missingRepeatCount: planned * required,
        mixedTaskCount: 0,
        structuralFullCreditCount: 0,
        fullCreditCount: 0,
        structuralPassRateMilli: unavailable(DEVELOPMENT_NOT_MEASURED_REASON),
        heldOutPassRateMilli: unavailable(DEVELOPMENT_NOT_MEASURED_REASON),
        shortcutSuspectedCount: 0,
        executedTierMeasured: false,
        executedTierBecause: executedTierBecauseFor(dimension),
        metrics: [],
        taskIDs: [],
        tasks: [],
      };
    }),
    provenance: [],
    provenanceComplete: false,
    provenanceGaps: ['no development task was run, so there is no provenance to be complete'],
    derivedAt,
  };
}

/**
 * Evidence from graded task results, one repeat each.
 *
 * The form every caller used before repeats existed. Each result is repeat 1 of its task, so two
 * results for one task are ONE task graded once — the second is a duplicate, and it is dropped
 * rather than counted as a second task.
 */
export function buildDevelopmentEvidence(
  candidate: string, results: DevelopmentTaskResult[], plan: DevelopmentPlan, derivedAt: string,
): DevelopmentEvidence {
  return buildRepeatedDevelopmentEvidence(candidate, results.map((result) => ({
    taskID: result.taskID, dimension: result.dimension, repeat: 1, result,
  })), plan, derivedAt);
}

function coverageFor(taskID: string, dimension: DevelopmentDimension, required: number,
                     records: DevelopmentRepeatRecord[]): DevelopmentTaskCoverage {
  const graded = records.filter((record) => record.result !== undefined);
  const gradedRepeats = graded.map((record) => record.repeat).sort((a, b) => a - b);
  const excludedRepeats = records.filter((record) => record.result === undefined)
    .map((record) => record.repeat).sort((a, b) => a - b);
  const seen = new Set(records.map((record) => record.repeat));
  const missingRepeats: number[] = [];
  for (let repeat = 1; repeat <= required; repeat++) if (!seen.has(repeat)) missingRepeats.push(repeat);

  const repeatCredits = graded
    .map((record) => ({ repeat: record.repeat, structuralCredit: record.result!.grade.structuralCredit, credit: record.result!.grade.credit }))
    .sort((a, b) => a.repeat - b.repeat);
  const structuralFull = repeatCredits.filter((entry) => entry.structuralCredit === 'full').length;
  const creditCounts: Record<Credit, number> = { full: 0, partial: 0, none: 0 };
  for (const entry of repeatCredits) creditCounts[entry.credit] += 1;
  const distinct = new Set(repeatCredits.map((entry) => `${entry.structuralCredit}/${entry.credit}`));

  return {
    taskID,
    dimension,
    requiredRepeats: required,
    gradedRepeats,
    excludedRepeats,
    missingRepeats,
    measured: gradedRepeats.length >= required,
    structuralFullRepeatCount: structuralFull,
    creditCounts,
    structuralScoreMilli: rateMilli(structuralFull, repeatCredits.length, 'no repeat of this task was graded'),
    stability: repeatCredits.length === 0 ? 'notMeasured'
      : repeatCredits.length === 1 ? 'singleRepeat'
        : distinct.size === 1 ? 'consistent' : 'mixed',
    repeatCredits,
  };
}

/**
 * Evidence from every repeat of every task, with coverage counted per task.
 *
 * THE RULES, in the order they are applied:
 *
 *   1  one record per (task, repeat): the first wins, and a repeat outside 1…required is ignored.
 *   2  a repeat with no grade — no model answered it — is EXCLUDED. It is visible, it makes the task
 *      incomplete, and it never enters a rate: a dead socket is not a wrong answer.
 *   3  a task is MEASURED only when every required repeat was graded.
 *   4  a task's score is the share of its graded repeats at full structural credit.
 *   5  a dimension's rate is the mean of its scored tasks' scores; it is MEASURED only when every
 *      planned task is measured, and PARTIALLY MEASURED — with the rate still published — otherwise.
 */
export function buildRepeatedDevelopmentEvidence(
  candidate: string, records: DevelopmentRepeatRecord[], plan: DevelopmentPlan, derivedAt: string,
): DevelopmentEvidence {
  const empty = noDevelopmentEvidence(candidate, plan, derivedAt);
  const required = requiredRepeatsOf(plan);
  const plannedIDs = plan.plannedTaskIDs
    ? new Set(ALL_DEVELOPMENT_DIMENSIONS.flatMap((dimension) => plan.plannedTaskIDs![dimension]))
    : undefined;

  const unique = new Map<string, DevelopmentRepeatRecord>();
  for (const record of records) {
    if (!Number.isInteger(record.repeat) || record.repeat < 1 || record.repeat > required) continue;
    if (plannedIDs && !plannedIDs.has(record.taskID)) continue;
    const key = `${record.taskID}\u0000${record.repeat}`;
    if (!unique.has(key)) unique.set(key, record);
  }
  const kept = [...unique.values()];
  if (kept.length === 0) return empty;

  const dimensions = ALL_DEVELOPMENT_DIMENSIONS.map((dimension): DevelopmentDimensionEvidence => {
    const base = empty.dimensions.find((entry) => entry.dimension === dimension)!;
    const forDimension = kept.filter((record) => record.dimension === dimension);
    const taskIDs = [...new Set([
      ...(plan.plannedTaskIDs?.[dimension] ?? []),
      ...forDimension.map((record) => record.taskID),
    ])].sort(compareCodePoints);
    const tasks = taskIDs.map((taskID) => coverageFor(taskID, dimension, required,
      forDimension.filter((record) => record.taskID === taskID)));

    const planned = plannedCountOf(plan, dimension);
    const requiredRepeatCount = planned * required;
    const gradedRepeatCount = tasks.reduce((sum, task) => sum + task.gradedRepeats.length, 0);
    const excludedRepeatCount = tasks.reduce((sum, task) => sum + task.excludedRepeats.length, 0);
    const missingRepeatCount = Math.max(0, requiredRepeatCount - gradedRepeatCount - excludedRepeatCount);

    const gradedResults = forDimension
      .filter((record) => record.result !== undefined)
      .sort((a, b) => compareCodePoints(a.taskID, b.taskID) || a.repeat - b.repeat);

    if (gradedResults.length === 0) {
      if (excludedRepeatCount === 0) return base;
      return {
        ...base,
        because: `${excludedRepeatCount} repeat(s) on this dimension were attempted and no model answered any of them `
          + '(transport, account or refusal), so nothing was graded. They are reported as exclusions, never as failures. '
          + DEVELOPMENT_NOT_MEASURED_REASON,
        excludedRepeatCount,
        missingRepeatCount,
        tasks,
      };
    }

    const scored = tasks.filter((task) => task.gradedRepeats.length > 0);
    const measuredTasks = tasks.filter((task) => task.measured).length;

    const heldOutPerTask = scored.map((task) => {
      const values = gradedResults
        .filter((record) => record.taskID === task.taskID)
        .map((record) => record.result!.grade.heldOutPassRateMilli)
        .filter((value): value is { measured: number } => 'measured' in value)
        .map((value) => value.measured);
      return values.length === 0 ? undefined : values.reduce((sum, value) => sum + value, 0) / values.length;
    }).filter((value): value is number => value !== undefined);

    const metrics: DevelopmentMetricRate[] = metricsForDimension(dimension).map((spec) => {
      const statuses = gradedResults
        .map((record) => record.result!.grade.metrics.find((entry) => entry.id === spec.id))
        .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
      const passCount = statuses.filter((entry) => entry.status === 'pass').length;
      const failCount = statuses.filter((entry) => entry.status === 'fail').length;
      return {
        metric: spec.id,
        tier: spec.tier,
        passCount,
        failCount,
        notMeasuredCount: statuses.filter((entry) => entry.status === 'notMeasured').length,
        notApplicableCount: statuses.filter((entry) => entry.status === 'notApplicable').length,
        passRateMilli: rateMilli(passCount, passCount + failCount,
          spec.tier === 'executed'
            ? EXECUTED_TIER_NOT_MEASURED_REASON
            : 'no task decided this metric; a metric nothing applied to has no rate'),
      };
    });

    const state: DevelopmentEvidenceState = measuredTasks >= planned ? 'measured' : 'partiallyMeasured';
    const repeatClause = required > 1 ? ` on all ${required} repeats` : '';
    return {
      dimension,
      state,
      because: state === 'measured'
        ? `every one of the ${planned} registered task(s) on this dimension was graded${repeatClause}`
        : `${measuredTasks} of the ${planned} registered task(s) on this dimension were graded`
          + (required > 1 ? ` on all ${required} required repeats` : '')
          + `; ${gradedRepeatCount} of ${requiredRepeatCount} required repeat(s) were graded, ${excludedRepeatCount} `
          + `excluded because no model answered, ${missingRepeatCount} not yet run. The rate is correct over what was `
          + 'run and rests on part of the suite',
      plannedTaskCount: planned,
      gradedTaskCount: measuredTasks,
      scoredTaskCount: scored.length,
      requiredRepeats: required,
      requiredRepeatCount,
      gradedRepeatCount,
      excludedRepeatCount,
      missingRepeatCount,
      mixedTaskCount: scored.filter((task) => task.stability === 'mixed').length,
      structuralFullCreditCount: scored.filter((task) => task.structuralFullRepeatCount === task.gradedRepeats.length).length,
      fullCreditCount: scored.filter((task) => task.creditCounts.full === task.gradedRepeats.length).length,
      structuralPassRateMilli: meanMilli(
        scored.map((task) => (task.structuralFullRepeatCount * 1_000) / task.gradedRepeats.length),
        'no task on this dimension was graded'),
      heldOutPassRateMilli: heldOutPerTask.length === 0
        ? unavailable('no graded task on this dimension declared a held-out assertion')
        : meanMilli(heldOutPerTask, 'no graded task on this dimension declared a held-out assertion'),
      shortcutSuspectedCount: scored.filter((task) => gradedResults
        .some((record) => record.taskID === task.taskID && record.result!.grade.shortcutSuspected)).length,
      executedTierMeasured: false,
      executedTierBecause: executedTierBecauseFor(dimension),
      metrics,
      taskIDs: scored.map((task) => task.taskID),
      tasks,
    };
  });

  const graded = kept
    .filter((record) => record.result !== undefined)
    .sort((a, b) => compareCodePoints(a.taskID, b.taskID) || a.repeat - b.repeat);
  const provenance = graded
    .map((record) => record.result!.provenance)
    .filter((entry): entry is DevelopmentProvenance => entry !== undefined);

  const gaps: string[] = [];
  for (const record of graded) {
    const label = required > 1 ? `${record.taskID} (repeat ${record.repeat})` : record.taskID;
    if (record.result!.provenance === undefined) {
      gaps.push(`${label}: no provenance was recorded at all`);
      continue;
    }
    const { complete, missing } = provenanceIsComplete(record.result!.provenance);
    if (!complete) gaps.push(`${label}: ${missing.join(', ')}`);
  }

  return {
    candidate,
    dimensions,
    provenance,
    provenanceComplete: graded.length > 0 && gaps.length === 0,
    provenanceGaps: graded.length === 0
      ? ['no development repeat was graded, so there is no provenance to be complete']
      : gaps,
    derivedAt,
  };
}

// MARK: - Roles

export interface DevelopmentRoleDefinition {
  role: string;
  summary: string;
  dimensions: DevelopmentDimension[];
  /** Every named dimension must reach this structural pass rate, in thousandths. */
  minimumStructuralPassRateMilli: number;
  /**
   * True when this role asserts that the candidate's code WORKS, which cannot be said without
   * running it. A role with this set can report a structural standing and cannot qualify.
   */
  requiresExecutedEvidence: boolean;
}

export const DEVELOPMENT_ROLE_DEFINITIONS: DevelopmentRoleDefinition[] = [
  {
    role: 'repository reader',
    summary: 'Enters an unfamiliar repository and reasons correctly about how its files relate, without naming files that have nothing to do with the question.',
    dimensions: ['repositoryUnderstanding'],
    minimumStructuralPassRateMilli: 800,
    requiresExecutedEvidence: false,
  },
  {
    role: 'multi-file editor',
    summary: 'Makes a change that spans an implementation, the declarations it must agree with, its data and its tests, and touches nothing else.',
    dimensions: ['multiFileEditing'],
    minimumStructuralPassRateMilli: 800,
    requiresExecutedEvidence: true,
  },
  {
    role: 'development routing candidate',
    summary: 'Both of the above, at the bar a routing decision should ask for before sending real development work somewhere.',
    dimensions: ['repositoryUnderstanding', 'multiFileEditing'],
    minimumStructuralPassRateMilli: 850,
    requiresExecutedEvidence: true,
  },
];

export type StructuralStanding = 'met' | 'notMet' | 'notMeasured' | 'partial';

export interface DevelopmentRole {
  role: string;
  summary: string;
  qualified: boolean;
  reason: string;
  /** What the structural tier says, published whether or not the role can qualify on it. */
  structuralStanding: StructuralStanding;
  interpretation: 'This is an interpretation of the measurements, not a measurement.';
}

const INTERPRETATION = 'This is an interpretation of the measurements, not a measurement.' as const;

export function assessDevelopmentRoles(evidence: DevelopmentEvidence): DevelopmentRole[] {
  const byDimension = new Map(evidence.dimensions.map((entry) => [entry.dimension, entry]));

  return DEVELOPMENT_ROLE_DEFINITIONS.map((definition) => {
    const needed = definition.dimensions.map((dimension) => byDimension.get(dimension)!);
    const unmeasured = needed.filter((entry) => entry.state === 'notMeasured');

    if (unmeasured.length > 0) {
      return {
        role: definition.role, summary: definition.summary, qualified: false,
        structuralStanding: 'notMeasured',
        reason: `NOT MEASURED — ${unmeasured.map((entry) => entry.dimension).join(' and ')} `
          + `${unmeasured.length === 1 ? 'has' : 'have'} no evidence for this candidate. ${DEVELOPMENT_NOT_MEASURED_REASON}`,
        interpretation: INTERPRETATION,
      };
    }

    const below = needed.filter((entry) => {
      const value = 'measured' in entry.structuralPassRateMilli ? entry.structuralPassRateMilli.measured : 0;
      return value < definition.minimumStructuralPassRateMilli;
    });
    const partial = needed.filter((entry) => entry.state === 'partiallyMeasured');
    const standing: StructuralStanding = below.length > 0 ? 'notMet' : partial.length > 0 ? 'partial' : 'met';

    const bar = (definition.minimumStructuralPassRateMilli / 10).toFixed(1);
    const structuralSentence = below.length > 0
      ? `the structural tier is below the bar of ${bar}% on `
        + below.map((entry) => `${entry.dimension} (${(('measured' in entry.structuralPassRateMilli ? entry.structuralPassRateMilli.measured : 0) / 10).toFixed(1)}%)`).join(', ')
      : partial.length > 0
        ? `the structural tier reached ${bar}% on what was run, but ${partial.map((entry) => `${entry.dimension} was graded on ${entry.gradedTaskCount} of ${entry.plannedTaskCount} task(s)`).join(' and ')}`
        : `the structural tier reached ${bar}% on ${needed.map((entry) => entry.dimension).join(' and ')}`;

    if (definition.requiresExecutedEvidence) {
      return {
        role: definition.role, summary: definition.summary, qualified: false,
        structuralStanding: standing,
        reason: `${structuralSentence}. This role is withheld regardless, because it would assert that this `
          + `candidate's code was run and worked, and it was not run: ${EXECUTED_TIER_NOT_MEASURED_REASON}`,
        interpretation: INTERPRETATION,
      };
    }

    if (standing !== 'met') {
      return {
        role: definition.role, summary: definition.summary, qualified: false,
        structuralStanding: standing, reason: structuralSentence, interpretation: INTERPRETATION,
      };
    }
    return {
      role: definition.role, summary: definition.summary, qualified: true,
      structuralStanding: 'met',
      reason: `${structuralSentence}, and this role asks for nothing that requires running the candidate's code`,
      interpretation: INTERPRETATION,
    };
  });
}

// MARK: - Eligibility

/**
 * What the development machinery may conclude, and — exactly as `qualification.ts` does — the set
 * deliberately has no approval value in it.
 */
export type DevelopmentEligibilityVerdict =
  | 'notMeasured'
  | 'measurementIncomplete'
  | 'structurallyBelowBar'
  | 'structurallyEvidencedPendingExecution'
  | 'eligibleForFurtherReview';

export interface DevelopmentEligibility {
  verdict: DevelopmentEligibilityVerdict;
  because: string;
  /** Which suites this candidate still has to run before any development statement can be made. */
  outstandingDimensions: DevelopmentDimension[];
}

export function assessDevelopmentEligibility(evidence: DevelopmentEvidence): DevelopmentEligibility {
  const outstanding = evidence.dimensions.filter((entry) => entry.state === 'notMeasured').map((entry) => entry.dimension);
  if (outstanding.length === ALL_DEVELOPMENT_DIMENSIONS.length) {
    return { verdict: 'notMeasured', because: DEVELOPMENT_NOT_MEASURED_REASON, outstandingDimensions: outstanding };
  }
  if (outstanding.length > 0 || evidence.dimensions.some((entry) => entry.state === 'partiallyMeasured')) {
    const partial = evidence.dimensions.filter((entry) => entry.state === 'partiallyMeasured');
    return {
      verdict: 'measurementIncomplete',
      because: [
        outstanding.length > 0 ? `no evidence at all on ${outstanding.join(', ')}` : '',
        partial.length > 0 ? partial.map((entry) => `${entry.dimension} graded on ${entry.gradedTaskCount} of ${entry.plannedTaskCount} task(s)`).join('; ') : '',
      ].filter((part) => part.length > 0).join('; '),
      outstandingDimensions: outstanding,
    };
  }

  const belowBar = evidence.dimensions.filter((entry) => {
    const value = 'measured' in entry.structuralPassRateMilli ? entry.structuralPassRateMilli.measured : 0;
    return value < 800;
  });
  if (belowBar.length > 0) {
    return {
      verdict: 'structurallyBelowBar',
      because: `the structural tier is below 80.0% on ${belowBar.map((entry) => entry.dimension).join(', ')}`,
      outstandingDimensions: [],
    };
  }

  const executedOutstanding = evidence.dimensions.some((entry) => dimensionDeclaresExecutedTier(entry.dimension));
  if (executedOutstanding) {
    return {
      verdict: 'structurallyEvidencedPendingExecution',
      because: 'every registered development task was graded and the structural tier cleared its bar. '
        + `What is still missing is the executed tier: ${EXECUTED_TIER_NOT_MEASURED_REASON}`,
      outstandingDimensions: [],
    };
  }
  return {
    verdict: 'eligibleForFurtherReview',
    because: 'every registered development task was graded and every declared metric was decided',
    outstandingDimensions: [],
  };
}

// MARK: - Reporting

const STATE_LABELS: Record<DevelopmentEvidenceState, string> = {
  notMeasured: 'NOT MEASURED',
  partiallyMeasured: 'PARTIALLY MEASURED',
  measured: 'MEASURED',
};

export function describeDevelopmentEvidence(evidence: DevelopmentEvidence): string[] {
  const lines = [`development evidence for ${evidence.candidate} (derived ${evidence.derivedAt})`];
  for (const entry of evidence.dimensions) {
    const rate = 'measured' in entry.structuralPassRateMilli
      ? `${(entry.structuralPassRateMilli.measured / 10).toFixed(1)}% of ${entry.gradedTaskCount} task(s) at full structural credit`
      : 'no rate';
    lines.push(`  ${entry.dimension}: ${STATE_LABELS[entry.state]} — ${rate}`);
    lines.push(`    ${entry.because}`);
    if (entry.shortcutSuspectedCount > 0) {
      lines.push(`    ${entry.shortcutSuspectedCount} task(s) tripped a shortcut probe; reported separately and never netted against the rate`);
    }
    if (!entry.executedTierMeasured && entry.metrics.some((metric) => metric.tier === 'executed')) {
      lines.push(`    executed tier: NOT MEASURED — ${entry.executedTierBecause}`);
    }
  }
  for (const role of assessDevelopmentRoles(evidence)) {
    lines.push(`  role ${role.role}: ${role.qualified ? 'qualified' : 'not qualified'} (structural ${role.structuralStanding})`);
  }
  const eligibility = assessDevelopmentEligibility(evidence);
  lines.push(`  eligibility: ${eligibility.verdict} — ${eligibility.because}`);
  if (!evidence.provenanceComplete) {
    lines.push(`  provenance incomplete: ${evidence.provenanceGaps.join(' | ')}`);
  }
  return lines;
}

/**
 * Which already-measured candidates have to run these suites before anything can be said about
 * their development capability.
 *
 * The answer is "all of them that have no development evidence", and the function exists so that
 * answer is computed from the evidence rather than typed into a report by hand.
 */
export function candidatesRequiringDevelopmentBenchmark(
  previouslyMeasured: string[], evidenceByCandidate: Map<string, DevelopmentEvidence>,
): { candidate: string; outstandingDimensions: DevelopmentDimension[] }[] {
  return [...new Set(previouslyMeasured)]
    .sort(compareCodePoints)
    .map((candidate) => {
      const evidence = evidenceByCandidate.get(candidate);
      const outstanding = evidence === undefined
        ? [...ALL_DEVELOPMENT_DIMENSIONS]
        : evidence.dimensions.filter((entry) => entry.state !== 'measured').map((entry) => entry.dimension);
      return { candidate, outstandingDimensions: outstanding };
    })
    .filter((row) => row.outstandingDimensions.length > 0);
}

/** Names every metric id the contract declares, for a report that wants to list what was measured. */
export function developmentMetricIDs(dimension: DevelopmentDimension): DevelopmentMetricID[] {
  return metricsForDimension(dimension).map((spec) => spec.id);
}
