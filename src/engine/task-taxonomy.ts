// Benchmark engine · THE ORDRA TASK TAXONOMY. One documented, versioned table from the task type of an
// Ordra pass to the crc2 query Cernum answers for it, and one pure function that applies it.
//
// WHAT THIS IS. Ordra knows what a pass is FOR — implement, fix, review — and how large it is; it does
// not know which `workspace:<dimension>` capability names that work. This file is that translation, and
// only that: a task type, a structural tier and a context requirement in, a `RouteCandidateQuery` out.
// The table and the justification for every row are in `docs/ordra-lane/task-taxonomy.md`; the version
// is `TASK_TAXONOMY_VERSION`.
//
// WHAT IT IS NOT, AND EACH OF THESE IS A RULE.
//
//   NOT A DEFAULT. A task type the table does not name, a tier that is not one of the three, and a
//   context requirement that is not a whole number of tokens are each REFUSED with the reason. Nothing
//   is guessed: a pass mapped to the wrong capability would be routed on evidence about different work,
//   and a candidate set for the wrong question reads exactly like one for the right question.
//   NOT A POLICY. Every row asks for zero marginal cost only, the V1 default; admitting metered routes is
//   a spending decision the owner makes, not a property of a task type. The query is answered by
//   `qualifiedRouteCandidates` exactly as if it had been written by hand.
//   NOT A RANKING. The output is a query. It picks no route.

import { RouteCandidateQuery, RoutingCostPolicy } from './routing-contract';
import { ALL_WORKSPACE_DIFFICULTY_TIERS, WorkspaceDifficultyTier } from './workspace-difficulty';
import { WorkspaceDimension } from './workspace-case';

export const TASK_TAXONOMY_VERSION = 'ctt1';

export type OrdraTaskType = 'implement' | 'fix' | 'test-repair' | 'refactor' | 'docs' | 'verify' | 'plan' | 'review';

export const ALL_ORDRA_TASK_TYPES: OrdraTaskType[] = ['implement', 'fix', 'test-repair', 'refactor', 'docs', 'verify', 'plan', 'review'];

/** One row of the table: what a task type asks the routing contract, beside the tier and context. */
export interface TaskTaxonomyRow {
  /** The workspace dimension whose qualification the task needs; the query asks for `workspace:<dimension>`. */
  dimension: WorkspaceDimension;
  costPolicy: RoutingCostPolicy;
  localOnly: boolean;
  preferSubscriptionOrFree: boolean;
}

const ZERO_MARGINAL = { costPolicy: 'zeroMarginalCostOnly', localOnly: false, preferSubscriptionOrFree: true } as const;

/**
 * THE TABLE, version ctt1. Changing a row changes which evidence a pass is routed on, so it is a new
 * version: the taxonomy test pins this exact table to `ctt1`.
 */
export const TASK_TAXONOMY: Readonly<Record<OrdraTaskType, TaskTaxonomyRow>> = {
  // New behaviour across the files it touches.
  implement: { dimension: 'multiFileEditing', ...ZERO_MARGINAL },
  // Finding a defect from what a failing check says, and repairing it.
  fix: { dimension: 'failureInterpretation', ...ZERO_MARGINAL },
  // Running the suite and bringing a failing test back to green.
  'test-repair': { dimension: 'testExecution', ...ZERO_MARGINAL },
  // Changing structure while leaving behaviour exactly as it was.
  refactor: { dimension: 'preservationUnderTransformation', ...ZERO_MARGINAL },
  // Writing documentation without touching what the pass did not ask to change.
  docs: { dimension: 'scopeDiscipline', ...ZERO_MARGINAL },
  // Meeting the stated contract, not merely the visible checks.
  verify: { dimension: 'contractOverVisibleTests', ...ZERO_MARGINAL },
  // Understanding a repository well enough to say what to change and where.
  plan: { dimension: 'repositoryComprehension', ...ZERO_MARGINAL },
  // Seeing what a change would break.
  review: { dimension: 'regressionAvoidance', ...ZERO_MARGINAL },
};

export interface TaskQueryRequest {
  /** The `cmk1:` key of the machine that will run the work. */
  machineKey: string;
  taskType: string;
  /** 1, 2 or 3 — as a number, a digit string, or the tier's own name `tier<n>`. */
  tier: number | string;
  /** The context the pass needs, in tokens: a positive whole number, or its decimal string. */
  contextTokens: number | string;
}

export type TaskQueryAnswer =
  | { ok: true; taxonomyVersion: typeof TASK_TAXONOMY_VERSION; taskType: OrdraTaskType; row: TaskTaxonomyRow; query: RouteCandidateQuery }
  | { ok: false; taxonomyVersion: typeof TASK_TAXONOMY_VERSION; refusals: string[] };

function tierFrom(value: number | string): WorkspaceDifficultyTier | undefined {
  const text = typeof value === 'number' ? (Number.isInteger(value) ? String(value) : '') : value.trim();
  const named = /^[0-9]+$/.test(text) ? `tier${text}` : text;
  return (ALL_WORKSPACE_DIFFICULTY_TIERS as string[]).includes(named) ? named as WorkspaceDifficultyTier : undefined;
}

