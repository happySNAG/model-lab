// Benchmark engine · EFFORT AS PART OF A ROUTE'S IDENTITY FOR QUALIFICATION. Evidence gathered at an
// observed effort is keyed `provider:model@effort`; evidence whose effort nobody observed is keyed with an
// explicit unobservable state, and the two are never pooled.
//
// WHAT "OBSERVED" MEANS, AND IT IS A RULE. A run's effort is observed only when the tool's own telemetry
// measured the effort it applied (`appliedEffort`, `workspace-effort-evidence.ts`) and that measurement is
// an effort level this engine models. Then the evidence is keyed at the APPLIED effort — which for an
// `appliedEffortMismatch` run is not the effort that was asked for, because that is where the work was
// actually done. Every other run is `unobservable`: a requested effort that was sent and accepted is not an
// observed effort (an accepted request is not an honoured one), and a measurement that was unavailable or
// ambiguous is not one either. Nothing here reads an effort from a model name, a candidate label or a default.
//
// UNOBSERVABLE IS KEYED BY WHAT WAS ASKED, NOT POOLED. `claudeCLI:m@unobservable:high` and
// `claudeCLI:m@unobservable:max` are two keys: two different requests are two different experiments even
// when neither can be checked, and folding them together is how a comparison averages two configurations.
// A row that recorded no effort at all is `@unobservable:unrecorded`.
//
// THE NOTATION IS THE LADDER'S. `provider:model@effort`, as `parseFrontierSpec` names a candidate — except
// that `@none` is always written here, because an observed `none` and an unobservable effort must never
// print the same way. The unobservable suffix is `@unobservable:<requested>`.
//
// THE POOLED VIEW IS UNCHANGED. A record or history derived WITHOUT an effort key is byte-identical to
// what it always was, and `cernum candidates` without `--by-effort` still answers crc2 exactly as before.
// The keyed view is a new contract, cek1, beside crc2 — never a change to it.

import { compareCodePoints } from './canonical';
import { ObservationStoreContents } from './observation-store';
import { EFFORT_LEVELS, EffortLevel, ProviderID } from './provider';
import { routeQuarantineStatus } from './route-quarantine';
import {
  ROUTING_CONTRACT_VERSION, RouteCandidate, RouteCandidateQuery, RouteForQuery, availabilityFromStore, qualifiedRouteCandidates,
} from './routing-contract';
import { RoutingPolicyVersion, CURRENT_ROUTING_POLICY_VERSION } from './routing-policy';
import type { RouteQualificationRecord } from './route-qualification';
import { WorkspaceRunRow } from './workspace-aggregate';

export const EFFORT_KEYED_CANDIDATES_SCHEMA = 'cek1';

/** The state word in a key whose effort was not observed. */
export const EFFORT_UNOBSERVABLE = 'unobservable';

/** What a row's `requestedEffort`/`effort` says was asked for, or `unrecorded` when it says nothing usable. */
export type RequestedEffort = EffortLevel | 'unrecorded';

/** The effort part of a route's identity for qualification. */
export type EffortKey =
  | { state: 'observed'; effort: EffortLevel }
  | { state: 'unobservable'; requestedEffort: RequestedEffort };

export const EFFORT_KEYS_ARE_NOT_POOLED =
  'Evidence is keyed by the effort it was gathered at. An effort is OBSERVED only when the tool\'s own telemetry '
  + 'measured the applied effort; that evidence is keyed provider:model@<applied effort>. Every other run is keyed '
  + 'provider:model@unobservable:<requested effort>, because a requested effort that was accepted is not an observed '
  + 'one. No key\'s evidence is pooled into another\'s, and no effort is read from a model name.';

const text = (row: Record<string, unknown>, key: string): string | undefined =>
  (typeof row[key] === 'string' ? row[key] as string : undefined);

const isEffortLevel = (value: string | undefined): value is EffortLevel =>
  value !== undefined && (EFFORT_LEVELS as string[]).includes(value);

