// Benchmark engine · A REGRESSION DETECTOR over recorded evidence: each route's latest qualification
// evidence compared with its own history, under versioned thresholds, and written nowhere.
//
// WHAT IT IS. For every route the sealed workspace runs measured (or the one route asked about) it reports
//   a VERDICT DOWNGRADE   the route's latest qualification verdict, or one capability's, is worse than a
//                         verdict it held earlier in its own timeline (`deriveQualificationHistory`);
//   a SUCCESS-RATE DROP   the latest window of scored runs passed less often than the runs before it, by
//                         more than the threshold;
//   a p90 INCREASE        the latest window's nearest-rank p90 wall clock, or p90 total tokens, exceeds the
//                         earlier runs' p90 by more than the threshold (`deriveMetricsRollup` over each window);
// and, beside them, the STALE QUALIFICATION findings that already exist: `qualificationStaleness` as the
// qualification read model applies it now, the reason a `requireFreshQualification` query would give, and
// every `qualificationStaleness` observation the store holds about the route on the machine asked about.
//
// WHAT IT IS NOT, AND EACH OF THESE IS A RULE.
//
//   NOT A WRITER, AND NOT A VERDICT. It takes the store's contents and the run rows as values and returns a
//   value. It changes no verdict, no record and no policy: cqp1 decides qualification exactly as before, and
//   no finding here is read by `deriveRouteQualification`, the routing contract or the fallback chain.
//   NOT A SECOND QUALIFICATION RULE. Every verdict compared is a `deriveRouteQualification` record from the
//   qualification history; every figure compared is a `deriveMetricsRollup` figure. Nothing is re-decided.
//   NOT A GUESS. A comparison with too few runs on either side, or a p90 one side never recorded, is
//   `notComparable`, with the reason — never a regression and never a clean bill.

import { compareCodePoints } from './canonical';
import { QualificationStalenessReason } from './discovery-refresh';
import { MetricsRollupEntry, deriveMetricsRollup } from './metrics-rollup';
import { ObservationStoreContents, latestDiscoverySnapshot } from './observation-store';
import { EffortLevel, ProviderID } from './provider';
import { deriveQualificationHistory, parseRouteKey } from './qualification-history';
import {
  CapabilityVerdict, QualificationPolicy, RouteBlockerKind, V1_QUALIFICATION_POLICY, deriveRouteQualification,
} from './route-qualification';
import { RouteSpendPosture } from './route-spend-posture';
import { observationsForRouting, qualifiedRouteCandidates } from './routing-contract';
import { CURRENT_ROUTING_POLICY_VERSION, RoutingPolicyVersion } from './routing-policy';
import { WorkspaceCase } from './workspace-case';
import { WorkspaceDifficultyProfile } from './workspace-difficulty';
import { STATUSES_THAT_MEASURED_NO_WORK, WorkspaceRunRow } from './workspace-aggregate';

export const REGRESSION_REPORT_SCHEMA = 'crg1';

/** What counts as a regression, as numbers somebody can read and change. */
export interface RegressionThresholds {
  thresholdsID: string;
  /** The latest window: this route's most recent N dated scored runs. */
  latestWindowScoredRuns: number;
  /** The scored runs before the window needed for any metric comparison. */
  minimumBaselineScoredRuns: number;
  /** A success-rate drop is flagged when baseline − latest is MORE than this, in thousandths. */
  successRateDropMilli: number;
  /** A p90 increase is flagged when latest is MORE than baseline × (100 + this) / 100. */
  p90WallClockIncreasePercent: number;
  p90TotalTokensIncreasePercent: number;
}

/**
 * crt1. The window is cqp1's minimum scored runs, so the latest evidence is the least a verdict may rest
 * on. 100‰ is ten percentage points: with three runs in the window, one failure more than history
 * predicts is already beyond it. 50% on a p90 is a change no run-to-run noise in the recorded matrices
 * has come near.
 */
