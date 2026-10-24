// Benchmark engine · A METRICS ROLLUP over recorded evidence, per route and per capability, written nowhere.
//
// WHAT IT IS. For every route the sealed workspace runs measured — and, inside each route, for every
// capability those runs exercised — it reports how many runs there were, the nearest-rank median and p90
// of wall-clock latency and of total tokens, what the runs cost where a price was recorded, and how often
// a run retried or failed. Capabilities are named exactly as `route-qualification.ts` names them:
// `workspace:<dimension>` from the sealed case, `workspace-tier:<tier>` from the difficulty profile.
//
// WHAT IT IS NOT, AND EACH OF THESE IS A RULE.
//
//   NOT A WRITER. It takes run rows as values and returns a value. Nothing is stored.
//   NOT A VERDICT AND NOT A RANKING. No figure here feeds `deriveRouteQualification`, and routes are listed
//   by key, not by any number. A route with a short p90 is not thereby a better route.
//   NOT A GUESS. Every figure comes from a field a sealed run recorded. A run that recorded no wall clock or
//   no token count is COUNTED AS MISSING beside the distribution, never filled in. A cost is known only
//   where every run in the group recorded one (`attemptMetricsFromRow`'s effective cost: a metered charge
//   priced at run time, or a measured zero for local weights). A subscription run's cost is a share of a
//   flat fee nobody reported, and one such run makes the group's cost unknown, with that reason. Nothing
//   here multiplies tokens by a price.
//
// THE POPULATIONS, DECIDED HERE ONCE.
//   latency, tokens   SCORED runs only — those not in `STATUSES_THAT_MEASURED_NO_WORK` — because a run the
//                     harness broke, or a provider declined, timed the harness or the 429 and not the model.
//                     This is the same split `workspace-aggregate.ts` makes for its model-timing columns.
//   failure rate      scored runs that did not pass, over scored runs. A `timeout` is scored and a failure.
//   retry rate        scored runs that used more than one attempt, over scored runs.
//   not-measured rate runs that measured no work, over all runs; providerDeclined ones counted apart.
//   cost              ALL runs: money spent on a run that broke was still spent.

import { compareCodePoints } from './canonical';
import { Quantity, attemptMetricsFromRow, measuredQuantity, unavailableQuantity, worstProvenance } from './frontier-metrics';
import { nearestRankMedian, nearestRankPercentile } from './percentile';
import { EffortLevel, ProviderID } from './provider';
import { WorkspaceCase } from './workspace-case';
import { WorkspaceDifficultyProfile, workspaceDifficultyProfileFor } from './workspace-difficulty';
import { STATUSES_THAT_MEASURED_NO_WORK, WorkspaceRunRow, workspaceRunWasProviderDeclined } from './workspace-aggregate';

export const METRICS_ROLLUP_SCHEMA = 'cmr1';

export const METRICS_ROLLUP_IS_RECORDED_EVIDENCE_ONLY =
  'Every figure here is read from fields the sealed runs recorded; nothing was stored to produce it and nothing '
  + 'was estimated. Medians and p90s are nearest-rank: each is a value some run recorded. A cost is shown only '
  + 'where every run in the group recorded one; otherwise it is unknown, with the reason. No figure here decides '
  + 'a qualification verdict, and routes are listed by key, never ranked.';

export interface MetricsRollupInputs {
  /** Workspace run rows, from any number of roots. Read, never written. */
  workspaceRows: WorkspaceRunRow[];
  /** Where the capability dimensions are read from. Absent: no `workspace:` capability rows. */
  workspaceCases?: WorkspaceCase[];
  /** Where the structural tiers are read from. Absent: no `workspace-tier:` capability rows. */
  difficultyProfiles?: WorkspaceDifficultyProfile[];
  /** Only this `provider:modelID`. Absent: every route the rows measured. */
  routeKey?: string;
  /** Only rows run at this effort. Absent: every effort, and each group lists the efforts it holds. */
  effort?: EffortLevel;
}

/** A distribution of one recorded figure. `missing` runs were in the population and recorded none. */
export interface MetricDistribution {
  count: number;
  missing: number;
  median: Quantity;
  p90: Quantity;
}

export interface MetricsCost {
  /** Runs whose effective cost was recorded (metered charge, or a local zero). */
  knownRunCount: number;
  unknownRunCount: number;
  /** Every run's cost summed, or unavailable when any run's cost is unknown. Never a partial sum. */
  totalMicroUSD: Quantity;
  /** `totalMicroUSD` over every run, rounded, under the same rule. */
  perRunMicroUSD: Quantity;
  /** Why the costs that are unknown are unknown, as the runs' own readers state it. */
  unknownBecause: string[];
}

