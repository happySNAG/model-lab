// Benchmark engine · ONE READ-ONLY STATUS DOCUMENT for Ordra Office, versioned `cse1`, written nowhere.
//
// WHAT IT IS. Everything the routing-evidence core already answers, gathered into a single value with a
// schema id and version on it, so a consumer reads one document instead of running nine commands:
//   the discovered models   the latest discovery snapshot (cds1) on the machine asked about, as recorded;
//   the qualified routes    every known route's qualification record (cqp1), summarised, and which are safe;
//   capability candidates   the crc2 candidate set, zero marginal cost only, for every capability any route
//                           holds evidence for, each exclusion with its reasons;
//   the metrics rollup      `deriveMetricsRollup` (cmr1), unchanged;
//   regression findings     `detectRegressions` (crg1 under crt1), unchanged;
//   recent qualification    the newest entries of each route's qualification history (cqh1);
//   costs where known       spend posture, the published price the snapshot recorded, and the cost the sealed
//                           runs recorded — each unknown left unknown, with the reason;
//   fallback chains         `deriveFallbackChain` (cfc1) for every task type of task taxonomy ctt1 at every
//                           structural tier;
//   active leases           the runtime-endpoint leases the caller read, with what each one's state means.
// The JSON schema is `docs/ordra-lane/status-export.schema.json`; the field-by-field description is
// `docs/ordra-lane/status-export.md`.
//
// WHAT IT IS NOT, AND EACH OF THESE IS A RULE.
//
//   NOT A WRITER AND NOT A CLIENT. It takes the store's contents, the run rows and the lease inspections as
//   values and returns a value. It reads no file, writes no file and contacts nothing; the command that calls
//   it reads only what is already on disk.
//   NOT A SECOND RULE. Every verdict, candidate set, chain, figure and finding here is the output of the
//   module that owns it, called with the same inputs its own command would give it. Nothing is re-decided,
//   combined into a score or ranked; the export only gathers.
//   NOT A SELECTION. A fallback chain is advisory and says so; a candidate set is not a choice and says so.

import { compareCodePoints } from './canonical';
import { DISCOVERY_SNAPSHOT_SCHEMA, ProviderRefreshOutcome, RouteObservation } from './discovery-refresh';
import { FALLBACK_CHAIN_RULE_VERSION, FALLBACK_CHAIN_IS_NOT_A_SELECTION, deriveFallbackChain, throttleEvidenceFromRecords } from './fallback-chain';
import { Quantity } from './frontier-metrics';
import { LockInspection, LockOwnerState } from './lock';
import { METRICS_ROLLUP_SCHEMA, MetricsCost, MetricsRollup, deriveMetricsRollup } from './metrics-rollup';
import { OBSERVATION_STORE_SCHEMA, ObservationStoreContents, latestDiscoverySnapshot } from './observation-store';
import { EffortLevel, ProviderID } from './provider';
import {
  QUALIFICATION_HISTORY_SCHEMA, QualificationHistoryEntry, deriveQualificationHistory, parseRouteKey,
} from './qualification-history';
import {
  REGRESSION_REPORT_SCHEMA, RegressionReport, RegressionThresholds, V1_REGRESSION_THRESHOLDS, detectRegressions,
} from './regression-detector';
import {
  CapabilityVerdict, QualificationPolicy, RouteBlockerKind, RouteQualificationRecord, V1_QUALIFICATION_POLICY,
  deriveRouteQualification,
} from './route-qualification';
import { RouteSpendPosture } from './route-spend-posture';
import {
  ROUTE_CANDIDATES_ARE_NOT_A_CHOICE, ROUTING_CONTRACT_VERSION, RouteCandidateQuery, RouteCandidateSet,
  observationsForRouting, qualifiedRouteCandidatesFromStore,
} from './routing-contract';
import { CURRENT_ROUTING_POLICY_VERSION, RoutingPolicyVersion } from './routing-policy';
import { ALL_ORDRA_TASK_TYPES, OrdraTaskType, TASK_TAXONOMY_VERSION, routeQueryForTask } from './task-taxonomy';
import { WorkspaceCase } from './workspace-case';
import { ALL_WORKSPACE_DIFFICULTY_TIERS, WorkspaceDifficultyProfile, WorkspaceDifficultyTier } from './workspace-difficulty';
import { WorkspaceRunRow } from './workspace-aggregate';

