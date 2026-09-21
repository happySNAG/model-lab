// Model Lab core · development capability evidence, and the routing statements built on it.
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
  ALL_DEVELOPMENT_DIMENSIONS, DevelopmentDimension, DevelopmentMetricID, EXECUTED_TIER_NOT_MEASURED_REASON,
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

export interface DevelopmentDimensionEvidence {
  dimension: DevelopmentDimension;
  state: DevelopmentEvidenceState;
  because: string;
  plannedTaskCount: number;
  gradedTaskCount: number;
  /** Tasks where every gating STRUCTURAL metric reached its bar. */
  structuralFullCreditCount: number;
  /** Tasks graded `full` overall. Zero while any gating executed metric is unmeasured. */
  fullCreditCount: number;
  structuralPassRateMilli: Measurement<number>;
  /** Over held-out assertions only: the share the prompt did not give away. */
  heldOutPassRateMilli: Measurement<number>;
  shortcutSuspectedCount: number;
  /** False whenever this dimension's contract declares an executed metric. */
  executedTierMeasured: boolean;
  executedTierBecause: string;
  metrics: DevelopmentMetricRate[];
  taskIDs: string[];
}

export interface DevelopmentEvidence {
  candidate: string;
  dimensions: DevelopmentDimensionEvidence[];
  /** One record per graded task. Empty when nothing was measured. */
  provenance: DevelopmentProvenance[];
  provenanceComplete: boolean;
  /** Named gaps: `<taskID>: <field>`. A result whose provenance is incomplete is still published. */
  provenanceGaps: string[];
  derivedAt: string;
}

export interface DevelopmentPlan {
  /** How many tasks the registry holds for each dimension. The denominator for coverage. */
  plannedTaskCounts: Record<DevelopmentDimension, number>;
}

function rateMilli(passes: number, decided: number, noneReason: string): Measurement<number> {
  return decided === 0 ? unavailable(noneReason) : measured(Math.round((passes * 1_000) / decided));
}

function dimensionDeclaresExecutedTier(dimension: DevelopmentDimension): boolean {
  return metricsForDimension(dimension).some((spec) => spec.tier === 'executed');
}

/** The state of a candidate that has never run these suites. Every ranking starts here. */
export function noDevelopmentEvidence(candidate: string, plan: DevelopmentPlan, derivedAt: string): DevelopmentEvidence {
  return {
    candidate,
    dimensions: ALL_DEVELOPMENT_DIMENSIONS.map((dimension) => ({
      dimension,
      state: 'notMeasured' as const,
      because: DEVELOPMENT_NOT_MEASURED_REASON,
      plannedTaskCount: plan.plannedTaskCounts[dimension],
      gradedTaskCount: 0,
      structuralFullCreditCount: 0,
      fullCreditCount: 0,
      structuralPassRateMilli: unavailable(DEVELOPMENT_NOT_MEASURED_REASON),
      heldOutPassRateMilli: unavailable(DEVELOPMENT_NOT_MEASURED_REASON),
      shortcutSuspectedCount: 0,
      executedTierMeasured: false,
      executedTierBecause: dimensionDeclaresExecutedTier(dimension)
        ? EXECUTED_TIER_NOT_MEASURED_REASON
        : 'this dimension declares no executed metric; nothing is missing from it',
      metrics: [],
      taskIDs: [],
    })),
    provenance: [],
    provenanceComplete: false,
    provenanceGaps: ['no development task was run, so there is no provenance to be complete'],
    derivedAt,
  };
}

export function buildDevelopmentEvidence(
  candidate: string, results: DevelopmentTaskResult[], plan: DevelopmentPlan, derivedAt: string,
): DevelopmentEvidence {
  const empty = noDevelopmentEvidence(candidate, plan, derivedAt);
  if (results.length === 0) return empty;

  const dimensions = ALL_DEVELOPMENT_DIMENSIONS.map((dimension): DevelopmentDimensionEvidence => {
    const forDimension = results
      .filter((result) => result.dimension === dimension)
      .sort((a, b) => compareCodePoints(a.taskID, b.taskID));
    if (forDimension.length === 0) return empty.dimensions.find((entry) => entry.dimension === dimension)!;

    const planned = plan.plannedTaskCounts[dimension];
    const graded = forDimension.length;
    const structuralFull = forDimension.filter((result) => result.grade.structuralCredit === 'full').length;
    const full = forDimension.filter((result) => result.grade.credit === 'full').length;

    const heldOut = forDimension
      .map((result) => result.grade.heldOutPassRateMilli)
      .filter((value): value is { measured: number } => 'measured' in value);

    const metrics: DevelopmentMetricRate[] = metricsForDimension(dimension).map((spec) => {
      const statuses = forDimension
        .map((result) => result.grade.metrics.find((entry) => entry.id === spec.id))
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

    const state: DevelopmentEvidenceState = graded >= planned ? 'measured' : 'partiallyMeasured';
    return {
      dimension,
      state,
      because: state === 'measured'
        ? `every one of the ${planned} registered task(s) on this dimension was graded`
        : `${graded} of the ${planned} registered task(s) on this dimension were graded; the rate is correct over what was run and rests on part of the suite`,
      plannedTaskCount: planned,
      gradedTaskCount: graded,
      structuralFullCreditCount: structuralFull,
      fullCreditCount: full,
      structuralPassRateMilli: rateMilli(structuralFull, graded, 'no task on this dimension was graded'),
      heldOutPassRateMilli: heldOut.length === 0
        ? unavailable('no graded task on this dimension declared a held-out assertion')
        : measured(Math.round(heldOut.reduce((sum, value) => sum + value.measured, 0) / heldOut.length)),
      shortcutSuspectedCount: forDimension.filter((result) => result.grade.shortcutSuspected).length,
      executedTierMeasured: false,
      executedTierBecause: dimensionDeclaresExecutedTier(dimension)
        ? EXECUTED_TIER_NOT_MEASURED_REASON
        : 'this dimension declares no executed metric; nothing is missing from it',
      metrics,
      taskIDs: forDimension.map((result) => result.taskID),
    };
  });

  const provenance = results
    .map((result) => result.provenance)
    .filter((record): record is DevelopmentProvenance => record !== undefined)
    .sort((a, b) => compareCodePoints(a.taskID, b.taskID));

  const gaps: string[] = [];
  for (const result of results) {
    if (result.provenance === undefined) {
      gaps.push(`${result.taskID}: no provenance was recorded at all`);
      continue;
    }
    const { complete, missing } = provenanceIsComplete(result.provenance);
    if (!complete) gaps.push(`${result.taskID}: ${missing.join(', ')}`);
  }

  return {
    candidate,
    dimensions,
    provenance,
    provenanceComplete: gaps.length === 0,
    provenanceGaps: gaps,
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
