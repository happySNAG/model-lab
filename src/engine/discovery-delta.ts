// Benchmark engine · WHICH MODELS ARE NEW, WHICH CHANGED, AND WHICH DISAPPEARED between two discovery
// snapshots — per MODEL, not per route key, and with what changed named field by field.
//
// WHY THIS IS NOT `diffDiscoverySnapshots`. That diff answers a qualification question, route key by
// route key: is the evidence for THIS identifier still describing what exists? A release watcher asks a
// different one: did a MODEL appear, change or go? Two identifiers a source stated are the same model
// (`sonnet` and `claude-sonnet-4-5`) are one model here, so a CLI that starts listing an alias of a model
// it already listed has not released anything. The per-route diff is reused, not re-implemented: every
// kind, sentence and staleness flag below comes from it, and this module only groups and names fields.
//
// THE RULES.
//
//   PURE. Two snapshots and the alias statements in, one document out. No clock, no file, no network.
//   ONE MACHINE. A local route observed on one Mac says nothing about another, so two snapshots from
//   different machines are refused, exactly as `refreshDiscovery` refuses them.
//   A PROVIDER THAT DID NOT ANSWER CONTRIBUTES NO DISAPPEARANCE. Its models are `notRefreshed`.
//   DISAPPEARED IS NOT RETIRED. A model a listing stopped naming is reported as gone from the listing;
//   whether the provider retired it is a lifecycle statement only a source can make (cmd2).
//   DISCOVERED IS NOT REACHABLE, REACHABLE IS NOT QUALIFIED. A new model here is a model a listing named.

import { compareCodePoints } from './canonical';
import { DiscoveryDelta, DiscoveryDeltaKind, DiscoverySnapshot, RouteObservation, diffDiscoverySnapshots } from './discovery-refresh';
import { AliasStatement, AliasTable, buildAliasTable, resolveAlias } from './model-description';
import { ProviderID } from './provider';

export const DISCOVERY_DELTA_SCHEMA = 'cdd1';

/** The fields of a route observation a delta compares. Timestamps are not among them: they move every refresh. */
export const COMPARED_ROUTE_FIELDS = [
  'listed', 'availability', 'priceFingerprint', 'publishedFree', 'contextWindowTokens', 'runtimeDigest', 'runtimeVersion',
] as const;

export type ComparedRouteField = typeof COMPARED_ROUTE_FIELDS[number];

/** One field of one route that moved. `null` is "absent in that snapshot". */
export interface FieldChange {
  routeKey: string;
  field: ComparedRouteField;
  before: string | number | boolean | null;
  after: string | number | boolean | null;
}

/** One model, as the delta sees it. */
export interface DiscoveryDeltaModel {
  canonicalRouteKey: string;
  provider: ProviderID;
  canonicalModelID: string;
  /** Every route key in either snapshot that resolves to this model, sorted. */
  routeKeys: string[];
  /** The per-route kinds `diffDiscoverySnapshots` reported for its routes, deduplicated. */
  kinds: DiscoveryDeltaKind[];
  changes: FieldChange[];
  /** One sentence per thing that moved, from the per-route diff. */
  detail: string[];
  /** True when a qualification of any of its routes must be re-established. */
  qualificationNowStale: boolean;
}

export interface DiscoveryDeltaReport {
  schema: typeof DISCOVERY_DELTA_SCHEMA;
  machineKey: string;
  /** Absent when there was no earlier snapshot: then every listed model is new. */
  beforeTakenAt?: string;
  afterTakenAt: string;
  new: DiscoveryDeltaModel[];
  changed: DiscoveryDeltaModel[];
  disappeared: DiscoveryDeltaModel[];
  /** Models of a provider that did not answer the later refresh. Neither changed nor gone: not looked at. */
  notRefreshed: DiscoveryDeltaModel[];
  unchangedCount: number;
  /** Identifiers whose alias statements disagree or cycle; each is treated as its own model. */
  unresolvedAliases: { routeKey: string; reason: string }[];
  disclosure: string;
}

