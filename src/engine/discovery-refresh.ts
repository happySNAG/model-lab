// Benchmark engine · REFRESHING what discovery knows, saying exactly what changed, and deciding what
// that change makes stale.
//
// WHAT WAS MISSING. `discovery-store.ts` gives a proof a seven-day life and reports it EXPIRED after
// that. That is one staleness rule, keyed on one thing — age — and it cannot see the changes that
// actually break a qualification: a free tier that starts charging, a model that leaves the catalogue
// and comes back, a local tag re-pulled over different weights, a CLI upgraded underneath a driver
// verified against the old one. Each of those can happen inside seven days, and each makes evidence
// that is young by the calendar describe something that no longer exists.
//
// SO THIS MODULE HAS THREE PURE PARTS AND ONE THIN OPERATION.
//
//   A SNAPSHOT     what one refresh observed, route by route, on one machine, with every material
//                  property normalised into comparable fields. A route a listing no longer names is
//                  KEPT, marked `listed: false` — the only way "it came back" can ever be said.
//   A DIFF         two snapshots in, a closed vocabulary of changes out, per route. `noMaterialChange`
//                  is a real answer and is reported as one.
//   A STALENESS    per route and per qualification: is what was discovered still current, and is what
//                  was QUALIFIED still describing the route that exists now?
//   A REFRESH      probe each configured provider with an injected function, fold the answers into the
//                  next snapshot, and diff. A provider whose probe FAILED contributes no disappearance:
//                  "the tool did not answer" is never read as "the model is gone".
//
// NO SCHEDULER. Nothing here runs on a timer, because nothing in this engine does. A future scheduler
// calls `refreshDiscovery` and acts on the deltas; the decision about what a change means is made here,
// deterministically, so the scheduler has nothing to decide.

import { ModelAvailability, ProviderStatus } from './discovery';
import { DISCOVERY_EVIDENCE_MAX_AGE_MILLISECONDS } from './discovery-store';
import { PublishedCataloguePrice } from './opencode-pricing';
import { ProviderID } from './provider';

export const DISCOVERY_SNAPSHOT_SCHEMA = 'cds1';

/** Everything a refresh observed about ONE route that could change what the route is. */
export interface RouteObservation {
  routeKey: string;
  provider: ProviderID;
  modelID: string;
  /** Whether the provider's listing (or the local runtime) named it on this refresh. */
  listed: boolean;
  availability?: ModelAvailability | 'installedLocally';
  /** `in:<µUSD/Mtok>/out:<µUSD/Mtok>` from a PUBLISHED price, or absent when none is known. */
  priceFingerprint?: string;
  /** Whether the published price was $0/$0. Absent when no price is known. */
  publishedFree?: boolean;
  contextWindowTokens?: number;
  /** A local route's weights digest. */
  runtimeDigest?: string;
  /** The runtime or CLI version that served this observation. */
  runtimeVersion?: string;
  /** When this route was last actually SEEN (not carried forward). */
  observedAt: string;
}

/** Whether a provider answered this refresh. A failed probe carries its routes forward untouched. */
export interface ProviderRefreshOutcome {
  provider: ProviderID;
  refreshed: boolean;
  detail: string;
}

export interface DiscoverySnapshot {
  schema: typeof DISCOVERY_SNAPSHOT_SCHEMA;
  /** The `cmk1:` key of the machine that took it. A local route in it is true of that machine only. */
  machineKey: string;
  takenAt: string;
  providers: ProviderRefreshOutcome[];
  routes: RouteObservation[];
}

export type DiscoveryDeltaKind =
  | 'newlyDiscovered'
  | 'disappeared'
  | 'returned'
  | 'priceChanged'
  | 'freeStatusChanged'
  | 'contextChanged'
  | 'runtimeDigestChanged'
  | 'runtimeVersionChanged'
  | 'availabilityChanged'
  /** The provider did not answer this refresh; nothing about its routes was re-observed. */
  | 'notRefreshed'
  | 'noMaterialChange';