/** The document's schema id. A field removed or changing meaning is a new id; a field added is a new version. */
export const STATUS_EXPORT_SCHEMA = 'cse1';
export const STATUS_EXPORT_SCHEMA_VERSION = 1;
/** Where the JSON schema the document validates against lives, relative to the repository. */
export const STATUS_EXPORT_JSON_SCHEMA_PATH = 'docs/ordra-lane/status-export.schema.json';

/** How many of each route's newest qualification history entries the export carries, by default. */
export const STATUS_EXPORT_RECENT_QUALIFICATION_ENTRIES = 5;

export const STATUS_EXPORT_IS_READ_ONLY =
  'Read-only. This document was assembled from the observation store, the sealed runs and the lease files as they '
  + 'already stood; nothing was written and no model, provider or network service was contacted to produce it. Every '
  + 'verdict, candidate set, fallback chain, figure and finding is the output of the module that owns it, unchanged: '
  + 'nothing here is a selection, a score or a ranking, and a figure that was not recorded is unknown, with the reason.';

export class StatusExportError extends Error {
  constructor(readonly code: 'invalidContextTokens' | 'invalidRecentEntries', message: string) {
    super(message);
    this.name = 'StatusExportError';
  }
}

export interface StatusExportInputs {
  /** The `cmk1:` key every verdict, candidate set and chain is answered for. */
  machineKey: string;
  contents: ObservationStoreContents;
  /** Workspace run rows, from any number of roots. Read, never written. */
  workspaceRows: WorkspaceRunRow[];
  workspaceCases?: WorkspaceCase[];
  difficultyProfiles?: WorkspaceDifficultyProfile[];
  /** The runtime-endpoint leases the caller read (`leasedEndpoints`). Absent: none were read, and it says so. */
  leases?: LockInspection[];
  /** Who pays for a route, as of an instant. */
  spendFor?: (route: { provider: ProviderID; modelID: string }, at: Date) => RouteSpendPosture;
  effort?: EffortLevel;
  policy?: QualificationPolicy;
  routingPolicyVersion?: RoutingPolicyVersion;
  thresholds?: RegressionThresholds;
  /**
   * The context requirement every task's fallback query carries. Absent: the task queries carry none, and
   * the document says so — no context requirement is invented on a pass's behalf.
   */
  contextTokens?: number;
  /** How many of each route's newest qualification history entries to carry. */
  recentQualificationEntries?: number;
  currentDriverID?: string;
  /** The instant everything is answered for. */
  now: Date;
}

export interface StatusDiscoveredModels {
  snapshotSchema: typeof DISCOVERY_SNAPSHOT_SCHEMA;
  /** Absent when no snapshot was ever taken on this machine; `models` is then empty. */
  snapshotTakenAt?: string;
  providerAllowlist?: string;
  providers: ProviderRefreshOutcome[];
  /** Each discovered model as the snapshot recorded it, by route key. */
  models: RouteObservation[];
  reason: string;
}

export interface StatusQualifiedRoute {
  routeKey: string;
  provider: ProviderID;
  modelID: string;
  safeToRoute: boolean;
  routableCapabilities: string[];
  qualificationScope: RouteQualificationRecord['qualificationScope'];
  discovered: RouteQualificationRecord['discovered'];
  availability: { state: string; reason: string; observedAt?: string };
  identityConfidence: string;
  identityAdmitted: boolean;
  lastSuccessfulQualificationAt?: string;
  staleness?: { valid: boolean; reasons: string[]; detail: string[] };
  capabilities: { capability: string; verdict: CapabilityVerdict; scoredRunCount: number; successCount: number; reason: string }[];
  blockers: { kind: RouteBlockerKind; reason: string }[];
}