function tokensFrom(value: number | string): number | undefined {
  const parsed = typeof value === 'number' ? value : (/^[0-9]+$/.test(value.trim()) ? Number(value.trim()) : NaN);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * The one translation both tables share: the same reading of the tier, the context and the machine key,
 * the same refusals in the same words, with the table's own version and type list named in them.
 */
function routeQueryUnder<Version extends string, Type extends string>(
  version: Version, types: readonly Type[], table: Readonly<Record<Type, TaskTaxonomyRow>>, request: TaskQueryRequest,
): { ok: true; taxonomyVersion: Version; taskType: Type; row: TaskTaxonomyRow; query: RouteCandidateQuery }
  | { ok: false; taxonomyVersion: Version; refusals: string[] } {
  const refusals: string[] = [];
  const taskType = request.taskType.trim();
  const known = (types as readonly string[]).includes(taskType);
  if (!known) {
    refusals.push(`task type '${request.taskType}' is not in task taxonomy ${version} (${types.join(', ')}); `
      + 'an unknown task type is refused, never mapped to a default capability');
  }
  const tier = tierFrom(request.tier);
  if (tier === undefined) {
    refusals.push(`structural tier '${String(request.tier)}' is not one of 1, 2, 3; an unknown tier is refused, never defaulted`);
  }
  const contextTokens = tokensFrom(request.contextTokens);
  if (contextTokens === undefined) {
    refusals.push(`context requirement '${String(request.contextTokens)}' is not a positive whole number of tokens`);
  }
  if (request.machineKey.trim() === '') refusals.push('no machine key was given; the query must name the machine the work runs on');
  if (refusals.length > 0 || !known || tier === undefined || contextTokens === undefined) {
    return { ok: false, taxonomyVersion: version, refusals };
  }
  const row = table[taskType as Type];
  return {
    ok: true, taxonomyVersion: version, taskType: taskType as Type, row,
    query: {
      machineKey: request.machineKey,
      capability: `workspace:${row.dimension}`,
      structuralTier: tier,
      minimumContextTokens: contextTokens,
      costPolicy: row.costPolicy,
      localOnly: row.localOnly,
      preferSubscriptionOrFree: row.preferSubscriptionOrFree,
    },
  };
}

/**
 * Translate one pass into its crc2 query under ctt1. PURE: reads nothing, writes nothing, and refuses rather
 * than defaults — every input that cannot be read is named in `refusals`, all of them at once.
 */
export function routeQueryForTask(request: TaskQueryRequest): TaskQueryAnswer {
  return routeQueryUnder(TASK_TAXONOMY_VERSION, ALL_ORDRA_TASK_TYPES, TASK_TAXONOMY, request);
}

// ---- ctt2, beside ctt1 and never a change to it ------------------------------------------------------
//
// ctt2 is ctt1's eight rows, unchanged, plus `preservation-critical`: work whose whole point is that what
// exists keeps working as the code moves forward — the capability the forward-compatibility pack
// (pack.cernum.workspace.forward-compat-one@1) exists to measure. It is chosen ONLY by asking for it by
// name; every caller that does not name a taxonomy is answered by ctt1, exactly as before.

export const TASK_TAXONOMY_CTT2_VERSION = 'ctt2';

/** Every task taxonomy version this module answers. An unknown version is refused, never defaulted. */
export type TaskTaxonomyVersion = typeof TASK_TAXONOMY_VERSION | typeof TASK_TAXONOMY_CTT2_VERSION;
export const ALL_TASK_TAXONOMY_VERSIONS: TaskTaxonomyVersion[] = [TASK_TAXONOMY_VERSION, TASK_TAXONOMY_CTT2_VERSION];

export type Ctt2TaskType = OrdraTaskType | 'preservation-critical';

export const ALL_CTT2_TASK_TYPES: Ctt2TaskType[] = [...ALL_ORDRA_TASK_TYPES, 'preservation-critical'];

/**
 * THE TABLE, version ctt2: ctt1's rows, each the same object, plus one. Changing a row is a new version; the
 * ctt2 test pins this exact table to `ctt2`.
 */
export const TASK_TAXONOMY_CTT2: Readonly<Record<Ctt2TaskType, TaskTaxonomyRow>> = {
  ...TASK_TAXONOMY,
  // Keeping what exists working while the code moves forward: forward-compatible change.
  'preservation-critical': { dimension: 'forwardCompatibilityReasoning', ...ZERO_MARGINAL },
};

export type Ctt2TaskQueryAnswer =
  | { ok: true; taxonomyVersion: typeof TASK_TAXONOMY_CTT2_VERSION; taskType: Ctt2TaskType; row: TaskTaxonomyRow; query: RouteCandidateQuery }
  | { ok: false; taxonomyVersion: typeof TASK_TAXONOMY_CTT2_VERSION; refusals: string[] };

/** Translate one pass into its crc2 query under ctt2. The same rules, refusals and purity as ctt1. */
export function routeQueryForTaskCtt2(request: TaskQueryRequest): Ctt2TaskQueryAnswer {
  return routeQueryUnder(TASK_TAXONOMY_CTT2_VERSION, ALL_CTT2_TASK_TYPES, TASK_TAXONOMY_CTT2, request);
}

/** Read a taxonomy version a caller asked for by name: the version, or the reason it is refused. */
export function taskTaxonomyVersionFrom(value: string): { ok: true; version: TaskTaxonomyVersion } | { ok: false; refusal: string } {
  const text = value.trim();
  return (ALL_TASK_TAXONOMY_VERSIONS as string[]).includes(text)
    ? { ok: true, version: text as TaskTaxonomyVersion }
    : { ok: false, refusal: `task taxonomy '${value}' is not one of ${ALL_TASK_TAXONOMY_VERSIONS.join(', ')}; `
      + 'an unknown taxonomy is refused, never defaulted' };
}

/** Translate one pass under the named version: ctt1 unless ctt2 is asked for explicitly. */
export function routeQueryForTaskUnder(version: TaskTaxonomyVersion, request: TaskQueryRequest): TaskQueryAnswer | Ctt2TaskQueryAnswer {
  return version === TASK_TAXONOMY_CTT2_VERSION ? routeQueryForTaskCtt2(request) : routeQueryForTask(request);
}