export interface DiscoveryDelta {
  routeKey: string;
  kinds: DiscoveryDeltaKind[];
  before?: RouteObservation;
  after?: RouteObservation;
  /** One sentence per kind, naming the values that moved. */
  detail: string[];
  /** True when a qualification of this route must be re-established before it is routed on again. */
  qualificationNowStale: boolean;
}

/** The kinds that change WHAT the route is, and so invalidate a qualification of it. */
export const MATERIAL_DELTA_KINDS: DiscoveryDeltaKind[] = [
  'disappeared', 'priceChanged', 'freeStatusChanged', 'contextChanged', 'runtimeDigestChanged', 'runtimeVersionChanged',
];

export function priceFingerprintOf(price: { inputMicroUSDPerMillionTokens: number; outputMicroUSDPerMillionTokens: number }): string {
  return `in:${price.inputMicroUSDPerMillionTokens}/out:${price.outputMicroUSDPerMillionTokens}`;
}

/**
 * Two snapshots in, one delta per route out. PURE and ORDER-INDEPENDENT: routes are compared by key and
 * the result is sorted by key, so the same two snapshots always produce the same deltas.
 */
export function diffDiscoverySnapshots(previous: DiscoverySnapshot | undefined, next: DiscoverySnapshot): DiscoveryDelta[] {
  const before = new Map((previous?.routes ?? []).map((route) => [route.routeKey, route]));
  const after = new Map(next.routes.map((route) => [route.routeKey, route]));
  const unrefreshed = new Set(next.providers.filter((entry) => !entry.refreshed).map((entry) => entry.provider));
  const keys = [...new Set([...before.keys(), ...after.keys()])].sort();

  return keys.map((routeKey) => {
    const was = before.get(routeKey);
    const now = after.get(routeKey);
    const kinds: DiscoveryDeltaKind[] = [];
    const detail: string[] = [];
    const provider = (now ?? was)!.provider;

    if (unrefreshed.has(provider)) {
      kinds.push('notRefreshed');
      detail.push(`${provider} did not answer this refresh, so ${routeKey} was not re-observed; its last observation stands`);
      return { routeKey, kinds, before: was, after: now, detail, qualificationNowStale: false };
    }

    const wasListed = was?.listed === true;
    const isListed = now?.listed === true;
    if (was === undefined && isListed) {
      kinds.push('newlyDiscovered'); detail.push(`${routeKey} is listed for the first time`);
    } else if (wasListed && !isListed) {
      kinds.push('disappeared'); detail.push(`${routeKey} was listed and is no longer`);
    } else if (was !== undefined && !wasListed && isListed) {
      kinds.push('returned'); detail.push(`${routeKey} was not listed on the previous refresh and is listed again`);
    }

    if (was !== undefined && now !== undefined && isListed) {
      if (was.priceFingerprint !== now.priceFingerprint) {
        kinds.push('priceChanged'); detail.push(`published price ${was.priceFingerprint ?? '(none)'} → ${now.priceFingerprint ?? '(none)'}`);
      }
      if (was.publishedFree !== now.publishedFree) {
        kinds.push('freeStatusChanged');
        detail.push(`published free status ${String(was.publishedFree ?? 'unknown')} → ${String(now.publishedFree ?? 'unknown')}`);
      }
      if (was.contextWindowTokens !== now.contextWindowTokens) {
        kinds.push('contextChanged'); detail.push(`context window ${was.contextWindowTokens ?? '(unknown)'} → ${now.contextWindowTokens ?? '(unknown)'}`);
      }
      if (was.runtimeDigest !== now.runtimeDigest) {
        kinds.push('runtimeDigestChanged'); detail.push(`weights digest ${was.runtimeDigest ?? '(none)'} → ${now.runtimeDigest ?? '(none)'}`);
      }
      if (was.runtimeVersion !== now.runtimeVersion) {
        kinds.push('runtimeVersionChanged'); detail.push(`runtime version ${was.runtimeVersion ?? '(unknown)'} → ${now.runtimeVersion ?? '(unknown)'}`);
      }
      if (was.availability !== now.availability) {
        kinds.push('availabilityChanged'); detail.push(`availability ${was.availability ?? '(unknown)'} → ${now.availability ?? '(unknown)'}`);
      }
    }
    if (kinds.length === 0) { kinds.push('noMaterialChange'); detail.push(`${routeKey}: nothing that describes the route moved`); }
    return {
      routeKey, kinds, before: was, after: now, detail,
      qualificationNowStale: kinds.some((kind) => MATERIAL_DELTA_KINDS.includes(kind)),
    };
  });
}