export interface StatusCandidateSummary {
  routeKey: string;
  group: 'zeroMarginalCost' | 'meteredRequiresAuthorization';
  locality: 'local' | 'remote';
  identityConfidence: string;
  identityAdmitted: boolean;
  availability: string;
}

export interface StatusCapabilityCandidates {
  capability: string;
  query: RouteCandidateQuery;
  candidates: StatusCandidateSummary[];
  excluded: RouteCandidateSet['excluded'];
  ordering: string;
}

export interface StatusRecentQualification {
  routeKey: string;
  historyEntryCount: number;
  /** The newest entries, oldest first. */
  entries: QualificationHistoryEntry[];
  undatedWorkspaceRuns: string[];
}

export interface StatusRouteCost {
  routeKey: string;
  /** Who pays, by the cost-eligibility rules. Absent when no spend posture was given. */
  spend?: { eligibility: string; zeroMarginalCost: boolean; requiresSpendingAuthorization: boolean; mayRouteByDefault: boolean; reasons: string[] };
  /** The published price the latest snapshot recorded. Absent when none was recorded. */
  published?: { priceFingerprint?: string; publishedFree?: boolean; observedAt: string };
  /** What the sealed runs recorded spending (cmr1). Absent when no sealed run of the route exists. */
  recorded?: MetricsCost;
  state: 'known' | 'partlyKnown' | 'unknown';
  reason: string;
}

export interface StatusFallbackEntry {
  position: number;
  routeKey: string;
  standing: 'inChain' | 'fallsThrough';
  fallsThroughBecause: string[];
  group: 'zeroMarginalCost' | 'meteredRequiresAuthorization';
  lastSuccessfulQualificationAt?: string;
  failureRateMilli: Quantity;
  p90WallClockMilliseconds: Quantity;
}

export interface StatusFallbackTier {
  tier: WorkspaceDifficultyTier;
  query: RouteCandidateQuery;
  chain: string[];
  entries: StatusFallbackEntry[];
  excluded: RouteCandidateSet['excluded'];
}

export interface StatusFallbackTask {
  taskType: OrdraTaskType;
  capability: string;
  tiers: StatusFallbackTier[];
}

export interface StatusLease {
  endpoint?: string;
  campaignName?: string;
  campaignID?: string;
  processType?: string;
  pid?: number;
  hostname?: string;
  command?: string;
  acquiredAt?: string;
  heartbeatAt?: string;
  heartbeatAgeMilliseconds?: number;
  modelStoreCount?: number;
  state: LockOwnerState | 'undecodable';
  /** Held and not reclaimable: a crashed owner's lease is listed, and is not active. */
  active: boolean;
  recoverable: boolean;
  message: string;
}

export interface StatusExport {
  schema: typeof STATUS_EXPORT_SCHEMA;
  schemaVersion: typeof STATUS_EXPORT_SCHEMA_VERSION;
  jsonSchema: typeof STATUS_EXPORT_JSON_SCHEMA_PATH;
  generatedAt: string;
  machineKey: string;
  effort: EffortLevel | 'any';
  readOnly: true;
  /** The version of every rule and schema whose output is carried here. */
  versions: {
    observationStore: typeof OBSERVATION_STORE_SCHEMA;
    discoverySnapshot: typeof DISCOVERY_SNAPSHOT_SCHEMA;
    qualificationPolicy: string;
    routingPolicy: RoutingPolicyVersion;
    routingContract: typeof ROUTING_CONTRACT_VERSION;
    metricsRollup: typeof METRICS_ROLLUP_SCHEMA;
    regressionReport: typeof REGRESSION_REPORT_SCHEMA;
    regressionThresholds: string;
    qualificationHistory: typeof QUALIFICATION_HISTORY_SCHEMA;
    taskTaxonomy: typeof TASK_TAXONOMY_VERSION;
    fallbackChain: typeof FALLBACK_CHAIN_RULE_VERSION;
  };
  discoveredModels: StatusDiscoveredModels;
  qualifiedRoutes: { safeToRouteKeys: string[]; routes: StatusQualifiedRoute[] };
  capabilityCandidates: { disclosure: string; capabilities: StatusCapabilityCandidates[] };
  metricsRollup: MetricsRollup;
  regressions: RegressionReport;
  recentQualificationResults: { entriesPerRoute: number; routes: StatusRecentQualification[] };
  costs: StatusRouteCost[];
  fallbackChains: {
    taxonomyVersion: typeof TASK_TAXONOMY_VERSION;
    rule: typeof FALLBACK_CHAIN_RULE_VERSION;
    contextRequirement: { applied: boolean; contextTokens?: number; reason: string };
    isSelection: false;
    disclosure: string;
    tasks: StatusFallbackTask[];
  };
  activeLeases: { read: boolean; activeCount: number; leases: StatusLease[] };
  corrupt: ObservationStoreContents['corrupt'];
  disclosure: string;
}