export interface MetricsRollupEntry {
  /** `route` for every run of the route; a capability name otherwise. */
  capability: 'route' | string;
  runCount: number;
  scoredRunCount: number;
  passCount: number;
  failedRunCount: number;
  retriedRunCount: number;
  notMeasuredRunCount: number;
  providerDeclinedRunCount: number;
  wallClockMilliseconds: MetricDistribution;
  totalTokens: MetricDistribution;
  cost: MetricsCost;
  failureRateMilli: Quantity;
  retryRateMilli: Quantity;
  notMeasuredRateMilli: Quantity;
  billingBases: string[];
  efforts: string[];
  evidenceWindow?: { from: string; to: string };
  recordRoots: string[];
}

export interface MetricsRollupRoute {
  routeKey: string;
  provider: ProviderID;
  modelID: string;
  route: MetricsRollupEntry;
  /** One entry per capability the route's runs exercised, by name. Views of the same runs, not a partition. */
  capabilities: MetricsRollupEntry[];
  /** Runs whose case the supplied cases do not hold, and which therefore sit on no capability entry. */
  unclassifiedRunCount: number;
}

export interface MetricsRollup {
  schema: typeof METRICS_ROLLUP_SCHEMA;
  effort: EffortLevel | 'any';
  /** By route key, code point order. Not a ranking. */
  routes: MetricsRollupRoute[];
  /** Rows that name no provider or model, and so belong to no route. */
  unattributedRunCount: number;
  disclosure: string;
}

const text = (row: Record<string, unknown>, key: string): string | undefined =>
  (typeof row[key] === 'string' ? row[key] as string : undefined);
const num = (row: Record<string, unknown>, key: string): number | undefined =>
  (typeof row[key] === 'number' && Number.isFinite(row[key]) ? row[key] as number : undefined);

const scored = (row: Record<string, unknown>): boolean => !STATUSES_THAT_MEASURED_NO_WORK.includes(String(row.status));

function rate(numerator: number, denominator: number, reason: string): Quantity {
  return denominator === 0 ? unavailableQuantity(reason) : measuredQuantity(Math.round((numerator * 1000) / denominator));
}

function distribution(values: Quantity[], missingReason: string): MetricDistribution {
  const usable = values.filter((value) => value.provenance !== 'unavailable' && value.value !== undefined);
  const numbers = usable.map((value) => value.value as number);
  const median = nearestRankMedian(numbers);
  const p90 = nearestRankPercentile(numbers, 90);
  const provenance = worstProvenance(usable);
  return {
    count: usable.length,
    missing: values.length - usable.length,
    median: median === undefined ? unavailableQuantity(missingReason) : { provenance, value: median },
    p90: p90 === undefined ? unavailableQuantity(missingReason) : { provenance, value: p90 },
  };
}

function costOf(rows: Record<string, unknown>[]): MetricsCost {
  const costs = rows.map((row) => attemptMetricsFromRow(row)?.effectiveUserCostMicroUSD
    ?? unavailableQuantity('this run\'s row could not be read as metrics, so what it cost is not known'));
  const known = costs.filter((cost) => cost.provenance !== 'unavailable' && cost.value !== undefined);
  const unknownBecause = [...new Set(costs.filter((cost) => !known.includes(cost))
    .map((cost) => cost.note ?? 'not recorded'))].sort(compareCodePoints);
  const everyKnown = rows.length > 0 && known.length === rows.length;
  const total = known.reduce((sum, cost) => sum + (cost.value as number), 0);
  const provenance = worstProvenance(known);
  const unknown = rows.length === 0 ? 'no run is in this group, so there is no cost to report'
    : `${rows.length - known.length} of ${rows.length} run(s) recorded no cost, so the total is not known. It is not `
      + 'the sum of the others, and it is not zero.';
  return {
    knownRunCount: known.length,
    unknownRunCount: rows.length - known.length,
    totalMicroUSD: everyKnown ? { provenance, value: total } : unavailableQuantity(unknown),
    perRunMicroUSD: everyKnown ? { provenance, value: Math.round(total / rows.length) } : unavailableQuantity(unknown),
    unknownBecause,
  };
}

