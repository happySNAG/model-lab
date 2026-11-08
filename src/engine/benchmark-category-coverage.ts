// Benchmark engine · how far the workspace cases a build carries reach into the twenty benchmark
// categories docs/VISION.md section 8 asks for (R-19).
//
// WHAT THIS IS. VISION.md lists twenty categories of work a benchmark should cover — simple edits,
// debugging, refactoring, failure recovery and so on. No case declares a category; cases declare
// workspace DIMENSIONS (`ALL_WORKSPACE_DIMENSIONS` in `workspace-case.ts`) and belong to a SUITE. This
// file is ONE documented, versioned mapping (`cbm1`) from each category to the dimensions and suites
// that exercise it, and one pure function that reads case DEFINITIONS and says, per category, whether
// the cases cover it, partly cover it, or do not reach it at all. The mapping and its justification are
// in `docs/ordra-lane/benchmark-category-coverage.md`.
//
// WHAT IT IS NOT, AND EACH OF THESE IS A RULE.
//
//   NOT A MEASUREMENT. It reads what cases DECLARE, never what any run did. A category reported
//   `covered` means cases exist that were built to exercise it, not that any model was tested on it or
//   did well. It reads no ledger, no evidence and no model output.
//   NOT A CATALOGUE CHANGE. It adds no case, no category and no suite, and it changes no case or pack:
//   the caller's cases are read, never written, so every `cwc1:` and pack digest is the same afterwards.
//   NOT STRETCHED. A category no dimension or suite honestly exercises maps to nothing and is
//   `uncovered`. Where the dimensions touch a category only in part, the mapping says so (`complete:
//   false`) and the category can be no better than `partial`, however many cases declare them.
//
// THE RULE (cbm1), per category, over the cases given:
//   a mapped dimension is SUPPORTED when at least one case declares it;
//   a mapped suite is SUPPORTED when at least one case belongs to it.
//   nothing mapped, or nothing mapped is supported          → uncovered
//   mapping complete AND every mapped item is supported     → covered
//   otherwise                                               → partial
// The supporting cases are every case that declares a mapped dimension or belongs to a mapped suite.

import { WorkspaceCase, WorkspaceDimension } from './workspace-case';

export const BENCHMARK_CATEGORY_COVERAGE_SCHEMA = 'cbc1';
export const BENCHMARK_CATEGORY_MAPPING_ID = 'cbm1';

/** The twenty categories, exactly as docs/VISION.md section 8 lists them, in its order. */
export const BENCHMARK_CATEGORIES = [
  'Simple code edits',
  'Complex code changes',
  'New feature implementation',
  'Application UI implementation',
  'Frontend development',
  'Backend development',
  'API integration',
  'Architecture and system design',
  'Code review',
  'Debugging',
  'Test creation',
  'Test repair',
  'Refactoring',
  'Documentation',
  'Repository maintenance',
  'Merge-sensitive tasks',
  'Long-context work',
  'Multi-step autonomous development',
  'Failure recovery',
  'Cross-project integration',
] as const;

export type BenchmarkCategory = typeof BENCHMARK_CATEGORIES[number];

export interface BenchmarkCategoryMappingEntry {
  /** Workspace dimensions whose declaration means a case was built to exercise this category. */
  dimensions: readonly WorkspaceDimension[];
  /** Suite ids every case of which exercises this category. */
  suites: readonly string[];
  /**
   * True only when the mapped dimensions and suites, together, are the whole of the category. False
   * when they touch part of it — the category can then be at best `partial`.
   */
  complete: boolean;
  /** Why these, and what is missing. */
  rationale: string;
}

export type BenchmarkCategoryMapping = Readonly<Record<BenchmarkCategory, BenchmarkCategoryMappingEntry>>;

const NOTHING = (rationale: string): BenchmarkCategoryMappingEntry => ({ dimensions: [], suites: [], complete: false, rationale });

/**
 * THE MAPPING, cbm1. Changing an entry changes what a report means, so it is a new id: the test pins
 * this exact table to `cbm1`. No registered suite is organised by category, so no suite is mapped.
 */