// MARK: - Freshness of what was discovered

export type RouteFreshness =
  | 'currentlyDiscovered'
  | 'discoveredButStale'
  /** Listed, and something said it cannot be used here: refused, or the provider did not answer. */
  | 'unavailable'
  | 'noLongerListed'
  | 'neverDiscovered';

export function routeFreshness(snapshot: DiscoverySnapshot | undefined, routeKey: string, now: Date,
                               maxAge = DISCOVERY_EVIDENCE_MAX_AGE_MILLISECONDS): { state: RouteFreshness; reason: string } {
  const route = snapshot?.routes.find((entry) => entry.routeKey === routeKey);
  if (snapshot === undefined || route === undefined) {
    return { state: 'neverDiscovered', reason: `no refresh on this machine has observed ${routeKey}` };
  }
  if (!route.listed) {
    return { state: 'noLongerListed', reason: `${routeKey} was not named by the last refresh (last seen ${route.observedAt})` };
  }
  const provider = snapshot.providers.find((entry) => entry.provider === route.provider);
  if (route.availability === 'refused' || provider?.refreshed === false) {
    return { state: 'unavailable', reason: route.availability === 'refused'
      ? `${routeKey} is listed and was refused when asked`
      : `${route.provider} did not answer the last refresh: ${provider?.detail ?? ''}` };
  }
  const age = now.getTime() - Date.parse(route.observedAt);
  if (Number.isNaN(age) || age > maxAge) {
    return { state: 'discoveredButStale', reason: `${routeKey} was last observed ${route.observedAt}, older than the `
      + `${Math.round(maxAge / 86_400_000)}-day discovery window` };
  }
  return { state: 'currentlyDiscovered', reason: `${routeKey} observed ${route.observedAt}` };
}

// MARK: - Staleness of what was QUALIFIED

/** What a qualification was established against. Read from the evidence rows, never re-typed. */
export interface QualificationBasis {
  routeKey: string;
  qualifiedAt: string;
  driverID: string;
  /** The CLI version (or harness version) the driver ran under. */
  driverVersion?: string;
  runtimeDigest?: string;
  runtimeVersion?: string;
  priceFingerprint?: string;
  publishedFree?: boolean;
  contextWindowTokens?: number;
}

export type QualificationStalenessReason =
  | 'qualificationStillValid'
  | 'staleModelMateriallyChanged'
  | 'staleRouteChanged'
  | 'staleRuntimeDigestChanged'
  | 'staleRouteNoLongerAvailable'
  | 'staleEvidenceExpired';

/** A qualification older than this is re-established even if nothing visibly moved. */
export const QUALIFICATION_MAX_AGE_MILLISECONDS = 30 * 24 * 60 * 60 * 1_000;

/**
 * Is a qualification still describing the route that exists now?
 *
 * EVERY REASON IS RETURNED, not the first: a route whose digest changed AND whose driver was upgraded
 * has two things to re-establish, and a reader told only one would re-qualify against the wrong question.
 */