function entryOf(capability: string, runs: WorkspaceRunRow[]): MetricsRollupEntry {
  const rows = runs.map((run) => run.row);
  const scoredRows = rows.filter(scored);
  const passes = scoredRows.filter((row) => row.status === 'pass');
  const retried = scoredRows.filter((row) => (num(row, 'attemptsUsed') ?? 1) > 1);
  const notMeasured = rows.filter((row) => !scored(row));
  const instants = rows.map((row) => text(row, 'recordedAt')).filter((at): at is string => at !== undefined && !Number.isNaN(Date.parse(at)))
    .sort((a, b) => Date.parse(a) - Date.parse(b));
  const distinct = (key: string): string[] =>
    [...new Set(rows.map((row) => text(row, key)).filter((value): value is string => value !== undefined))].sort(compareCodePoints);
  const noScored = 'no run in this group measured the model\'s work, so there is no rate over scored runs';

  return {
    capability,
    runCount: rows.length,
    scoredRunCount: scoredRows.length,
    passCount: passes.length,
    failedRunCount: scoredRows.length - passes.length,
    retriedRunCount: retried.length,
    notMeasuredRunCount: notMeasured.length,
    providerDeclinedRunCount: notMeasured.filter(workspaceRunWasProviderDeclined).length,
    wallClockMilliseconds: distribution(scoredRows.map((row) => {
      const value = num(row, 'wallClockMilliseconds');
      return value === undefined ? unavailableQuantity('') : measuredQuantity(value);
    }), 'no scored run in this group recorded a wall-clock time'),
    totalTokens: distribution(scoredRows.map((row) => attemptMetricsFromRow(row)?.totalTokens ?? unavailableQuantity('')),
      'no scored run in this group recorded a total token count'),
    cost: costOf(rows),
    failureRateMilli: rate(scoredRows.length - passes.length, scoredRows.length, noScored),
    retryRateMilli: rate(retried.length, scoredRows.length, noScored),
    notMeasuredRateMilli: rate(notMeasured.length, rows.length, 'no run is in this group'),
    billingBases: distinct('billingBasis'),
    efforts: distinct('effort'),
    ...(instants.length === 0 ? {} : { evidenceWindow: { from: instants[0], to: instants[instants.length - 1] } }),
    recordRoots: runs.map((run) => run.recordRoot).sort(compareCodePoints),
  };
}

/** The capabilities one run counts toward, named as `route-qualification.ts` names them. */
function capabilitiesOf(row: Record<string, unknown>, inputs: MetricsRollupInputs): string[] | undefined {
  const caseID = text(row, 'caseID');
  if (caseID === undefined) return undefined;
  const sealedCase = inputs.workspaceCases?.find((entry) => entry.id === caseID);
  const profile = inputs.difficultyProfiles === undefined ? undefined : workspaceDifficultyProfileFor(inputs.difficultyProfiles, caseID);
  if (sealedCase === undefined && profile === undefined) return undefined;
  return [...(sealedCase?.dimensions ?? []).map((dimension) => `workspace:${dimension}`),
    ...(profile === undefined ? [] : [`workspace-tier:${profile.tier}`])];
}

/**
 * The rollup. PURE: every input is a value, nothing is read from or written to disk here.
 */
export function deriveMetricsRollup(inputs: MetricsRollupInputs): MetricsRollup {
  const byRoute = new Map<string, { provider: ProviderID; modelID: string; runs: WorkspaceRunRow[] }>();
  let unattributedRunCount = 0;
  for (const run of inputs.workspaceRows) {
    const provider = text(run.row, 'provider');
    const modelID = text(run.row, 'requestedModelID');
    if (provider === undefined || modelID === undefined || modelID.length === 0) { unattributedRunCount += 1; continue; }
    if (inputs.effort !== undefined && run.row.effort !== inputs.effort) continue;
    const routeKey = `${provider}:${modelID}`;
    if (inputs.routeKey !== undefined && routeKey !== inputs.routeKey) continue;
    const found = byRoute.get(routeKey);
    if (found === undefined) byRoute.set(routeKey, { provider: provider as ProviderID, modelID, runs: [run] });
    else found.runs.push(run);
  }

  const routes = [...byRoute.entries()].sort((a, b) => compareCodePoints(a[0], b[0])).map(([routeKey, { provider, modelID, runs }]) => {
    const byCapability = new Map<string, WorkspaceRunRow[]>();
    let unclassifiedRunCount = 0;
    for (const run of runs) {
      const capabilities = capabilitiesOf(run.row, inputs);
      if (capabilities === undefined) { unclassifiedRunCount += 1; continue; }
      for (const capability of capabilities) byCapability.set(capability, [...(byCapability.get(capability) ?? []), run]);
    }
    return {
      routeKey, provider, modelID,
      route: entryOf('route', runs),
      capabilities: [...byCapability.entries()].sort((a, b) => compareCodePoints(a[0], b[0]))
        .map(([capability, members]) => entryOf(capability, members)),
      unclassifiedRunCount,
    };
  });

  return {
    schema: METRICS_ROLLUP_SCHEMA,
    effort: inputs.effort ?? 'any',
    routes,
    unattributedRunCount,
    disclosure: METRICS_ROLLUP_IS_RECORDED_EVIDENCE_ONLY,
  };
}