/** Verdicts under which a measured `appliedEffort` is the effort the work ran at. */
const MEASURED_VERDICTS = ['appliedEffortVerified', 'appliedEffortMismatch', 'appliedEffortNotRequested'];

/** One row's effort key, with the source that observed it or the reason nothing did. */
export function rowEffortKey(row: Record<string, unknown>): { key: EffortKey; requestedEffort: RequestedEffort; basis: string } {
  const asked = text(row, 'requestedEffort') ?? text(row, 'effort');
  const requestedEffort: RequestedEffort = isEffortLevel(asked) ? asked : 'unrecorded';
  const verdict = text(row, 'appliedEffortVerdict');
  const applied = text(row, 'appliedEffort');
  if (verdict !== undefined && MEASURED_VERDICTS.includes(verdict) && isEffortLevel(applied)) {
    return { key: { state: 'observed', effort: applied }, requestedEffort,
      basis: `${verdict}: ${text(row, 'appliedEffortEvidenceSource') ?? 'the tool\'s telemetry'}` };
  }
  return { key: { state: 'unobservable', requestedEffort }, requestedEffort,
    basis: verdict === undefined
      ? 'this run\'s driver measures no applied effort; the requested effort was sent, and an accepted request is not an observed effort'
      : `${verdict}: the tool's telemetry did not establish an applied effort this engine models` };
}

/** `high`, or `unobservable:high`. */
export function effortKeySuffix(key: EffortKey): string {
  return key.state === 'observed' ? key.effort : `${EFFORT_UNOBSERVABLE}:${key.requestedEffort}`;
}

/** `provider:model@high`, or `provider:model@unobservable:high`. */
export function effortRouteKey(provider: ProviderID, modelID: string, key: EffortKey): string {
  return `${provider}:${modelID}@${effortKeySuffix(key)}`;
}

/** Parse a suffix back to a key. Anything this engine does not model is refused, never mapped to a neighbour. */
export function parseEffortKeySuffix(suffix: string): EffortKey {
  if (isEffortLevel(suffix)) return { state: 'observed', effort: suffix };
  const prefix = `${EFFORT_UNOBSERVABLE}:`;
  if (suffix.startsWith(prefix)) {
    const requested = suffix.slice(prefix.length);
    if (isEffortLevel(requested) || requested === 'unrecorded') return { state: 'unobservable', requestedEffort: requested };
  }
  throw new Error(`'${suffix}' is not an effort key. Use one of ${EFFORT_LEVELS.join(', ')}, or `
    + `${prefix}<requested effort|unrecorded>.`);
}

/** `provider:model@<suffix>`, split at the first colon and the LAST `@`. */
export function parseEffortRouteKey(keyText: string): { provider: ProviderID; modelID: string; routeKey: string; effortKey: EffortKey } {
  const colon = keyText.indexOf(':');
  const at = keyText.lastIndexOf('@');
  if (colon <= 0 || at <= colon + 1 || at === keyText.length - 1) {
    throw new Error(`'${keyText}' is not an effort-keyed route. Write provider:model@effort, for example codexCLI:gpt-5-codex@medium.`);
  }
  const effortKey = parseEffortKeySuffix(keyText.slice(at + 1));
  const provider = keyText.slice(0, colon) as ProviderID;
  const modelID = keyText.slice(colon + 1, at);
  return { provider, modelID, routeKey: `${provider}:${modelID}`, effortKey };
}

export function sameEffortKey(a: EffortKey, b: EffortKey): boolean {
  return effortKeySuffix(a) === effortKeySuffix(b);
}

/** Observed levels in EFFORT_LEVELS order, then the unobservable keys in the same order, `unrecorded` last. */
export function compareEffortKeys(a: EffortKey, b: EffortKey): number {
  const rank = (key: EffortKey): number => (key.state === 'observed' ? EFFORT_LEVELS.indexOf(key.effort)
    : EFFORT_LEVELS.length + (key.requestedEffort === 'unrecorded' ? EFFORT_LEVELS.length : EFFORT_LEVELS.indexOf(key.requestedEffort)));
  return rank(a) - rank(b);
}

