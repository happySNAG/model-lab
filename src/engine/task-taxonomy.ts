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

function isTaskType(value: string): value is OrdraTaskType {
  return (ALL_ORDRA_TASK_TYPES as string[]).includes(value);
}

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
 * Translate one pass into its crc2 query. PURE: reads nothing, writes nothing, and refuses rather than
 * defaults — every input that cannot be read is named in `refusals`, all of them at once.
 */
export function routeQueryForTask(request: TaskQueryRequest): TaskQueryAnswer {
  const refusals: string[] = [];
  const taskType = request.taskType.trim();
  if (!isTaskType(taskType)) {
    refusals.push(`task type '${request.taskType}' is not in task taxonomy ${TASK_TAXONOMY_VERSION} (${ALL_ORDRA_TASK_TYPES.join(', ')}); `
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
  if (refusals.length > 0 || !isTaskType(taskType) || tier === undefined || contextTokens === undefined) {
    return { ok: false, taxonomyVersion: TASK_TAXONOMY_VERSION, refusals };
  }
  const row = TASK_TAXONOMY[taskType];
  return {
    ok: true, taxonomyVersion: TASK_TAXONOMY_VERSION, taskType, row,
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