const text = (row: Record<string, unknown>, key: string): string | undefined =>
  (typeof row[key] === 'string' ? row[key] as string : undefined);

function summariseRecord(record: RouteQualificationRecord): StatusQualifiedRoute {
  const latest = record.availableOnThisMachine.latest;
  return {
    routeKey: record.routeKey, provider: record.provider, modelID: record.modelID,
    safeToRoute: record.safeToRoute, routableCapabilities: record.routableCapabilities,
    qualificationScope: record.qualificationScope, discovered: record.discovered,
    availability: { state: record.availableOnThisMachine.state, reason: record.availableOnThisMachine.reason,
      ...(latest === undefined ? {} : { observedAt: latest.observedAt }) },
    identityConfidence: record.identityConfidence, identityAdmitted: record.identityAdmitted,
    ...(record.lastSuccessfulQualificationAt === undefined || record.lastSuccessfulQualificationAt === ''
      ? {} : { lastSuccessfulQualificationAt: record.lastSuccessfulQualificationAt }),
    ...(record.staleness === undefined ? {} : { staleness: record.staleness }),
    capabilities: record.capabilities.map(({ capability, verdict, scoredRunCount, successCount, reason }) =>
      ({ capability, verdict, scoredRunCount, successCount, reason })),
    blockers: record.blockers,
  };
}

function summariseCandidates(set: RouteCandidateSet): StatusCandidateSummary[] {
  return set.candidates.map((candidate) => ({
    routeKey: candidate.routeKey, group: candidate.group, locality: candidate.locality,
    identityConfidence: candidate.identityConfidence, identityAdmitted: candidate.identityAdmitted,
    availability: candidate.availability.state,
  }));
}

function summariseLease(inspection: LockInspection): StatusLease {
  const record = inspection.record;
  const state = inspection.state ?? 'undecodable';
  return {
    ...(record?.endpoint === undefined ? {} : { endpoint: record.endpoint }),
    ...(record === undefined ? {} : {
      campaignName: record.campaignName, campaignID: record.campaignID, processType: record.processType, pid: record.pid,
      hostname: record.hostname, command: record.command, acquiredAt: record.acquiredAt, heartbeatAt: record.heartbeatAt,
      ...(record.modelStoreCount === undefined ? {} : { modelStoreCount: record.modelStoreCount }),
    }),
    ...(inspection.heartbeatAgeMilliseconds === undefined ? {} : { heartbeatAgeMilliseconds: inspection.heartbeatAgeMilliseconds }),
    state, active: inspection.held && !inspection.recoverable, recoverable: inspection.recoverable, message: inspection.message,
  };
}