/** The runs of one route — `provider` and `requestedModelID` — whose effort key is `key`. */
export function runsAtEffortKey(rows: WorkspaceRunRow[], provider: ProviderID, modelID: string, key: EffortKey): WorkspaceRunRow[] {
  return rows.filter(({ row }) => row.provider === provider && row.requestedModelID === modelID
    && sameEffortKey(rowEffortKey(row).key, key));
}

/** Every effort key one route's runs fall under, in `compareEffortKeys` order. Empty for a route nobody ran. */
export function routeEffortKeys(rows: WorkspaceRunRow[], provider: ProviderID, modelID: string): EffortKey[] {
  const keys = new Map<string, EffortKey>();
  for (const { row } of rows) {
    if (row.provider !== provider || row.requestedModelID !== modelID) continue;
    const { key } = rowEffortKey(row);
    keys.set(effortKeySuffix(key), key);
  }
  return [...keys.values()].sort(compareEffortKeys);
}

/** The effort a keyed record's evidence was gathered at, and how that is known. Carried on the record. */
export interface EvidenceEffort {
  effortRouteKey: string;
  state: EffortKey['state'];
  /** The observed level; absent when unobservable. */
  effort?: EffortLevel;
  /** What the runs under this key asked for. Under an observed key it can differ from `effort` (a mismatch). */
  requestedEfforts: RequestedEffort[];
  runCount: number;
  /** Runs under an observed key whose applied effort differs from the effort they asked for. */
  mismatchedRunCount: number;
  /** Which telemetry observed it, or why nothing did. One line per distinct basis. */
  basis: string[];
  /** Evidence carrying no effort that a keyed record leaves out, in words. Empty when nothing was left out. */
  notKeyed: string[];
}

/** Summarise the runs under one key. PURE. */
export function evidenceEffortOf(provider: ProviderID, modelID: string, key: EffortKey, runs: WorkspaceRunRow[]): EvidenceEffort {
  const read = runs.map(({ row }) => rowEffortKey(row));
  const requestedEfforts = [...new Set(read.map((entry) => entry.requestedEffort))]
    .sort((a, b) => compareEffortKeys({ state: 'unobservable', requestedEffort: a }, { state: 'unobservable', requestedEffort: b }));
  return {
    effortRouteKey: effortRouteKey(provider, modelID, key),
    state: key.state,
    ...(key.state === 'observed' ? { effort: key.effort } : {}),
    requestedEfforts,
    runCount: runs.length,
    mismatchedRunCount: read.filter((entry) => entry.basis.startsWith('appliedEffortMismatch:')).length,
    basis: [...new Set(read.map((entry) => entry.basis))].sort(compareCodePoints),
    notKeyed: [],
  };
}

// ---- the keyed candidate view, cek1 ----------------------------------------------------------------

export interface EffortKeyedRouteCandidate extends RouteCandidate {
  effortRouteKey: string;
  evidenceEffort: EvidenceEffort;
}

export interface EffortKeyedCandidateSet {
  schema: typeof EFFORT_KEYED_CANDIDATES_SCHEMA;
  /** The crc2 rules every keyed record was answered under, unchanged. */
  contract: typeof ROUTING_CONTRACT_VERSION;
  query: RouteCandidateQuery;
  routingPolicyVersion: RoutingPolicyVersion;
  candidates: EffortKeyedRouteCandidate[];
  excluded: { effortRouteKey: string; routeKey: string; evidenceEffort: EvidenceEffort; reasons: string[] }[];
  /** Routes the query could see that no workspace run measured at any effort, so there is nothing to key. */
  unkeyed: { routeKey: string; reason: string }[];
  ordering: string;
  disclosure: string;
  effortDisclosure: string;
}

