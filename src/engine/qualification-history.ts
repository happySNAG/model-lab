// Benchmark engine · THE TIMELINE OF ONE ROUTE'S QUALIFICATION VERDICTS, re-derived from the evidence on
// disk and written nowhere.
//
// WHAT IT IS. `deriveRouteQualification` answers "is this route safe to route NOW". This module asks it
// the same question at every instant the route's evidence moved — each sealed workspace run, each
// observation the store holds about the route on the machine being asked about — handing it only the
// evidence that existed at that instant, and lists the answers oldest first. Each entry carries the
// qualification policy that decided it, the verdict, every blocker, and the window of evidence it rests on.
//
// WHAT IT IS NOT, AND EACH OF THESE IS A RULE.
//
//   NOT A WRITER. It takes the store's contents and the run rows as values and returns a value. No verdict
//   is persisted: a stored verdict is a second answer that starts disagreeing with the evidence the first
//   time a rule changes, which is the same reason the observation store keeps no current-truth file.
//   NOT A SECOND QUALIFICATION RULE. Every verdict here IS a `deriveRouteQualification` record, under the
//   policy it was given (cqp1 by default) and the routing policy it was given; nothing is re-decided here.
//   NOT A RECONSTRUCTION OF WHAT A PAST BUILD SAID. It is what THIS build says about the evidence as it
//   stood then. The policy id and routing policy version are on every entry so nobody has to assume.

import { compareCodePoints } from './canonical';
import { ObservationStoreContents, StoredObservation, latestDiscoverySnapshot } from './observation-store';
import { EffortLevel, ProviderID } from './provider';
import {
  CapabilityVerdict, QualificationPolicy, RouteBlockerKind, RouteQualificationRecord, deriveRouteQualification,
} from './route-qualification';
import { RouteSpendPosture } from './route-spend-posture';
import { observationsForRouting } from './routing-contract';
import { RoutingPolicyVersion } from './routing-policy';
import { WorkspaceCase } from './workspace-case';
import { WorkspaceDifficultyProfile } from './workspace-difficulty';
import { WorkspaceRunRow } from './workspace-aggregate';

export const QUALIFICATION_HISTORY_SCHEMA = 'cqh1';

export const QUALIFICATION_HISTORY_IS_DERIVED =
  'Every verdict here is re-derived by this build from the evidence as it stood at that instant: the sealed runs '
  + 'recorded by then and the observations made by then on the machine asked about. Nothing here was stored as a '
  + 'verdict, and nothing was written to produce it.';

export class QualificationHistoryError extends Error {
  constructor(readonly code: 'malformedRoute' | 'unknownRoute', message: string) {
    super(message);
    this.name = 'QualificationHistoryError';
  }
}

export interface QualificationHistoryInputs {
  /** `provider:modelID`, as every other route key in the engine. */
  routeKey: string;
  /** The `cmk1:` key availability and discovery are answered for. */
  machineKey: string;
  effort?: EffortLevel;
  contents: ObservationStoreContents;
  /** Workspace run rows, from any number of roots. Read, never written. */
  workspaceRows: WorkspaceRunRow[];
  workspaceCases?: WorkspaceCase[];
  difficultyProfiles?: WorkspaceDifficultyProfile[];
  policy?: QualificationPolicy;
  routingPolicyVersion?: RoutingPolicyVersion;
  /** Who pays, as of an instant. Asked once per entry, because a posture can expire. */
  spendAt?: (at: Date) => RouteSpendPosture;
  currentDriverID?: string;
}

/** What moved the evidence at an instant. */
export interface QualificationHistoryTrigger {
  kind: 'workspaceRun' | StoredObservation['record']['kind'];
  /** A record root for a run; a record id for an observation. */
  ref: string;
}

export interface QualificationHistoryEntry {
  /** The instant the verdict is derived at: when the newest evidence behind it was recorded. */
  recordedAt: string;
  policyID: string;
  routingPolicyVersion: RoutingPolicyVersion;
  verdict: 'safeToRoute' | 'notRoutable';
  routableCapabilities: string[];
  capabilities: { capability: string; verdict: CapabilityVerdict; scoredRunCount: number; successCount: number }[];
  blockers: { kind: RouteBlockerKind; reason: string }[];
  /** The span of this route's evidence the verdict rests on, and how much of it there was. */
  evidenceWindow: { from: string; to: string; workspaceRuns: number; observations: number };
  triggeredBy: QualificationHistoryTrigger[];
  /** `qualificationStaleness` observations recorded at this instant, as the store holds them. */
  stalenessRecorded: { observedAt: string; machineKey: string; reasons: string[]; detail: string[] }[];
  /** False when the verdict, the capability verdicts and the blocker kinds match the previous entry's. */
  changed: boolean;
}