function costOf(routeKey: string, spend: RouteSpendPosture | undefined, observed: RouteObservation | undefined,
                rollup: MetricsRollup): StatusRouteCost {
  const recorded = rollup.routes.find((route) => route.routeKey === routeKey)?.route.cost;
  const published = observed === undefined || (observed.priceFingerprint === undefined && observed.publishedFree === undefined)
    ? undefined
    : { ...(observed.priceFingerprint === undefined ? {} : { priceFingerprint: observed.priceFingerprint }),
      ...(observed.publishedFree === undefined ? {} : { publishedFree: observed.publishedFree }), observedAt: observed.observedAt };
  const recordedKnown = recorded !== undefined && recorded.totalMicroUSD.provenance !== 'unavailable';
  const reasons: string[] = [];
  if (recorded === undefined) reasons.push('no sealed run of this route exists, so no cost was recorded');
  else if (!recordedKnown) reasons.push(`the sealed runs' cost is unknown: ${recorded.unknownBecause.join('; ') || 'not every run recorded one'}`);
  else reasons.push(`the sealed runs recorded every run's cost (${recorded.knownRunCount} run(s))`);
  if (published === undefined) reasons.push('the latest snapshot recorded no published price');
  if (spend === undefined) reasons.push('no spend posture was given');
  const state = recordedKnown && spend !== undefined ? 'known'
    : recordedKnown || published !== undefined || spend !== undefined ? 'partlyKnown' : 'unknown';
  return {
    routeKey,
    ...(spend === undefined ? {} : { spend: { eligibility: spend.eligibility, zeroMarginalCost: spend.zeroMarginalCost,
      requiresSpendingAuthorization: spend.requiresSpendingAuthorization, mayRouteByDefault: spend.mayRouteByDefault, reasons: spend.reasons } }),
    ...(published === undefined ? {} : { published }),
    ...(recorded === undefined ? {} : { recorded }),
    state, reason: reasons.join('; '),
  };
}

/**
 * The document. PURE: every input is a value, nothing is read from or written to disk here, and no model,
 * provider or network service is contacted.
 *
 * Throws `StatusExportError` for a context requirement or entry count it could not apply, and whatever the
 * owning modules throw for inputs they refuse (`RegressionDetectorError` for unusable thresholds).
 */