/** A keyed record: derived with an `effortKey`, so it carries `evidenceEffort`. */
export type EffortKeyedRecord = RouteQualificationRecord & { evidenceEffort: EvidenceEffort };

export function isEffortKeyedRecord(record: RouteQualificationRecord): record is EffortKeyedRecord {
  return (record as Partial<EffortKeyedRecord>).evidenceEffort !== undefined;
}

/**
 * Answer one query per keyed record, by the crc2 rules unchanged. PURE.
 *
 * Each keyed record is put to `qualifiedRouteCandidates` on its own, so the reasons a key was excluded are
 * that key's and nobody else's — two efforts of one route never share an exclusion or a verdict.
 */
export function effortKeyedRouteCandidates(query: RouteCandidateQuery, routes: (RouteForQuery & { record: EffortKeyedRecord })[],
                                           unkeyed: { routeKey: string; reason: string }[] = []): EffortKeyedCandidateSet {
  const candidates: EffortKeyedRouteCandidate[] = [];
  const excluded: EffortKeyedCandidateSet['excluded'] = [];
  for (const route of routes) {
    const answer = qualifiedRouteCandidates(query, [route]);
    const { evidenceEffort } = route.record;
    for (const candidate of answer.candidates) {
      candidates.push({ ...candidate, effortRouteKey: evidenceEffort.effortRouteKey, evidenceEffort });
    }
    for (const entry of answer.excluded) {
      excluded.push({ effortRouteKey: evidenceEffort.effortRouteKey, routeKey: entry.routeKey, evidenceEffort, reasons: entry.reasons });
    }
  }
  const keyOf = (entry: { evidenceEffort: EvidenceEffort }): EffortKey => parseEffortRouteKey(entry.evidenceEffort.effortRouteKey).effortKey;
  const byRouteThenEffort = (a: { routeKey: string; evidenceEffort: EvidenceEffort }, b: { routeKey: string; evidenceEffort: EvidenceEffort }): number =>
    compareCodePoints(a.routeKey, b.routeKey) || compareEffortKeys(keyOf(a), keyOf(b));
  const groupRank = (candidate: RouteCandidate): number => (candidate.group === 'zeroMarginalCost' ? 0 : 1);
  candidates.sort((a, b) => groupRank(a) - groupRank(b) || byRouteThenEffort(a, b));
  excluded.sort(byRouteThenEffort);
  return {
    schema: EFFORT_KEYED_CANDIDATES_SCHEMA,
    contract: ROUTING_CONTRACT_VERSION,
    query,
    routingPolicyVersion: query.routingPolicyVersion ?? CURRENT_ROUTING_POLICY_VERSION,
    candidates,
    excluded,
    unkeyed: [...unkeyed].sort((a, b) => compareCodePoints(a.routeKey, b.routeKey)),
    ordering: 'zero-marginal-cost group first, then route key, then effort key (observed levels, then unobservable); '
      + 'NO preference within a group',
    disclosure: 'This is the set of effort-keyed routes the evidence QUALIFIES for the query, not a choice among them. '
      + 'Each key was answered by the crc2 rules on the evidence gathered under that key alone.',
    effortDisclosure: EFFORT_KEYS_ARE_NOT_POOLED,
  };
}

/** The same, with availability resolved from a persisted store, exactly as `qualifiedRouteCandidatesFromStore`. */
export function effortKeyedRouteCandidatesFromStore(query: RouteCandidateQuery, contents: ObservationStoreContents,
                                                    routes: { record: EffortKeyedRecord }[], now: Date,
                                                    unkeyed: { routeKey: string; reason: string }[] = []): EffortKeyedCandidateSet {
  return effortKeyedRouteCandidates(query, routes.map((route) => ({
    ...route,
    availability: availabilityFromStore(contents, route.record.routeKey, query.machineKey, now, query.maximumAvailabilityAgeMilliseconds),
    quarantine: routeQuarantineStatus(contents, route.record.routeKey),
  })), unkeyed);
}