export const DISCOVERY_DELTA_DISCLOSURE =
  'A new model is one a listing named that no earlier snapshot on this machine listed; it is discovered, not '
  + 'reachable, and reachable is not qualified. A disappeared model is one the listing stopped naming, which '
  + 'is not a statement that it was retired. A provider that did not answer contributes no disappearance. '
  + 'Aliases are merged only where a source stated them. Nothing here contacted a model or wrote a file.';

export class DiscoveryDeltaError extends Error {
  constructor(readonly code: 'crossMachine' | 'outOfOrder', message: string) {
    super(message);
    this.name = 'DiscoveryDeltaError';
  }
}

function fieldValue(route: RouteObservation | undefined, field: ComparedRouteField): string | number | boolean | null {
  if (route === undefined) return null;
  const value = route[field];
  return value === undefined ? null : value;
}

/** Which model a route key belongs to. An ambiguous resolution leaves it as its own. */
function canonicalOf(table: AliasTable, route: RouteObservation, unresolved: Map<string, string>): string {
  const resolution = resolveAlias(table, route.provider, route.modelID);
  if (resolution.state === 'ambiguous') {
    unresolved.set(route.routeKey, resolution.reason);
    return route.routeKey;
  }
  return resolution.canonicalRouteKey;
}

/**
 * Two snapshots in, a per-model delta out. PURE and ORDER-INDEPENDENT within each snapshot.
 *
 * A model is NEW when none of its routes was listed before and one is now; DISAPPEARED when one was
 * listed before and none is now (and its provider answered); CHANGED when it was and is listed and any
 * compared field of any of its routes moved, including a new alias being listed.
 */
export function deriveDiscoveryDelta(before: DiscoverySnapshot | undefined, after: DiscoverySnapshot,
                                     options: { aliases?: AliasStatement[] } = {}): DiscoveryDeltaReport {
  if (before !== undefined && before.machineKey !== after.machineKey) {
    throw new DiscoveryDeltaError('crossMachine', `the earlier snapshot was taken on ${before.machineKey} and the later on `
      + `${after.machineKey}. A local route observed on one machine says nothing about another, so they are not compared.`);
  }
  if (before !== undefined && Date.parse(before.takenAt) > Date.parse(after.takenAt)) {
    throw new DiscoveryDeltaError('outOfOrder', `the earlier snapshot (${before.takenAt}) was taken after the later one `
      + `(${after.takenAt}). Name them oldest first.`);
  }
  const table = buildAliasTable(options.aliases ?? []);
  const unresolved = new Map<string, string>();
  const routeDeltas = diffDiscoverySnapshots(before, after);
  const beforeRoutes = new Map((before?.routes ?? []).map((route) => [route.routeKey, route]));
  const afterRoutes = new Map(after.routes.map((route) => [route.routeKey, route]));

  const groups = new Map<string, DiscoveryDelta[]>();
  for (const delta of routeDeltas) {
    const route = (delta.after ?? delta.before)!;
    const canonical = canonicalOf(table, route, unresolved);
    groups.set(canonical, [...(groups.get(canonical) ?? []), delta]);
  }

  const report: DiscoveryDeltaReport = {
    schema: DISCOVERY_DELTA_SCHEMA, machineKey: after.machineKey,
    ...(before === undefined ? {} : { beforeTakenAt: before.takenAt }),
    afterTakenAt: after.takenAt,
    new: [], changed: [], disappeared: [], notRefreshed: [], unchangedCount: 0,
    unresolvedAliases: [...unresolved.entries()].map(([routeKey, reason]) => ({ routeKey, reason }))
      .sort((a, b) => compareCodePoints(a.routeKey, b.routeKey)),
    disclosure: DISCOVERY_DELTA_DISCLOSURE,
  };

  for (const [canonicalRouteKey, deltas] of [...groups.entries()].sort((a, b) => compareCodePoints(a[0], b[0]))) {
    const routeKeys = deltas.map((delta) => delta.routeKey).sort(compareCodePoints);
    const changes: FieldChange[] = [];
    for (const routeKey of routeKeys) {
      const was = beforeRoutes.get(routeKey);
      const now = afterRoutes.get(routeKey);
      if (was === undefined || now === undefined) continue;
      for (const field of COMPARED_ROUTE_FIELDS) {
        const from = fieldValue(was, field);
        const to = fieldValue(now, field);
        if (from !== to) changes.push({ routeKey, field, before: from, after: to });
      }
    }
    const kinds = [...new Set(deltas.flatMap((delta) => delta.kinds))].sort(compareCodePoints) as DiscoveryDeltaKind[];
    const model: DiscoveryDeltaModel = {
      canonicalRouteKey,
      provider: (deltas[0].after ?? deltas[0].before)!.provider,
      canonicalModelID: canonicalRouteKey.slice(canonicalRouteKey.indexOf(':') + 1),
      routeKeys,
      kinds,
      changes,
      detail: deltas.flatMap((delta) => delta.detail.filter(() => !delta.kinds.includes('noMaterialChange'))),
      qualificationNowStale: deltas.some((delta) => delta.qualificationNowStale),
    };
    if (deltas.some((delta) => delta.kinds.includes('notRefreshed'))) { report.notRefreshed.push(model); continue; }
    const wasListed = routeKeys.some((routeKey) => beforeRoutes.get(routeKey)?.listed === true);
    const isListed = routeKeys.some((routeKey) => afterRoutes.get(routeKey)?.listed === true);
    if (!wasListed && isListed) {
      // A model seen before and unlisted is a RETURN, which is a change to a known model, not a release.
      if (routeKeys.some((routeKey) => beforeRoutes.has(routeKey))) report.changed.push(model);
      else report.new.push(model);
    } else if (wasListed && !isListed) {
      report.disappeared.push(model);
    } else if (wasListed && isListed && changes.length > 0) {
      report.changed.push(model);
    } else if (wasListed && isListed && routeKeys.some((routeKey) => !beforeRoutes.has(routeKey) && afterRoutes.get(routeKey)?.listed === true)) {
      // An alias of a listed model, listed for the first time: the model is not new, its naming changed.
      report.changed.push(model);
    } else {
      report.unchangedCount += 1;
    }
  }
  return report;
}