export const V1_REGRESSION_THRESHOLDS: RegressionThresholds = {
  thresholdsID: 'crt1',
  latestWindowScoredRuns: 3,
  minimumBaselineScoredRuns: 3,
  successRateDropMilli: 100,
  p90WallClockIncreasePercent: 50,
  p90TotalTokensIncreasePercent: 50,
};

export const REGRESSIONS_ARE_DETECTION_ONLY =
  'Detection only. Every verdict compared here is re-derived from the evidence as it stood, every figure is read '
  + 'from fields the sealed runs recorded, and each comparison uses the thresholds named on this report. No verdict, '
  + 'record or policy was changed, and nothing was written: a regression flagged here routes nothing away until a '
  + 'person, or the qualification policy itself, acts on the evidence behind it.';

export class RegressionDetectorError extends Error {
  constructor(readonly code: 'invalidThresholds', message: string) {
    super(message);
    this.name = 'RegressionDetectorError';
  }
}

export interface RegressionDetectorInputs {
  /** The `cmk1:` key verdicts and staleness are answered for. */
  machineKey: string;
  contents: ObservationStoreContents;
  /** Workspace run rows, from any number of roots. Read, never written. */
  workspaceRows: WorkspaceRunRow[];
  workspaceCases?: WorkspaceCase[];
  difficultyProfiles?: WorkspaceDifficultyProfile[];
  /** Only this `provider:modelID`. Absent: every route the rows measured. */
  routeKey?: string;
  effort?: EffortLevel;
  policy?: QualificationPolicy;
  routingPolicyVersion?: RoutingPolicyVersion;
  thresholds?: RegressionThresholds;
  /** Who pays for a route, as of an instant. Asked per route and per instant, because a posture can expire. */
  spendFor?: (route: { provider: ProviderID; modelID: string }, at: Date) => RouteSpendPosture;
  currentDriverID?: string;
  /** The instant staleness is answered for. */
  now: Date;
}

export type RegressionFindingKind =
  'verdictDowngrade' | 'successRateDrop' | 'p90LatencyIncrease' | 'p90TokenIncrease' | 'staleQualification';

/** One thing worth a person's attention, in one sentence. The evidence is on the route beside it. */
export interface RegressionFinding {
  kind: RegressionFindingKind;
  /** `route`, or the capability the finding is about. */
  scope: string;
  summary: string;
}

export interface VerdictDowngrade {
  scope: 'route' | string;
  /** The better verdict, and the latest entry at which it was last held. */
  from: 'safeToRoute' | CapabilityVerdict;
  heldAt: string;
  to: 'notRoutable' | CapabilityVerdict | 'absent';
  latestAt: string;
  /** For the route, the latest entry's blockers; for a capability, its latest pass count. */
  because: string[];
}

export interface RunWindow {
  scoredRunCount: number;
  passCount: number;
  from?: string;
  to?: string;
  recordRoots: string[];
}

export interface MetricComparison {
  metric: 'successRateMilli' | 'p90WallClockMilliseconds' | 'p90TotalTokens';
  baseline?: number;
  latest?: number;
  /** latest − baseline, in the metric's own unit. */
  change?: number;
  threshold: string;
  state: 'regressed' | 'withinThreshold' | 'notComparable';
  reason: string;
}

export interface RouteRegressionReport {
  routeKey: string;
  provider: ProviderID;
  modelID: string;
  /** The newest entry of the route's qualification history. */
  latest?: { recordedAt: string; verdict: 'safeToRoute' | 'notRoutable'; routableCapabilities: string[]; blockerKinds: RouteBlockerKind[] };
  historyEntryCount: number;
  downgrades: VerdictDowngrade[];
  windows: { baseline: RunWindow; latest: RunWindow };
  comparisons: MetricComparison[];
  staleness: {
    /** `qualificationStaleness` as the qualification read model applies it at `derivedAt`. */
    derived?: { valid: boolean; reasons: QualificationStalenessReason[]; detail: string[] };
    /** The reason a `requireFreshQualification` query gives for this route now, if it gives one. */
    freshQualificationQueryReason?: string;
    /** `qualificationStaleness` observations about the route on this machine, oldest first. */
    recorded: { observedAt: string; reasons: string[]; detail: string[] }[];
  };
  findings: RegressionFinding[];
}

