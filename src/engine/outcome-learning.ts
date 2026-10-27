// Benchmark engine · OUTCOME LEARNING (col1): the outcomes `cernum ingest-outcomes` sealed (cro1), aggregated per
// model, effort, ctt1 task type and machine key into what Ordra's real passes did, and written nowhere.
//
// WHAT A CELL IS. One (route, effort key, task type, machine key). The effort key is cek1's: an outcome whose
// session telemetry reported the effort it applied is keyed `provider:model@<applied>`; every other outcome is
// keyed `provider:model@unobservable:<requested|unrecorded>`, and the two are never pooled. The task type is the
// one the outcome line named; nothing here guesses it. The machine key is the one the outcome was recorded under.
//
// WHAT A CELL REPORTS. The outcomes it holds, how many passed, failed or were not verified, and how many were
// retries (attempt 2 or later of a pass); the success rate — passed over every outcome in the cell, because an
// attempt nobody verified is not a success — with its Wilson 95% interval; the verification pass rate — passed
// over the outcomes verification ran on; and the nearest-rank median and p90 of the duration Ordra recorded.
//
// THE RULES, EACH ENFORCED HERE.
//
//   OPERATIONAL, NEVER BENCHMARK. Every cell is labelled evidence class `ordra_operational`. Nothing here reads a
//   sealed benchmark run, and nothing here is handed to `deriveRouteQualification`, the qualification timeline or
//   the routing contract. The two classes are reported apart and never summed.
//   A MINIMUM SAMPLE BEFORE ANYTHING. A cell with fewer outcomes than the minimum (default 5, stated in the output)
//   is `insufficient`: it shows its counts and nothing derived from them, and it influences nothing.
//   NEVER A VERDICT. A sufficient cell may be SHOWN beside qualification evidence (`operationalEvidenceFor`), and
//   that is all. No outcome qualifies, disqualifies, ranks or excludes a route.
//   ONLY THE MODEL THAT ANSWERED. A substituted outcome measured another model, and an unreported one measured a
//   model nobody named; neither is credited to the requested route. Each is listed as excluded, with its reason.
//   NOT A WRITER. It takes the store's contents as a value and returns a value.

import { compareCodePoints } from './canonical';
import { EffortKey, compareEffortKeys, effortKeySuffix, effortRouteKey } from './effort-keyed-routes';
import { Quantity, measuredQuantity, reportedQuantity, unavailableQuantity } from './frontier-metrics';
import { ObservationStoreContents } from './observation-store';
import { nearestRankMedian, nearestRankPercentile } from './percentile';
import { ProviderID } from './provider';
import { RouteOutcome, routeOutcomesFrom } from './route-outcome-ingest';
import { WILSON_95_Z, wilsonInterval95Milli } from './route-recommendation-crr2';
import { ALL_ORDRA_TASK_TYPES, OrdraTaskType, TASK_TAXONOMY_VERSION } from './task-taxonomy';

export const OUTCOME_LEARNING_SCHEMA = 'col1';

/** The evidence class every figure here carries. Never `benchmark`. */
export const ORDRA_OPERATIONAL_EVIDENCE = 'ordra_operational';

/** Fewer outcomes than this in a cell and it is `insufficient`. Stated in every answer. */
export const DEFAULT_OUTCOME_MINIMUM_SAMPLE = 5;

export const OUTCOMES_ARE_OPERATIONAL_EVIDENCE_ONLY =
  'Every figure here is ordra_operational evidence: what Ordra\'s real passes reported, read from the outcomes '
  + 'cernum ingest-outcomes sealed. It is reported apart from benchmark evidence and never pooled with it. A cell '
  + 'below the minimum sample size is insufficient and influences nothing. A sufficient cell may be shown beside '
  + 'qualification evidence; no outcome changes a qualification verdict, a ranking or an exclusion.';

export interface OutcomeLearningQuery {
  /** Only outcomes whose line named this ctt1 task type. Absent: every task type. */
  taskType?: OrdraTaskType;
  /** Only outcomes recorded under this machine key. Absent: every machine. */
  machineKey?: string;
  /** Absent: `DEFAULT_OUTCOME_MINIMUM_SAMPLE`. */
  minimumSampleSize?: number;
}