export const BENCHMARK_CATEGORY_MAPPING: BenchmarkCategoryMapping = {
  'Simple code edits': {
    dimensions: ['fileLocation', 'scopeDiscipline'], suites: [], complete: false,
    rationale: 'finding the one place to change and changing only that; no dimension records that the edit was small',
  },
  'Complex code changes': {
    dimensions: ['multiFileEditing', 'interactingInvariantReasoning'], suites: [], complete: false,
    rationale: 'coordinated edits across files and components whose invariants must agree; size and depth are not declared',
  },
  'New feature implementation': NOTHING('no dimension records that a case adds new behaviour rather than repairing old'),
  'Application UI implementation': NOTHING('no case or dimension concerns a user interface'),
  'Frontend development': NOTHING('no case or dimension concerns frontend code'),
  'Backend development': NOTHING('no dimension distinguishes backend work'),
  'API integration': NOTHING('no case or dimension concerns calling or integrating an external API'),
  'Architecture and system design': {
    dimensions: ['interactingInvariantReasoning'], suites: [], complete: false,
    rationale: 'reasoning about how two components must agree is one part of design; choosing a structure is not declared',
  },
  'Code review': NOTHING('no case asks for a review of a change'),
  Debugging: {
    dimensions: ['failureInterpretation', 'recoveryFromError', 'verificationDrivenRecovery'], suites: [], complete: true,
    rationale: 'diagnosis from a failing check and repair from it, the same three dimensions ccm1 derives debugging from',
  },
  'Test creation': NOTHING('testExecution is running tests; no dimension records writing them'),
  'Test repair': NOTHING('no dimension records repairing a test rather than the code under it'),
  Refactoring: {
    dimensions: ['preservationUnderTransformation', 'regressionAvoidance'], suites: [], complete: false,
    rationale: 'changing what is asked while behaviour elsewhere stays the same; restructuring code is not declared',
  },
  Documentation: NOTHING('no case asks for documentation'),
  'Repository maintenance': NOTHING('no dimension concerns dependency, build or housekeeping work'),
  'Merge-sensitive tasks': NOTHING('no case involves merges or concurrent branches'),
  'Long-context work': NOTHING('repositoryComprehension cases use small fixtures; no dimension declares a long context'),
  'Multi-step autonomous development': {
    dimensions: ['autonomousCompletion', 'toolUse'], suites: [], complete: true,
    rationale: 'finishing a multi-step task without help, using the tools the workspace offers',
  },
  'Failure recovery': {
    dimensions: ['recoveryFromError', 'verificationDrivenRecovery', 'secondAttemptAdaptation'], suites: [], complete: true,
    rationale: 'the three retry dimensions: recovering, recovering from the engine report, and changing approach on a second attempt',
  },
  'Cross-project integration': NOTHING('every case is a single repository'),
};

export type BenchmarkCategoryCoverageState = 'covered' | 'partial' | 'uncovered';

export interface BenchmarkCategoryCoverageEntry {
  category: BenchmarkCategory;
  state: BenchmarkCategoryCoverageState;
  mappingComplete: boolean;
  mappedDimensions: WorkspaceDimension[];
  mappedSuites: string[];
  /** Mapped dimensions at least one case declares, in mapping order. */
  supportedDimensions: WorkspaceDimension[];
  unsupportedDimensions: WorkspaceDimension[];
  supportedSuites: string[];
  unsupportedSuites: string[];
  /** Every case that declares a mapped dimension or belongs to a mapped suite, sorted, once each. */
  caseIDs: string[];
  reason: string;
}

export interface BenchmarkCategoryCoverageTotals {
  categories: number;
  covered: number;
  partial: number;
  uncovered: number;
  /** Distinct case ids read. */
  casesConsidered: number;
}

export interface BenchmarkCategoryCoverageReport {
  schema: typeof BENCHMARK_CATEGORY_COVERAGE_SCHEMA;
  mappingID: typeof BENCHMARK_CATEGORY_MAPPING_ID;
  categories: BenchmarkCategoryCoverageEntry[];
  totals: BenchmarkCategoryCoverageTotals;
  disclosure: string;
}

/** Only what the report reads from a case. A full `WorkspaceCase` satisfies it. */
export type BenchmarkCategoryCaseInput = Pick<WorkspaceCase, 'id' | 'suiteID' | 'dimensions'>;

export const DECLARED_IS_NOT_MEASURED =
  'Coverage here is what case definitions DECLARE, not what any run measured: a covered category has cases built to '
  + 'exercise it, not evidence that any model can do it.';