/** The delta, in lines a person reads. */
export function describeDiscoveryDelta(report: DiscoveryDeltaReport): string[] {
  const lines = [
    `Discovery delta ${report.schema} · machine ${report.machineKey}`,
    `  ${report.beforeTakenAt === undefined ? '(no earlier snapshot)' : report.beforeTakenAt} → ${report.afterTakenAt}`,
    `  ${report.new.length} new · ${report.changed.length} changed · ${report.disappeared.length} disappeared · `
      + `${report.notRefreshed.length} not refreshed · ${report.unchangedCount} unchanged`,
  ];
  const section = (title: string, models: DiscoveryDeltaModel[]) => {
    if (models.length === 0) return;
    lines.push('', title);
    for (const model of models) {
      const aliases = model.routeKeys.filter((routeKey) => routeKey !== model.canonicalRouteKey);
      lines.push(`  ${model.canonicalRouteKey}${aliases.length === 0 ? '' : `  (also ${aliases.join(', ')})`}`
        + `${model.qualificationNowStale ? '  · qualification now stale' : ''}`);
      for (const change of model.changes) {
        lines.push(`    ${change.routeKey} ${change.field}: ${JSON.stringify(change.before)} → ${JSON.stringify(change.after)}`);
      }
      if (model.changes.length === 0) for (const sentence of model.detail) lines.push(`    ${sentence}`);
    }
  };
  section('NEW', report.new);
  section('CHANGED', report.changed);
  section('DISAPPEARED (from the listing; not a statement of retirement)', report.disappeared);
  section('NOT REFRESHED (the provider did not answer; nothing was re-observed)', report.notRefreshed);
  for (const entry of report.unresolvedAliases) lines.push('', `  alias unresolved: ${entry.routeKey}: ${entry.reason}`);
  return lines;
}