export interface QualificationHistory {
  schema: typeof QUALIFICATION_HISTORY_SCHEMA;
  routeKey: string;
  provider: ProviderID;
  modelID: string;
  effort: EffortLevel | 'any';
  machineKey: string;
  /** Oldest first. */
  entries: QualificationHistoryEntry[];
  /** Runs of this route whose `recordedAt` could not be read as an instant, and so sit on no timeline. */
  undatedWorkspaceRuns: string[];
  /** Store files that did not verify. Their contents are in no entry. */
  corrupt: ObservationStoreContents['corrupt'];
  disclosure: string;
}

/** `provider:modelID`, split at the first colon — a model id may carry colons of its own. */
export function parseRouteKey(routeKey: string): { provider: ProviderID; modelID: string } {
  const at = routeKey.indexOf(':');
  if (at <= 0 || at === routeKey.length - 1) {
    throw new QualificationHistoryError('malformedRoute',
      `'${routeKey}' is not a route. A route is provider:model, for example claudeCLI:claude-haiku-4-5.`);
  }
  return { provider: routeKey.slice(0, at) as ProviderID, modelID: routeKey.slice(at + 1) };
}

const instant = (value: unknown): number | undefined => {
  if (typeof value !== 'string') return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
};

const isoOf = (milliseconds: number): string => new Date(milliseconds).toISOString();

/** An observation about this route: by its route key, or a discovery snapshot that lists it. */
function aboutRoute(entry: StoredObservation, routeKey: string): boolean {
  if (entry.record.routeKey === routeKey) return true;
  if (entry.record.kind !== 'discoverySnapshot') return false;
  const routes = (entry.record.body as { routes?: { routeKey?: string }[] }).routes;
  return Array.isArray(routes) && routes.some((route) => route.routeKey === routeKey);
}

function signature(record: RouteQualificationRecord): string {
  return JSON.stringify([record.safeToRoute, record.routableCapabilities,
    record.capabilities.map((entry) => [entry.capability, entry.verdict]),
    [...new Set(record.blockers.map((entry) => entry.kind))].sort()]);
}

/**
 * The timeline. PURE: every input is a value, nothing is read from or written to disk here.
 *
 * Throws `unknownRoute` when neither the store nor the rows have ever heard of the route, because an
 * empty timeline for a typo reads exactly like a route that has never been measured.
 */