export function qualificationStaleness(basis: QualificationBasis, current: RouteObservation | undefined, context: {
  driverID: string; driverVersion?: string; now: Date; maxAge?: number;
}): { valid: boolean; reasons: QualificationStalenessReason[]; detail: string[] } {
  const reasons: QualificationStalenessReason[] = [];
  const detail: string[] = [];
  if (current === undefined || !current.listed) {
    reasons.push('staleRouteNoLongerAvailable');
    detail.push(`${basis.routeKey} is not listed by the current discovery, so the route that was qualified does not exist now`);
  } else {
    if (basis.runtimeDigest !== undefined && current.runtimeDigest !== basis.runtimeDigest) {
      reasons.push('staleRuntimeDigestChanged');
      detail.push(`qualified under weights ${basis.runtimeDigest}; the runtime now reports ${current.runtimeDigest ?? '(none)'}`);
    }
    const material: string[] = [];
    if (basis.priceFingerprint !== undefined && current.priceFingerprint !== basis.priceFingerprint) {
      material.push(`price ${basis.priceFingerprint} → ${current.priceFingerprint ?? '(none)'}`);
    }
    if (basis.publishedFree !== undefined && current.publishedFree !== basis.publishedFree) {
      material.push(`published free status ${String(basis.publishedFree)} → ${String(current.publishedFree ?? 'unknown')}`);
    }
    if (basis.contextWindowTokens !== undefined && current.contextWindowTokens !== basis.contextWindowTokens) {
      material.push(`context ${basis.contextWindowTokens} → ${current.contextWindowTokens ?? '(unknown)'}`);
    }
    if (basis.runtimeVersion !== undefined && current.runtimeVersion !== undefined && current.runtimeVersion !== basis.runtimeVersion) {
      material.push(`runtime ${basis.runtimeVersion} → ${current.runtimeVersion}`);
    }
    if (material.length > 0) {
      reasons.push('staleModelMateriallyChanged');
      detail.push(`the route changed materially since it was qualified: ${material.join('; ')}`);
    }
  }
  if (basis.driverID !== context.driverID
      || (basis.driverVersion !== undefined && context.driverVersion !== undefined && basis.driverVersion !== context.driverVersion)) {
    reasons.push('staleRouteChanged');
    detail.push(`qualified through ${basis.driverID}@${basis.driverVersion ?? '?'}; this build drives it through `
      + `${context.driverID}@${context.driverVersion ?? '?'}`);
  }
  const age = context.now.getTime() - Date.parse(basis.qualifiedAt);
  if (Number.isNaN(age) || age > (context.maxAge ?? QUALIFICATION_MAX_AGE_MILLISECONDS)) {
    reasons.push('staleEvidenceExpired');
    detail.push(`qualified ${basis.qualifiedAt}, older than ${Math.round((context.maxAge ?? QUALIFICATION_MAX_AGE_MILLISECONDS) / 86_400_000)} days`);
  }
  if (reasons.length === 0) {
    return { valid: true, reasons: ['qualificationStillValid'], detail: ['nothing that describes the route has moved'] };
  }
  return { valid: false, reasons, detail };
}

// MARK: - Turning what discovery already returns into observations

/** A hosted provider's discovery status, as observations. Prices come from a captured published list. */
export function observationsFromProviderStatus(status: ProviderStatus, prices: PublishedCataloguePrice[] = []): RouteObservation[] {
  return status.models.map((model) => {
    const price = prices.find((entry) => entry.provider === model.provider && entry.modelID === model.modelID);
    return {
      routeKey: `${model.provider}:${model.modelID}`,
      provider: model.provider,
      modelID: model.modelID,
      // IN A PROVIDER STATUS, `refused` IS EXACTLY "THE LISTING DID NOT NAME IT": discovery writes it for a
      // ladder identifier the listing omitted (Union Alpha), and writes nothing at all for one it named.
      // Decided from the structured field, never from the evidence sentence.
      listed: model.availability !== 'refused',
      availability: model.availability,
      ...(price === undefined ? {} : {
        priceFingerprint: priceFingerprintOf(price),
        publishedFree: price.inputMicroUSDPerMillionTokens === 0 && price.outputMicroUSDPerMillionTokens === 0,
      }),
      ...(status.version === undefined ? {} : { runtimeVersion: status.version }),
      observedAt: model.discoveredAt,
    };
  });
}