const sorted = (values: Iterable<string>): string[] => [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

function stateOf(mapping: BenchmarkCategoryMappingEntry, supported: number, mapped: number): BenchmarkCategoryCoverageState {
  if (mapped === 0 || supported === 0) return 'uncovered';
  return mapping.complete && supported === mapped ? 'covered' : 'partial';
}

function reasonOf(entry: Omit<BenchmarkCategoryCoverageEntry, 'reason'>, rationale: string): string {
  const mapped = [...entry.mappedDimensions, ...entry.mappedSuites];
  const missing = [...entry.unsupportedDimensions, ...entry.unsupportedSuites];
  if (mapped.length === 0) return `nothing maps to this category: ${rationale}`;
  if (entry.state === 'uncovered') return `no case declares ${mapped.join(', ')}`;
  const caseCount = `${entry.caseIDs.length} case${entry.caseIDs.length === 1 ? '' : 's'}`;
  if (entry.state === 'covered') return `${caseCount} declare ${mapped.join(', ')}`;
  const why = [
    ...(missing.length > 0 ? [`no case declares ${missing.join(', ')}`] : []),
    ...(entry.mappingComplete ? [] : [`the mapping is incomplete: ${rationale}`]),
  ];
  return `${caseCount} declare ${[...entry.supportedDimensions, ...entry.supportedSuites].join(', ')}; ${why.join('; ')}`;
}

/**
 * The report, cbc1. PURE: it reads `id`, `suiteID` and `dimensions` from each case and returns a new
 * value. No case is changed, and the result depends only on the cases' contents, not their order.
 * `mapping` is for tests; every real caller uses cbm1.
 */
export function deriveBenchmarkCategoryCoverage(
  cases: readonly BenchmarkCategoryCaseInput[],
  mapping: BenchmarkCategoryMapping = BENCHMARK_CATEGORY_MAPPING,
): BenchmarkCategoryCoverageReport {
  const categories = BENCHMARK_CATEGORIES.map((category): BenchmarkCategoryCoverageEntry => {
    const entry = mapping[category];
    const casesDeclaring = (dimension: WorkspaceDimension) => cases.filter((c) => c.dimensions.includes(dimension));
    const casesIn = (suite: string) => cases.filter((c) => c.suiteID === suite);
    const mappedDimensions = [...entry.dimensions];
    const mappedSuites = [...entry.suites];
    const supportedDimensions = mappedDimensions.filter((dimension) => casesDeclaring(dimension).length > 0);
    const supportedSuites = mappedSuites.filter((suite) => casesIn(suite).length > 0);
    const caseIDs = sorted([
      ...mappedDimensions.flatMap(casesDeclaring), ...mappedSuites.flatMap(casesIn),
    ].map((c) => c.id));
    const state = stateOf(entry, supportedDimensions.length + supportedSuites.length, mappedDimensions.length + mappedSuites.length);
    const partialEntry = {
      category, state, mappingComplete: entry.complete, mappedDimensions, mappedSuites,
      supportedDimensions, unsupportedDimensions: mappedDimensions.filter((d) => !supportedDimensions.includes(d)),
      supportedSuites, unsupportedSuites: mappedSuites.filter((s) => !supportedSuites.includes(s)),
      caseIDs,
    };
    return { ...partialEntry, reason: reasonOf(partialEntry, entry.rationale) };
  });
  const count = (state: BenchmarkCategoryCoverageState) => categories.filter((entry) => entry.state === state).length;
  return {
    schema: BENCHMARK_CATEGORY_COVERAGE_SCHEMA,
    mappingID: BENCHMARK_CATEGORY_MAPPING_ID,
    categories,
    totals: {
      categories: categories.length,
      covered: count('covered'),
      partial: count('partial'),
      uncovered: count('uncovered'),
      casesConsidered: sorted(cases.map((c) => c.id)).length,
    },
    disclosure: `${BENCHMARK_CATEGORY_MAPPING_ID}: categories from docs/VISION.md section 8 mapped to workspace dimensions and suites. `
      + DECLARED_IS_NOT_MEASURED,
  };
}

/** One line per category. */
export function describeBenchmarkCategoryCoverage(entry: BenchmarkCategoryCoverageEntry): string {
  return [entry.category.padEnd(34), entry.state.padEnd(9), entry.caseIDs.join(' ')].join('  ').trimEnd();
}