export function deriveStatusExport(inputs: StatusExportInputs): StatusExport {
  const { contextTokens } = inputs;
  if (contextTokens !== undefined && (!Number.isSafeInteger(contextTokens) || contextTokens <= 0)) {
    throw new StatusExportError('invalidContextTokens',
      `the context requirement '${String(contextTokens)}' is not a positive whole number of tokens. Nothing was derived.`);
  }
  const entriesPerRoute = inputs.recentQualificationEntries ?? STATUS_EXPORT_RECENT_QUALIFICATION_ENTRIES;
  if (!Number.isSafeInteger(entriesPerRoute) || entriesPerRoute < 1) {
    throw new StatusExportError('invalidRecentEntries',
      `the recent qualification entry count '${String(entriesPerRoute)}' is not a whole number of at least 1. Nothing was derived.`);
  }
  const policy = inputs.policy ?? V1_QUALIFICATION_POLICY;
  const routingPolicyVersion = inputs.routingPolicyVersion ?? CURRENT_ROUTING_POLICY_VERSION;
  const thresholds = inputs.thresholds ?? V1_REGRESSION_THRESHOLDS;
  const { machineKey, contents, workspaceRows, now } = inputs;
  const optional = {
    ...(inputs.effort === undefined ? {} : { effort: inputs.effort }),
    ...(inputs.workspaceCases === undefined ? {} : { workspaceCases: inputs.workspaceCases }),
    ...(inputs.difficultyProfiles === undefined ? {} : { difficultyProfiles: inputs.difficultyProfiles }),
    ...(inputs.currentDriverID === undefined ? {} : { currentDriverID: inputs.currentDriverID }),
  };

  // ---- the discovered models: the latest snapshot on this machine, as recorded ----------------------
  const snapshot = latestDiscoverySnapshot(contents, machineKey);
  const models = [...(snapshot?.routes ?? [])].sort((a, b) => compareCodePoints(a.routeKey, b.routeKey));
  const discoveredModels: StatusDiscoveredModels = {
    snapshotSchema: DISCOVERY_SNAPSHOT_SCHEMA,
    ...(snapshot === undefined ? {} : { snapshotTakenAt: snapshot.takenAt }),
    ...(snapshot?.providerAllowlist === undefined ? {} : { providerAllowlist: snapshot.providerAllowlist }),
    providers: snapshot?.providers ?? [],
    models,
    reason: snapshot === undefined ? `no discovery snapshot was ever recorded on ${machineKey}; nothing is listed as discovered`
      : `the latest discovery snapshot on ${machineKey}, taken ${snapshot.takenAt}, as it was recorded`,
  };

  // ---- the routes: every route this machine observed, the snapshot listed, or a sealed run measured ---
  const availability = observationsForRouting(contents);
  const known = new Set<string>(availability.filter((entry) => entry.machineKey === machineKey).map((entry) => entry.routeKey));
  for (const model of models) known.add(model.routeKey);
  for (const { row } of workspaceRows) {
    const provider = text(row, 'provider');
    const modelID = text(row, 'requestedModelID');
    if (provider === undefined || modelID === undefined || modelID.length === 0) continue;
    if (inputs.effort !== undefined && row.effort !== inputs.effort) continue;
    known.add(`${provider}:${modelID}`);
  }
  const routeKeys = [...known].filter((routeKey) => routeKey.indexOf(':') > 0).sort(compareCodePoints);
  const spendOf = (routeKey: string, at: Date): RouteSpendPosture | undefined => {
    if (inputs.spendFor === undefined) return undefined;
    const { provider, modelID } = parseRouteKey(routeKey);
    return inputs.spendFor({ provider, modelID }, at);
  };

  const derived = routeKeys.map((routeKey) => {
    const { provider, modelID } = parseRouteKey(routeKey);
    const spend = spendOf(routeKey, now);
    const record = deriveRouteQualification({
      provider, modelID, machineKey, now, ...(snapshot === undefined ? {} : { snapshot }), availability, workspaceRows,
      ...optional, ...(spend === undefined ? {} : { spend }), policy, routingPolicyVersion,
    });
    return { record };
  });
  const routes = derived.map(({ record }) => summariseRecord(record));

  // ---- per-capability candidates: crc2, zero marginal cost only, the V1 default ----------------------
  const capabilityNames = [...new Set(derived.flatMap(({ record }) => record.capabilities.map((entry) => entry.capability)))]
    .sort(compareCodePoints);
  const capabilities = capabilityNames.map((capability): StatusCapabilityCandidates => {
    const query: RouteCandidateQuery = { machineKey, capability, costPolicy: 'zeroMarginalCostOnly', routingPolicyVersion };
    const set = qualifiedRouteCandidatesFromStore(query, contents, derived, now);
    return { capability, query, candidates: summariseCandidates(set), excluded: set.excluded, ordering: set.ordering };
  });

  // ---- the metrics rollup and the regressions, from their own modules, unchanged -------------------
  const metricsRollup = deriveMetricsRollup({ workspaceRows, ...optional });
  const regressions = detectRegressions({
    machineKey, contents, workspaceRows, now, ...optional, policy, routingPolicyVersion, thresholds,
    ...(inputs.spendFor === undefined ? {} : { spendFor: inputs.spendFor }),
  });

  // ---- recent qualification results: the newest entries of each route's history --------------------
  const recent = routeKeys.map((routeKey): StatusRecentQualification => {
    const history = deriveQualificationHistory({
      routeKey, machineKey, contents, workspaceRows, ...optional, policy, routingPolicyVersion,
      ...(inputs.spendFor === undefined ? {} : { spendAt: (at: Date) => spendOf(routeKey, at) as RouteSpendPosture }),
    });
    return { routeKey, historyEntryCount: history.entries.length,
      entries: history.entries.slice(Math.max(0, history.entries.length - entriesPerRoute)),
      undatedWorkspaceRuns: history.undatedWorkspaceRuns };
  });

  // ---- costs, where known ------------------------------------------------------------------------
  const costs = routeKeys.map((routeKey) =>
    costOf(routeKey, spendOf(routeKey, now), models.find((model) => model.routeKey === routeKey), metricsRollup));

  // ---- the fallback chain for every task type, at every tier --------------------------------------
  const throttles = throttleEvidenceFromRecords(derived.map(({ record }) => record));
  const tasks = ALL_ORDRA_TASK_TYPES.map((taskType): StatusFallbackTask => {
    const tiers = ALL_WORKSPACE_DIFFICULTY_TIERS.map((tier): StatusFallbackTier => {
      const answer = routeQueryForTask({ machineKey, taskType, tier, contextTokens: contextTokens ?? 1 });
      if (!answer.ok) throw new Error(`task taxonomy ${answer.taxonomyVersion} refused its own row: ${answer.refusals.join('; ')}`);
      const { minimumContextTokens, ...withoutContext } = answer.query;
      const query: RouteCandidateQuery = { ...(contextTokens === undefined ? withoutContext : { ...withoutContext, minimumContextTokens }),
        routingPolicyVersion };
      const chain = deriveFallbackChain(qualifiedRouteCandidatesFromStore(query, contents, derived, now),
        { now, metrics: metricsRollup, throttles });
      return {
        tier, query, chain: chain.chain,
        entries: chain.entries.map((entry) => ({
          position: entry.position, routeKey: entry.routeKey, standing: entry.standing, fallsThroughBecause: entry.fallsThroughBecause,
          group: entry.orderedBy.group,
          ...(entry.orderedBy.lastSuccessfulQualificationAt === undefined ? {}
            : { lastSuccessfulQualificationAt: entry.orderedBy.lastSuccessfulQualificationAt }),
          failureRateMilli: entry.orderedBy.failureRateMilli, p90WallClockMilliseconds: entry.orderedBy.p90WallClockMilliseconds,
        })),
        excluded: chain.excluded,
      };
    });
    return { taskType, capability: tiers[0].query.capability, tiers };
  });

  // ---- the leases the caller read -----------------------------------------------------------------
  const leases = (inputs.leases ?? []).map(summariseLease)
    .sort((a, b) => compareCodePoints(a.endpoint ?? '', b.endpoint ?? ''));

  return {
    schema: STATUS_EXPORT_SCHEMA,
    schemaVersion: STATUS_EXPORT_SCHEMA_VERSION,
    jsonSchema: STATUS_EXPORT_JSON_SCHEMA_PATH,
    generatedAt: now.toISOString(),
    machineKey,
    effort: inputs.effort ?? 'any',
    readOnly: true,
    versions: {
      observationStore: OBSERVATION_STORE_SCHEMA, discoverySnapshot: DISCOVERY_SNAPSHOT_SCHEMA,
      qualificationPolicy: policy.policyID, routingPolicy: routingPolicyVersion, routingContract: ROUTING_CONTRACT_VERSION,
      metricsRollup: METRICS_ROLLUP_SCHEMA, regressionReport: REGRESSION_REPORT_SCHEMA, regressionThresholds: thresholds.thresholdsID,
      qualificationHistory: QUALIFICATION_HISTORY_SCHEMA, taskTaxonomy: TASK_TAXONOMY_VERSION, fallbackChain: FALLBACK_CHAIN_RULE_VERSION,
    },
    discoveredModels,
    qualifiedRoutes: { safeToRouteKeys: routes.filter((route) => route.safeToRoute).map((route) => route.routeKey), routes },
    capabilityCandidates: { disclosure: ROUTE_CANDIDATES_ARE_NOT_A_CHOICE, capabilities },
    metricsRollup,
    regressions,
    recentQualificationResults: { entriesPerRoute, routes: recent },
    costs,
    fallbackChains: {
      taxonomyVersion: TASK_TAXONOMY_VERSION, rule: FALLBACK_CHAIN_RULE_VERSION,
      contextRequirement: contextTokens === undefined
        ? { applied: false, reason: 'no context requirement was given, so the task queries carry none; a pass that needs one asks `candidates --task <type> --tier <n> --context <tokens>`' }
        : { applied: true, contextTokens, reason: `every task query requires at least ${contextTokens} context tokens; a route whose context window is unknown cannot satisfy it` },
      isSelection: false, disclosure: FALLBACK_CHAIN_IS_NOT_A_SELECTION, tasks,
    },
    activeLeases: { read: inputs.leases !== undefined, activeCount: leases.filter((lease) => lease.active).length, leases },
    corrupt: contents.corrupt,
    disclosure: STATUS_EXPORT_IS_READ_ONLY,
  };
}