export interface OutcomeCellEffort {
  effortRouteKey: string;
  state: EffortKey['state'];
  /** The applied effort the session reported; absent when unobservable. */
  effort?: string;
  /** What was asked for, or `unrecorded`. */
  requestedEffort: string;
}

export interface OutcomeCell {
  evidenceClass: typeof ORDRA_OPERATIONAL_EVIDENCE;
  routeKey: string;
  provider: ProviderID;
  modelID: string;
  effort: OutcomeCellEffort;
  taskType: OrdraTaskType;
  machineKey: string;
  sampleSize: number;
  minimumSampleSize: number;
  status: 'sufficient' | 'insufficient';
  /** What this cell may do: be shown beside qualification evidence, or nothing at all. Never a verdict. */
  influence: 'shownBesideQualification' | 'none';
  counts: { outcomes: number; passed: number; failed: number; notRun: number; retries: number };
  /** Passed over every outcome in the cell, in thousandths. */
  successRateMilli: Quantity;
  interval95: { method: 'wilson'; z: typeof WILSON_95_Z; lowerMilli: Quantity; upperMilli: Quantity };
  /** Passed over the outcomes verification ran on (passed + failed), in thousandths. */
  verificationPassRateMilli: Quantity;
  durationMilliseconds: { count: number; missing: number; median: Quantity; p90: Quantity };
  evidenceWindow?: { from: string; to: string };
  recordIDs: string[];
}

export type OutcomeExclusionCode = 'substituted' | 'unreported' | 'noTaskType';

export interface OutcomeExclusion {
  recordID: string;
  pass: string;
  attempt: number;
  routeKey: string;
  machineKey: string;
  reasonCode: OutcomeExclusionCode;
  reason: string;
}

export interface OutcomeLearning {
  schema: typeof OUTCOME_LEARNING_SCHEMA;
  evidenceClass: typeof ORDRA_OPERATIONAL_EVIDENCE;
  taxonomyVersion: typeof TASK_TAXONOMY_VERSION;
  query: { taskType: OrdraTaskType | 'any'; machineKey: string | 'any' };
  minimumSampleSize: number;
  /** By route, effort key, task type, then machine. Not a ranking. */
  cells: OutcomeCell[];
  excluded: OutcomeExclusion[];
  /** Outcomes the query read before any exclusion: every cell's sample plus every exclusion. */
  outcomesRead: number;
  disclosure: string;
}

export class OutcomeLearningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OutcomeLearningError';
  }
}

/** The cek1 effort key of one outcome. Observed only when the session's telemetry reported an applied effort. */
export function outcomeEffortKey(outcome: RouteOutcome): EffortKey {
  if (outcome.appliedEffort !== undefined && outcome.appliedEffort !== null) return { state: 'observed', effort: outcome.appliedEffort };
  return { state: 'unobservable', requestedEffort: outcome.requestedEffort ?? 'unrecorded' };
}

const milli = (numerator: number, denominator: number): number => Math.round((numerator * 1000) / denominator);