export function deriveQualificationHistory(inputs: QualificationHistoryInputs): QualificationHistory {
  const { provider, modelID } = parseRouteKey(inputs.routeKey);
  const routeKey = `${provider}:${modelID}`;

  const routeRuns = inputs.workspaceRows.filter(({ row }) => row.provider === provider && row.requestedModelID === modelID
    && (inputs.effort === undefined || row.effort === inputs.effort));
  const routeObservations = inputs.contents.observations.filter((entry) => aboutRoute(entry, routeKey));
  if (routeRuns.length === 0 && routeObservations.length === 0) {
    throw new QualificationHistoryError('unknownRoute',
      `${routeKey} is not a route this store or these evidence roots have ever recorded: no observation names it and no `
      + 'sealed run measured it. Nothing was derived. Check the spelling against `availability`, or name the roots that '
      + 'hold its runs with --evidence-roots.');
  }

  // THE INSTANTS. Every run of the route, wherever it ran; every observation about it made ON the machine
  // asked about, because only those can move a verdict on that machine.
  const dated = routeRuns.map((run) => ({ run, at: instant(run.row.recordedAt) }));
  const undatedWorkspaceRuns = dated.filter((entry) => entry.at === undefined).map((entry) => entry.run.recordRoot);
  const triggers = new Map<number, QualificationHistoryTrigger[]>();
  const trigger = (at: number, entry: QualificationHistoryTrigger): void => { triggers.set(at, [...(triggers.get(at) ?? []), entry]); };
  for (const { run, at } of dated) if (at !== undefined) trigger(at, { kind: 'workspaceRun', ref: run.recordRoot });
  for (const entry of routeObservations) {
    const at = instant(entry.record.observedAt);
    if (at !== undefined && entry.record.machineKey === inputs.machineKey) trigger(at, { kind: entry.record.kind, ref: entry.record.recordID });
  }

  const entries: QualificationHistoryEntry[] = [];
  let previous: string | undefined;
  for (const at of [...triggers.keys()].sort((a, b) => a - b)) {
    const now = new Date(at);
    // THE EVIDENCE AS IT STOOD. The store is cut at the instant and handed to the same readers the
    // `candidates` command uses, so discovery and availability are answered exactly as they would have been.
    const asOf: ObservationStoreContents = { ...inputs.contents,
      observations: inputs.contents.observations.filter((entry) => (instant(entry.record.observedAt) ?? Infinity) <= at) };
    const runs = dated.filter((entry) => entry.at !== undefined && entry.at <= at).map((entry) => entry.run);
    const snapshot = latestDiscoverySnapshot(asOf, inputs.machineKey);
    const record = deriveRouteQualification({
      provider, modelID, machineKey: inputs.machineKey, now,
      ...(inputs.effort === undefined ? {} : { effort: inputs.effort }),
      ...(snapshot === undefined ? {} : { snapshot }),
      availability: observationsForRouting(asOf),
      workspaceRows: runs,
      ...(inputs.workspaceCases === undefined ? {} : { workspaceCases: inputs.workspaceCases }),
      ...(inputs.difficultyProfiles === undefined ? {} : { difficultyProfiles: inputs.difficultyProfiles }),
      ...(inputs.spendAt === undefined ? {} : { spend: inputs.spendAt(now) }),
      ...(inputs.policy === undefined ? {} : { policy: inputs.policy }),
      ...(inputs.routingPolicyVersion === undefined ? {} : { routingPolicyVersion: inputs.routingPolicyVersion }),
      ...(inputs.currentDriverID === undefined ? {} : { currentDriverID: inputs.currentDriverID }),
    });

    const observed = routeObservations.filter((entry) => entry.record.machineKey === inputs.machineKey
      && (instant(entry.record.observedAt) ?? Infinity) <= at);
    const evidenceInstants = [...runs.map((run) => instant(run.row.recordedAt) as number),
      ...observed.map((entry) => instant(entry.record.observedAt) as number)];
    const current = signature(record);
    entries.push({
      recordedAt: isoOf(at),
      policyID: record.policy.policyID,
      routingPolicyVersion: record.routingPolicyVersion,
      verdict: record.safeToRoute ? 'safeToRoute' : 'notRoutable',
      routableCapabilities: record.routableCapabilities,
      capabilities: record.capabilities.map((entry) => ({ capability: entry.capability, verdict: entry.verdict,
        scoredRunCount: entry.scoredRunCount, successCount: entry.successCount })),
      blockers: record.blockers,
      evidenceWindow: { from: isoOf(Math.min(...evidenceInstants)), to: isoOf(Math.max(...evidenceInstants)),
        workspaceRuns: runs.length, observations: observed.length },
      triggeredBy: (triggers.get(at) ?? []).sort((a, b) => compareCodePoints(a.kind, b.kind) || compareCodePoints(a.ref, b.ref)),
      stalenessRecorded: observed.filter((entry) => entry.record.kind === 'qualificationStaleness' && instant(entry.record.observedAt) === at)
        .map((entry) => {
          const body = entry.record.body as { reasons?: string[]; detail?: string[] };
          return { observedAt: entry.record.observedAt, machineKey: entry.record.machineKey,
            reasons: body.reasons ?? [], detail: body.detail ?? [] };
        }),
      changed: current !== previous,
    });
    previous = current;
  }

  return {
    schema: QUALIFICATION_HISTORY_SCHEMA,
    routeKey, provider, modelID,
    effort: inputs.effort ?? 'any',
    machineKey: inputs.machineKey,
    entries,
    undatedWorkspaceRuns,
    corrupt: inputs.contents.corrupt,
    disclosure: QUALIFICATION_HISTORY_IS_DERIVED,
  };
}