export interface RegressionReport {
  schema: typeof REGRESSION_REPORT_SCHEMA;
  thresholds: RegressionThresholds;
  qualificationPolicyID: string;
  routingPolicyVersion: RoutingPolicyVersion;
  machineKey: string;
  effort: EffortLevel | 'any';
  derivedAt: string;
  /** By route key, code point order. Not a ranking. */
  routes: RouteRegressionReport[];
  /** Routes with at least one verdict downgrade, success-rate drop or p90 increase. */
  regressedRouteCount: number;
  /** Routes whose qualification is stale now. Counted apart: staleness is age and drift, not regression. */
  staleRouteCount: number;
  /** Runs whose `recordedAt` could not be read as an instant, and so sit in no window. */
  undatedWorkspaceRuns: string[];
  corrupt: ObservationStoreContents['corrupt'];
  disclosure: string;
}

const text = (row: Record<string, unknown>, key: string): string | undefined =>
  (typeof row[key] === 'string' ? row[key] as string : undefined);
const instant = (value: unknown): number | undefined => {
  if (typeof value !== 'string') return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
};

/** Better verdicts rank higher. An exercise that never happened is no better than too few runs. */
const VERDICT_RANK: Record<CapabilityVerdict | 'absent', number> = {
  qualified: 2, insufficientEvidence: 1, notExercised: 1, absent: 1, notQualified: 0,
};

function validateThresholds(thresholds: RegressionThresholds): void {
  const counts = [thresholds.latestWindowScoredRuns, thresholds.minimumBaselineScoredRuns];
  const limits = [thresholds.successRateDropMilli, thresholds.p90WallClockIncreasePercent, thresholds.p90TotalTokensIncreasePercent];
  if (thresholds.thresholdsID.length === 0 || !counts.every((value) => Number.isInteger(value) && value >= 1)
      || !limits.every((value) => Number.isInteger(value) && value >= 0) || thresholds.successRateDropMilli > 1000) {
    throw new RegressionDetectorError('invalidThresholds',
      `thresholds ${thresholds.thresholdsID || '(unnamed)'} are not usable: both windows need a whole number of runs of at `
      + 'least 1, every limit must be a whole number of at least 0, a success-rate drop is at most 1000‰, and the '
      + 'thresholds need an id. Nothing was compared.');
  }
}

function windowOf(runs: WorkspaceRunRow[]): RunWindow {
  const instants = runs.map((run) => text(run.row, 'recordedAt') as string);
  return {
    scoredRunCount: runs.length,
    passCount: runs.filter((run) => run.row.status === 'pass').length,
    ...(instants.length === 0 ? {} : { from: instants[0], to: instants[instants.length - 1] }),
    recordRoots: runs.map((run) => run.recordRoot),
  };
}

function p90Comparison(metric: 'p90WallClockMilliseconds' | 'p90TotalTokens', percent: number,
  baseline: MetricsRollupEntry['wallClockMilliseconds'], latest: MetricsRollupEntry['wallClockMilliseconds']): MetricComparison {
  const threshold = `flagged when the latest p90 is more than ${100 + percent}% of the baseline p90`;
  const before = baseline.p90.provenance === 'unavailable' ? undefined : baseline.p90.value;
  const after = latest.p90.provenance === 'unavailable' ? undefined : latest.p90.value;
  if (before === undefined || after === undefined) {
    return { metric, ...(before === undefined ? {} : { baseline: before }), ...(after === undefined ? {} : { latest: after }),
      threshold, state: 'notComparable',
      reason: `the ${before === undefined ? 'baseline' : 'latest'} window recorded no ${metric === 'p90TotalTokens' ? 'token count' : 'wall clock'}, so there is no p90 to compare` };
  }
  const regressed = after * 100 > before * (100 + percent);
  return { metric, baseline: before, latest: after, change: after - before, threshold,
    state: regressed ? 'regressed' : 'withinThreshold',
    reason: `p90 ${before} → ${after} over ${baseline.count} and ${latest.count} recorded run(s)` };
}