function cellOf(provider: ProviderID, modelID: string, key: EffortKey, taskType: OrdraTaskType, machineKey: string,
                members: { recordID: string; outcome: RouteOutcome }[], minimumSampleSize: number): OutcomeCell {
  const outcomes = members.map((member) => member.outcome);
  const passed = outcomes.filter((outcome) => outcome.verification === 'passed').length;
  const failed = outcomes.filter((outcome) => outcome.verification === 'failed').length;
  const sampleSize = outcomes.length;
  const sufficient = sampleSize >= minimumSampleSize;
  const withheld = unavailableQuantity(`insufficient: ${sampleSize} outcome(s), fewer than the minimum sample size of `
    + `${minimumSampleSize}, so nothing is derived from this cell and it influences nothing`);
  const durations = outcomes.map((outcome) => outcome.durationMilliseconds).filter((value): value is number => value !== null);
  const interval = sufficient ? wilsonInterval95Milli(passed, sampleSize) : undefined;
  const median = sufficient ? nearestRankMedian(durations) : undefined;
  const p90 = sufficient ? nearestRankPercentile(durations, 90) : undefined;
  const noDuration = unavailableQuantity('no outcome in this cell recorded a duration');
  const instants = outcomes.map((outcome) => outcome.recordedAt).sort((a, b) => Date.parse(a) - Date.parse(b));
  return {
    evidenceClass: ORDRA_OPERATIONAL_EVIDENCE,
    routeKey: `${provider}:${modelID}`,
    provider,
    modelID,
    effort: {
      effortRouteKey: effortRouteKey(provider, modelID, key),
      state: key.state,
      ...(key.state === 'observed' ? { effort: key.effort } : {}),
      requestedEffort: key.state === 'observed'
        ? [...new Set(outcomes.map((outcome) => outcome.requestedEffort ?? 'unrecorded'))].sort(compareCodePoints).join(',')
        : key.requestedEffort,
    },
    taskType,
    machineKey,
    sampleSize,
    minimumSampleSize,
    status: sufficient ? 'sufficient' : 'insufficient',
    influence: sufficient ? 'shownBesideQualification' : 'none',
    counts: {
      outcomes: sampleSize, passed, failed,
      notRun: outcomes.filter((outcome) => outcome.verification === 'notRun').length,
      retries: outcomes.filter((outcome) => outcome.attempt > 1).length,
    },
    successRateMilli: sufficient ? measuredQuantity(milli(passed, sampleSize)) : withheld,
    interval95: {
      method: 'wilson', z: WILSON_95_Z,
      lowerMilli: interval === undefined ? withheld : measuredQuantity(interval.lowerMilli),
      upperMilli: interval === undefined ? withheld : measuredQuantity(interval.upperMilli),
    },
    verificationPassRateMilli: !sufficient ? withheld : passed + failed === 0
      ? unavailableQuantity('verification ran on no outcome in this cell') : measuredQuantity(milli(passed, passed + failed)),
    durationMilliseconds: {
      count: durations.length,
      missing: sampleSize - durations.length,
      median: !sufficient ? withheld : median === undefined ? noDuration : reportedQuantity(median),
      p90: !sufficient ? withheld : p90 === undefined ? noDuration : reportedQuantity(p90),
    },
    ...(instants.length === 0 ? {} : { evidenceWindow: { from: instants[0]!, to: instants[instants.length - 1]! } }),
    recordIDs: members.map((member) => member.recordID).sort(compareCodePoints),
  };
}

/**
 * Aggregate the ingested outcomes in `contents`. PURE: nothing is read from or written to disk here.
 *
 * An outcome is read when it was recorded under the queried machine (any, when none is queried) and, when a task
 * type is queried, named that task type. Of those, a substituted or unreported outcome, and one that named no task
 * type, is excluded with its reason; every other outcome is in exactly one cell.
 */