/** This machine's installed local models, as observations. The digest is the material property. */
export function observationsFromLocalModels(models: { modelID: string; runtimeDigest: string; contextLengthTokens?: number }[],
                                            observedAt: string, runtimeVersion?: string): RouteObservation[] {
  return models.map((model) => ({
    routeKey: `ollama:${model.modelID}`,
    provider: 'ollama' as ProviderID,
    modelID: model.modelID,
    listed: true,
    availability: 'installedLocally' as const,
    runtimeDigest: model.runtimeDigest,
    ...(model.contextLengthTokens === undefined ? {} : { contextWindowTokens: model.contextLengthTokens }),
    ...(runtimeVersion === undefined ? {} : { runtimeVersion }),
    observedAt,
  }));
}

// MARK: - The operation

/** One configured provider's probe. Injected: a test hands it a fixture, a surface hands it discovery. */
export type DiscoveryProbe = () => Promise<{ refreshed: boolean; detail: string; routes: RouteObservation[] }>;

/**
 * Refresh every configured provider and return the next snapshot and what changed.
 *
 * DETERMINISTIC GIVEN ITS INPUTS: the probes' answers, the previous snapshot and `now`. Probes run in
 * provider order, one at a time, so a slow provider cannot reorder the result.
 *
 *   A provider that answered replaces its routes with what it named, and every route it named BEFORE
 *   and did not name now is carried forward as `listed: false`, its last `observedAt` kept.
 *   A provider whose probe failed or threw carries every one of its previous routes forward
 *   UNTOUCHED, and its deltas say `notRefreshed` — never `disappeared`.
 */
export async function refreshDiscovery(options: {
  previous?: DiscoverySnapshot;
  probes: Partial<Record<ProviderID, DiscoveryProbe>>;
  machineKey: string;
  now: Date;
}): Promise<{ snapshot: DiscoverySnapshot; deltas: DiscoveryDelta[] }> {
  const takenAt = options.now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  if (options.previous !== undefined && options.previous.machineKey !== options.machineKey) {
    throw new Error(`the previous snapshot was taken on ${options.previous.machineKey}, not ${options.machineKey}. A local `
      + 'route observed on one machine says nothing about another, so snapshots are never diffed across machines.');
  }
  const providers: ProviderRefreshOutcome[] = [];
  const routes: RouteObservation[] = [];
  const previousRoutes = options.previous?.routes ?? [];
  const probed = Object.keys(options.probes).sort() as ProviderID[];

  for (const provider of probed) {
    let outcome: { refreshed: boolean; detail: string; routes: RouteObservation[] };
    try {
      outcome = await options.probes[provider]!();
    } catch (error) {
      outcome = { refreshed: false, detail: `the probe threw: ${error instanceof Error ? error.message : String(error)}`, routes: [] };
    }
    providers.push({ provider, refreshed: outcome.refreshed, detail: outcome.detail });
    const earlier = previousRoutes.filter((route) => route.provider === provider);
    if (!outcome.refreshed) { routes.push(...earlier); continue; }
    const named = new Set(outcome.routes.map((route) => route.routeKey));
    routes.push(...outcome.routes);
    for (const route of earlier) if (!named.has(route.routeKey)) routes.push({ ...route, listed: false });
  }
  // A provider not probed at all this time keeps its routes, and reports as not refreshed.
  for (const provider of [...new Set(previousRoutes.map((route) => route.provider))].sort()) {
    if (probed.includes(provider)) continue;
    providers.push({ provider, refreshed: false, detail: 'not probed on this refresh' });
    routes.push(...previousRoutes.filter((route) => route.provider === provider));
  }
  routes.sort((a, b) => (a.routeKey < b.routeKey ? -1 : a.routeKey > b.routeKey ? 1 : 0));
  providers.sort((a, b) => (a.provider < b.provider ? -1 : 1));
  const snapshot: DiscoverySnapshot = { schema: DISCOVERY_SNAPSHOT_SCHEMA, machineKey: options.machineKey, takenAt, providers, routes };
  return { snapshot, deltas: diffDiscoverySnapshots(options.previous, snapshot) };
}