/** The metric comparisons for one route: its latest window of scored runs against every scored run before it. */
function compareWindows(scored: WorkspaceRunRow[], routeKey: string, thresholds: RegressionThresholds):
  { windows: RouteRegressionReport['windows']; comparisons: MetricComparison[] } {
  const latestRuns = scored.slice(Math.max(0, scored.length - thresholds.latestWindowScoredRuns));
  const baselineRuns = scored.slice(0, scored.length - latestRuns.length);
  const windows = { baseline: windowOf(baselineRuns), latest: windowOf(latestRuns) };
  const successThreshold = `flagged when the success rate falls by more than ${thresholds.successRateDropMilli}‰`;

  if (latestRuns.length < thresholds.latestWindowScoredRuns || baselineRuns.length < thresholds.minimumBaselineScoredRuns) {
    const reason = `${scored.length} dated scored run(s); ${thresholds.thresholdsID} compares the latest `
      + `${thresholds.latestWindowScoredRuns} with at least ${thresholds.minimumBaselineScoredRuns} before them. `
      + 'This is an absence of history, not a clean result.';
    return { windows, comparisons: [
      { metric: 'successRateMilli', threshold: successThreshold, state: 'notComparable', reason },
      { metric: 'p90WallClockMilliseconds', threshold: `flagged when the latest p90 is more than ${100 + thresholds.p90WallClockIncreasePercent}% of the baseline p90`, state: 'notComparable', reason },
      { metric: 'p90TotalTokens', threshold: `flagged when the latest p90 is more than ${100 + thresholds.p90TotalTokensIncreasePercent}% of the baseline p90`, state: 'notComparable', reason },
    ] };
  }

  const rollupOf = (runs: WorkspaceRunRow[]): MetricsRollupEntry => deriveMetricsRollup({ workspaceRows: runs, routeKey }).routes[0].route;
  const before = rollupOf(baselineRuns);
  const after = rollupOf(latestRuns);
  const baselineRate = Math.round((before.passCount * 1000) / before.scoredRunCount);
  const latestRate = Math.round((after.passCount * 1000) / after.scoredRunCount);
  return { windows, comparisons: [
    { metric: 'successRateMilli', baseline: baselineRate, latest: latestRate, change: latestRate - baselineRate,
      threshold: successThreshold,
      state: baselineRate - latestRate > thresholds.successRateDropMilli ? 'regressed' : 'withinThreshold',
      reason: `${before.passCount}/${before.scoredRunCount} passed before; ${after.passCount}/${after.scoredRunCount} in the latest window` },
    p90Comparison('p90WallClockMilliseconds', thresholds.p90WallClockIncreasePercent, before.wallClockMilliseconds, after.wallClockMilliseconds),
    p90Comparison('p90TotalTokens', thresholds.p90TotalTokensIncreasePercent, before.totalTokens, after.totalTokens),
  ] };
}

/**
 * The report. PURE: every input is a value, nothing is read from or written to disk here.
 *
 * Throws `QualificationHistoryError` for a `routeKey` that is malformed or that nothing has recorded, and
 * `RegressionDetectorError` for thresholds that could not be applied.
 */