export function deriveOutcomeLearning(contents: ObservationStoreContents, query: OutcomeLearningQuery = {}): OutcomeLearning {
  const minimumSampleSize = query.minimumSampleSize ?? DEFAULT_OUTCOME_MINIMUM_SAMPLE;
  if (!Number.isSafeInteger(minimumSampleSize) || minimumSampleSize < 1) {
    throw new OutcomeLearningError(`the minimum sample size is ${JSON.stringify(minimumSampleSize)}, not a whole number from 1`);
  }
  if (query.taskType !== undefined && !ALL_ORDRA_TASK_TYPES.includes(query.taskType)) {
    throw new OutcomeLearningError(`'${String(query.taskType)}' is not a ${TASK_TAXONOMY_VERSION} task type. `
      + `Use one of ${ALL_ORDRA_TASK_TYPES.join(', ')}.`);
  }

  const groups = new Map<string, { provider: ProviderID; modelID: string; key: EffortKey; taskType: OrdraTaskType; machineKey: string;
    members: { recordID: string; outcome: RouteOutcome }[] }>();
  const excluded: OutcomeExclusion[] = [];
  let outcomesRead = 0;
  for (const { stored, outcome } of routeOutcomesFrom(contents)) {
    const machineKey = stored.record.machineKey;
    if (query.machineKey !== undefined && machineKey !== query.machineKey) continue;
    if (query.taskType !== undefined && outcome.taskType !== query.taskType) continue;
    outcomesRead += 1;
    const recordID = stored.record.recordID;
    const exclude = (reasonCode: OutcomeExclusionCode, reason: string): void => {
      excluded.push({ recordID, pass: outcome.pass, attempt: outcome.attempt, routeKey: outcome.routeKey, machineKey, reasonCode, reason });
    };
    if (outcome.identity === 'substituted') {
      exclude('substituted', `requested ${outcome.requestedModel}, but the session reported ${String(outcome.actualModel)}; `
        + 'it measured another model and is not credited to the requested route');
      continue;
    }
    if (outcome.identity === 'unreported') {
      exclude('unreported', 'the session reported no model usage, so which model did the work is not known');
      continue;
    }
    if (outcome.taskType === undefined) {
      exclude('noTaskType', `the outcome line named no ${TASK_TAXONOMY_VERSION} task type, and none is guessed`);
      continue;
    }
    const key = outcomeEffortKey(outcome);
    const id = [outcome.routeKey, effortKeySuffix(key), outcome.taskType, machineKey].join('\u0000');
    const found = groups.get(id);
    if (found === undefined) {
      groups.set(id, { provider: outcome.provider, modelID: outcome.requestedModel, key, taskType: outcome.taskType, machineKey,
        members: [{ recordID, outcome }] });
    } else {
      found.members.push({ recordID, outcome });
    }
  }

  const cells = [...groups.values()]
    .sort((a, b) => compareCodePoints(`${a.provider}:${a.modelID}`, `${b.provider}:${b.modelID}`)
      || compareEffortKeys(a.key, b.key)
      || ALL_ORDRA_TASK_TYPES.indexOf(a.taskType) - ALL_ORDRA_TASK_TYPES.indexOf(b.taskType)
      || compareCodePoints(a.machineKey, b.machineKey))
    .map((group) => cellOf(group.provider, group.modelID, group.key, group.taskType, group.machineKey, group.members, minimumSampleSize));
  excluded.sort((a, b) => compareCodePoints(a.routeKey, b.routeKey) || compareCodePoints(a.pass, b.pass) || a.attempt - b.attempt
    || compareCodePoints(a.recordID, b.recordID));

  return {
    schema: OUTCOME_LEARNING_SCHEMA,
    evidenceClass: ORDRA_OPERATIONAL_EVIDENCE,
    taxonomyVersion: TASK_TAXONOMY_VERSION,
    query: { taskType: query.taskType ?? 'any', machineKey: query.machineKey ?? 'any' },
    minimumSampleSize,
    cells,
    excluded,
    outcomesRead,
    disclosure: OUTCOMES_ARE_OPERATIONAL_EVIDENCE_ONLY,
  };
}

/** What a reader such as crr2 may show beside a route's qualification evidence. Never an input to it. */
export interface OperationalEvidence {
  evidenceClass: typeof ORDRA_OPERATIONAL_EVIDENCE;
  /** Sufficient cells only. Empty when no cell for the route has the minimum sample. */
  cells: OutcomeCell[];
  /** Cells for the route held back as insufficient, by count only. */
  insufficientCellCount: number;
  disclosure: string;
}

/**
 * The sufficient cells for one route — matched by `effortRouteKey` when given, by `routeKey` otherwise — and the
 * task type and machine asked about. Insufficient cells are counted, never shown with figures.
 */
export function operationalEvidenceFor(learning: OutcomeLearning, route: {
  routeKey: string; effortRouteKey?: string; taskType: OrdraTaskType; machineKey: string;
}): OperationalEvidence {
  const matching = learning.cells.filter((cell) => cell.routeKey === route.routeKey && cell.taskType === route.taskType
    && cell.machineKey === route.machineKey && (route.effortRouteKey === undefined || cell.effort.effortRouteKey === route.effortRouteKey));
  return {
    evidenceClass: ORDRA_OPERATIONAL_EVIDENCE,
    cells: matching.filter((cell) => cell.status === 'sufficient'),
    insufficientCellCount: matching.filter((cell) => cell.status === 'insufficient').length,
    disclosure: OUTCOMES_ARE_OPERATIONAL_EVIDENCE_ONLY,
  };
}