export function detectRegressions(inputs: RegressionDetectorInputs): RegressionReport {
  const thresholds = inputs.thresholds ?? V1_REGRESSION_THRESHOLDS;
  validateThresholds(thresholds);
  const policy = inputs.policy ?? V1_QUALIFICATION_POLICY;
  const routingPolicyVersion = inputs.routingPolicyVersion ?? CURRENT_ROUTING_POLICY_VERSION;

  // THE ROUTES. Every route a sealed run measured; a route only observed has no qualification to regress from.
  const measured = new Set<string>();
  for (const { row } of inputs.workspaceRows) {
    const provider = text(row, 'provider');
    const modelID = text(row, 'requestedModelID');
    if (provider === undefined || modelID === undefined || modelID.length === 0) continue;
    if (inputs.effort !== undefined && row.effort !== inputs.effort) continue;
    measured.add(`${provider}:${modelID}`);
  }
  const routeKeys = inputs.routeKey === undefined ? [...measured].sort(compareCodePoints) : [inputs.routeKey];

  const undatedWorkspaceRuns: string[] = [];
  const snapshot = latestDiscoverySnapshot(inputs.contents, inputs.machineKey);
  const availability = observationsForRouting(inputs.contents);

  const routes = routeKeys.map((asked): RouteRegressionReport => {
    // The history refuses a malformed or never-recorded route itself, with its own words.
    const { provider, modelID } = parseRouteKey(asked);
    const spendFor = inputs.spendFor;
    const history = deriveQualificationHistory({
      routeKey: asked, machineKey: inputs.machineKey, contents: inputs.contents, workspaceRows: inputs.workspaceRows,
      ...(inputs.effort === undefined ? {} : { effort: inputs.effort }),
      ...(inputs.workspaceCases === undefined ? {} : { workspaceCases: inputs.workspaceCases }),
      ...(inputs.difficultyProfiles === undefined ? {} : { difficultyProfiles: inputs.difficultyProfiles }),
      ...(spendFor === undefined ? {} : { spendAt: (at: Date) => spendFor({ provider, modelID }, at) }),
      ...(inputs.currentDriverID === undefined ? {} : { currentDriverID: inputs.currentDriverID }),
      policy, routingPolicyVersion,
    });
    const routeKey = history.routeKey;
    undatedWorkspaceRuns.push(...history.undatedWorkspaceRuns);
    const findings: RegressionFinding[] = [];

    // ---- verdict downgrades: the latest entry against the best each verdict was earlier ------------
    const downgrades: VerdictDowngrade[] = [];
    const latest = history.entries[history.entries.length - 1];
    const earlier = history.entries.slice(0, -1);
    if (latest !== undefined) {
      const lastSafe = [...earlier].reverse().find((entry) => entry.verdict === 'safeToRoute');
      if (latest.verdict === 'notRoutable' && lastSafe !== undefined) {
        downgrades.push({ scope: 'route', from: 'safeToRoute', heldAt: lastSafe.recordedAt, to: 'notRoutable',
          latestAt: latest.recordedAt, because: latest.blockers.map((blocker) => `${blocker.kind}: ${blocker.reason}`) });
      }
      const names = [...new Set(earlier.flatMap((entry) => entry.capabilities.map((capability) => capability.capability)))].sort(compareCodePoints);
      for (const name of names) {
        const now = latest.capabilities.find((capability) => capability.capability === name);
        const to = now?.verdict ?? 'absent';
        let best: { verdict: CapabilityVerdict; at: string } | undefined;
        for (const entry of earlier) {
          const held = entry.capabilities.find((capability) => capability.capability === name);
          if (held !== undefined && (best === undefined || VERDICT_RANK[held.verdict] >= VERDICT_RANK[best.verdict])) {
            best = { verdict: held.verdict, at: entry.recordedAt };
          }
        }
        if (best !== undefined && VERDICT_RANK[to] < VERDICT_RANK[best.verdict]) {
          downgrades.push({ scope: name, from: best.verdict, heldAt: best.at, to, latestAt: latest.recordedAt,
            because: now === undefined ? ['the latest evidence no longer exercises this capability']
              : [`${now.successCount}/${now.scoredRunCount} scored runs passed`] });
        }
      }
    }
    for (const downgrade of downgrades) {
      findings.push({ kind: 'verdictDowngrade', scope: downgrade.scope,
        summary: `${downgrade.scope === 'route' ? routeKey : downgrade.scope} was ${downgrade.from} at ${downgrade.heldAt} and is `
          + `${downgrade.to} at ${downgrade.latestAt}` });
    }

    // ---- metric comparisons: the latest window of scored runs against the runs before it -----------
    const scored = inputs.workspaceRows
      .filter(({ row }) => row.provider === provider && row.requestedModelID === modelID
        && (inputs.effort === undefined || row.effort === inputs.effort)
        && !STATUSES_THAT_MEASURED_NO_WORK.includes(String(row.status)) && instant(row.recordedAt) !== undefined)
      .sort((a, b) => (instant(a.row.recordedAt) as number) - (instant(b.row.recordedAt) as number)
        || compareCodePoints(a.recordRoot, b.recordRoot));
    const { windows, comparisons } = compareWindows(scored, routeKey, thresholds);
    const KIND: Record<MetricComparison['metric'], RegressionFindingKind> = {
      successRateMilli: 'successRateDrop', p90WallClockMilliseconds: 'p90LatencyIncrease', p90TotalTokens: 'p90TokenIncrease',
    };
    for (const comparison of comparisons.filter((entry) => entry.state === 'regressed')) {
      findings.push({ kind: KIND[comparison.metric], scope: 'route',
        summary: `${comparison.metric} ${comparison.baseline} → ${comparison.latest} (${comparison.threshold}; ${thresholds.thresholdsID})` });
    }

    // ---- staleness: the existing findings, as the read model and the routing contract give them -----
    const record = deriveRouteQualification({
      provider, modelID, machineKey: inputs.machineKey, now: inputs.now,
      ...(inputs.effort === undefined ? {} : { effort: inputs.effort }),
      ...(snapshot === undefined ? {} : { snapshot }),
      availability,
      workspaceRows: inputs.workspaceRows,
      ...(inputs.workspaceCases === undefined ? {} : { workspaceCases: inputs.workspaceCases }),
      ...(inputs.difficultyProfiles === undefined ? {} : { difficultyProfiles: inputs.difficultyProfiles }),
      ...(spendFor === undefined ? {} : { spend: spendFor({ provider, modelID }, inputs.now) }),
      ...(inputs.currentDriverID === undefined ? {} : { currentDriverID: inputs.currentDriverID }),
      policy, routingPolicyVersion,
    });
    const freshQuery = qualifiedRouteCandidates({
      machineKey: inputs.machineKey, capability: record.capabilities[0]?.capability ?? 'route',
      costPolicy: 'zeroMarginalCostOnly', routingPolicyVersion, requireFreshQualification: true,
    }, [{ record }]);
    const freshQualificationQueryReason = freshQuery.excluded[0]?.reasons
      .find((reason) => reason.startsWith('staleness: the query requires fresh qualification'));
    const recorded = history.entries.flatMap((entry) => entry.stalenessRecorded)
      .map(({ observedAt, reasons, detail }) => ({ observedAt, reasons, detail }));
    if (record.staleness !== undefined && !record.staleness.valid) {
      findings.push({ kind: 'staleQualification', scope: 'route',
        summary: `${record.staleness.reasons.join(', ')} — ${record.staleness.detail.join('; ')}` });
    }

    return {
      routeKey, provider, modelID,
      ...(latest === undefined ? {} : { latest: { recordedAt: latest.recordedAt, verdict: latest.verdict,
        routableCapabilities: latest.routableCapabilities,
        blockerKinds: [...new Set(latest.blockers.map((blocker) => blocker.kind))].sort(compareCodePoints) } }),
      historyEntryCount: history.entries.length,
      downgrades, windows, comparisons,
      staleness: {
        ...(record.staleness === undefined ? {} : { derived: record.staleness }),
        ...(freshQualificationQueryReason === undefined ? {} : { freshQualificationQueryReason }),
        recorded,
      },
      findings,
    };
  });

  return {
    schema: REGRESSION_REPORT_SCHEMA,
    thresholds,
    qualificationPolicyID: policy.policyID,
    routingPolicyVersion,
    machineKey: inputs.machineKey,
    effort: inputs.effort ?? 'any',
    derivedAt: inputs.now.toISOString(),
    routes,
    regressedRouteCount: routes.filter((route) => route.findings.some((finding) => finding.kind !== 'staleQualification')).length,
    staleRouteCount: routes.filter((route) => route.findings.some((finding) => finding.kind === 'staleQualification')).length,
    undatedWorkspaceRuns: [...new Set(undatedWorkspaceRuns)].sort(compareCodePoints),
    corrupt: inputs.contents.corrupt,
    disclosure: REGRESSIONS_ARE_DETECTION_ONLY,
  };
}
