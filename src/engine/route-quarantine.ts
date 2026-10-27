// Benchmark engine · SUBSTITUTION QUARANTINE (rule csq1): a route whose served model was recorded as not the
// model requested is held out of every routing answer until a person releases it, on the record.
//
// WHAT PUTS A ROUTE IN QUARANTINE. Two recorded findings, and nothing else:
//
//   smokeSubstituted     an identity smoke (identity-smoke.ts) returned the verdict `substituted`: the provider
//                        named a model, and it was a different one.
//   outcomeSubstituted   an Ordra outcome ingested by `ingest-outcomes` (cro1) carries a `substitution` finding:
//                        the session's reported model usage names a model other than the one Ordra requested.
//
// A model name is never read for anything here. The route is the REQUESTED `provider:model`, exactly as the
// smoke binding or the outcome named it; whether two spellings are "the same model" is not decided.
//
// THE RULES, EACH ENFORCED HERE.
//
//   SEALED AND APPEND-ONLY. An entry and a release are each one `routeQuarantine` or `routeQuarantineRelease`
//   observation in the observation store, content-addressed like every other record. Nothing is edited or removed.
//   EVIDENCE TRAVELS WITH THE ENTRY. Every entry names its cause and references the evidence it came from: the
//   outcome's own recordID, or the digest of the smoke result, with the requested and the reported model.
//   IDEMPOTENT. An entry's time is the moment the evidence was observed, not the moment it was written, so the
//   same finding seals to the same record however many times it is recorded. An outcome-derived entry carries the
//   machine that observed the outcome, so two machines deriving it from the same record write one entry.
//   FLEET-WIDE AND EFFORT-WIDE. A substitution is a fact about what a provider served for an identifier, not about
//   one machine or one effort level, so an entry holds the route on every machine and at every effort key.
//   RELEASED ONLY ON THE RECORD. `cernum quarantine release <route> --reason <text>` appends a release naming every
//   entry it releases and why. A later substitution is a new entry the release did not name, and quarantines the
//   route again. Nothing in this module ever releases a route on its own.
//   AN EXCLUSION, NEVER A VERDICT. A quarantine adds the reason `quarantined: …` to the route's exclusion in the
//   candidate set (crc2), and through it in recommend (crr1, crr2) and the fallback chain (cfc1). The route's
//   qualification record, its capabilities and the qualification timeline are not touched: entries carry no
//   record-level `routeKey`, which is the field those readers select on.

import { CanonicalValue, compareCodePoints, digestObject } from './canonical';
import type { IdentitySmokeResult } from './identity-smoke';
import {
  ObservationRecord, ObservationStoreContents, StoredObservation, appendObservations, sealObservation,
} from './observation-store';
import { PROVIDER_IDS, ProviderID } from './provider';
import { routeOutcomesFrom } from './route-outcome-ingest';

export const ROUTE_QUARANTINE_RULE = 'csq1';

/** The exclusion-reason prefix a quarantined route carries in every candidate set, ranking and chain. */
export const ROUTE_QUARANTINE_EXCLUSION_KIND = 'quarantined';

export const ROUTE_QUARANTINE_DISCLOSURE =
  'A route enters substitution quarantine when an identity smoke recorded `substituted` or an ingested Ordra outcome '
  + 'recorded a substitution finding. While quarantined it is excluded from candidates, recommend and the fallback chain '
  + 'with the reason `quarantined`, on every machine and at every effort. Its qualification record is unchanged. It '
  + 'leaves quarantine only through `cernum quarantine release <route> --reason <text>`, which appends a release record; '
  + 'nothing is ever deleted, and a later substitution quarantines it again.';

export type RouteQuarantineCause = 'smokeSubstituted' | 'outcomeSubstituted';

/** One piece of evidence an entry rests on. `reference` is enough to find it again. */
export interface RouteQuarantineEvidence {
  kind: 'identitySmoke' | 'routeOutcome';
  /** `routeOutcome:<recordID>` for an ingested outcome, `identitySmoke:<sha256>` for a smoke result. */
  reference: string;
  requestedModel: string;
  /** What the provider or the session said answered. */
  actualModel: string;
  observedAt: string;
  /** In words: where the finding came from. */
  detail: string;
  /** The Ordra pass and attempt, for an outcome. */
  pass?: string;
  attempt?: number;
}

/** The body of a `routeQuarantine` observation. */
export interface RouteQuarantineEntry {
  rule: typeof ROUTE_QUARANTINE_RULE;
  routeKey: string;
  provider: ProviderID;
  cause: RouteQuarantineCause;
  evidence: RouteQuarantineEvidence[];
  /** When the evidence was observed. The observation's `observedAt`. */
  quarantinedAt: string;
}

/** The body of a `routeQuarantineRelease` observation. */
export interface RouteQuarantineRelease {
  rule: typeof ROUTE_QUARANTINE_RULE;
  routeKey: string;
  reason: string;
  releasedAt: string;
  /** The recordID of every entry this release releases: exactly those in force when it was made. */
  releases: string[];
}

export class RouteQuarantineError extends Error {
  constructor(readonly code: 'invalidRoute' | 'reasonMissing' | 'notQuarantined', message: string) {
    super(message);
    this.name = 'RouteQuarantineError';
  }
}

// MARK: - Route keys

/** `provider:model`, with a provider this build knows and a non-empty model. Never inferred from a model name. */
export function parseQuarantineRouteKey(routeKey: string): { provider: ProviderID; modelID: string } | undefined {
  const index = routeKey.indexOf(':');
  if (index <= 0) return undefined;
  const provider = routeKey.slice(0, index);
  const modelID = routeKey.slice(index + 1);
  if (!PROVIDER_IDS.includes(provider as ProviderID) || modelID.trim().length === 0 || modelID.includes('@')) return undefined;
  return { provider: provider as ProviderID, modelID };
}

// MARK: - Sealing

/** An entry as a sealed observation. No record-level `routeKey`, on purpose: see the file comment. */
export function routeQuarantineObservation(entry: RouteQuarantineEntry, machineKey: string, machineLabel: string): ObservationRecord {
  return sealObservation({
    kind: 'routeQuarantine', machineKey, machineLabel, observedAt: entry.quarantinedAt,
    provenance: `a recorded identity substitution (${entry.cause}) that put ${entry.routeKey} in substitution quarantine `
      + `under rule ${ROUTE_QUARANTINE_RULE}`,
    provider: entry.provider,
    body: entry as unknown as CanonicalValue,
  });
}

export function routeQuarantineReleaseObservation(release: RouteQuarantineRelease, provider: ProviderID, machineKey: string,
                                                  machineLabel: string): ObservationRecord {
  return sealObservation({
    kind: 'routeQuarantineRelease', machineKey, machineLabel, observedAt: release.releasedAt,
    provenance: `cernum quarantine release ${release.routeKey}, run by a person with a stated reason, under rule ${ROUTE_QUARANTINE_RULE}`,
    provider,
    body: release as unknown as CanonicalValue,
  });
}

// MARK: - From the findings

/** The quarantine entry an identity smoke calls for: one when its verdict is `substituted`, none otherwise. */
export function smokeSubstitutionQuarantine(result: IdentitySmokeResult): RouteQuarantineEntry | undefined {
  if (result.verdict !== 'substituted') return undefined;
  const provider = result.provider as ProviderID;
  if (!PROVIDER_IDS.includes(provider)) return undefined;
  // THE SMOKE IS REFERENCED BY ITS DIGEST, over the fields that decided the verdict. A smoke result is not an
  // observation-store record, so this is how the entry points back at the evidence file it was written to.
  const digest = digestObject({
    provider: result.provider, candidate: result.candidate, requestedModelID: result.requestedModelID,
    reportedModelID: result.reportedModelID, participatingModelIDs: result.participatingModelIDs, effort: result.effort,
    verdict: result.verdict, evidence: result.evidence, attemptedAt: result.attemptedAt,
  });
  return {
    rule: ROUTE_QUARANTINE_RULE,
    routeKey: `${provider}:${result.requestedModelID}`,
    provider,
    cause: 'smokeSubstituted',
    evidence: [{
      kind: 'identitySmoke', reference: `identitySmoke:${digest}`,
      requestedModel: result.requestedModelID, actualModel: result.reportedModelID, observedAt: result.attemptedAt,
      detail: `identity smoke at effort ${result.effort}: ${result.evidence}`,
    }],
    quarantinedAt: result.attemptedAt,
  };
}

/** One quarantine entry per ingested outcome that carries a substitution finding, with that outcome's observer. */
export function outcomeSubstitutionQuarantines(contents: ObservationStoreContents):
  { entry: RouteQuarantineEntry; machineKey: string; machineLabel: string }[] {
  return routeOutcomesFrom(contents).flatMap(({ stored, outcome }) => outcome.findings
    .filter((finding) => finding.kind === 'substitution')
    .map((finding) => ({
      machineKey: stored.record.machineKey,
      machineLabel: stored.record.machineLabel,
      entry: {
        rule: ROUTE_QUARANTINE_RULE,
        routeKey: outcome.routeKey,
        provider: outcome.provider,
        cause: 'outcomeSubstituted' as const,
        evidence: [{
          kind: 'routeOutcome' as const, reference: `routeOutcome:${stored.record.recordID}`,
          requestedModel: finding.requestedModel, actualModel: finding.actualModel, observedAt: outcome.recordedAt,
          detail: `ingested Ordra outcome: pass ${outcome.pass} attempt ${outcome.attempt} requested ${finding.requestedModel} `
            + `and the session reported ${finding.actualModel}`,
          pass: outcome.pass, attempt: outcome.attempt,
        }],
        quarantinedAt: outcome.recordedAt,
      },
    })));
}

// MARK: - Recording

export interface RouteQuarantineRecorded {
  recordID: string;
  routeKey: string;
  cause: RouteQuarantineCause;
  evidence: string[];
  /** False when the store already held this exact entry. */
  written: boolean;
}

function append(root: string, record: ObservationRecord, receivedAt: string): boolean {
  const result = appendObservations(root, [record], { origin: 'observedHere', receivedAt });
  if (result.refused.length > 0) throw new Error(`a quarantine record was refused by the store: ${result.refused[0]!.reason}`);
  return result.written.length === 1;
}

function recorded(record: ObservationRecord, entry: RouteQuarantineEntry, written: boolean): RouteQuarantineRecorded {
  return { recordID: record.recordID, routeKey: entry.routeKey, cause: entry.cause,
    evidence: entry.evidence.map((item) => item.reference), written };
}

/** Seal an entry for every `substituted` smoke among `results`. Every other verdict writes nothing. */
export function recordSmokeSubstitutionQuarantines(root: string, results: IdentitySmokeResult[], options: {
  machineKey: string; machineLabel: string; receivedAt: string;
}): RouteQuarantineRecorded[] {
  const out: RouteQuarantineRecorded[] = [];
  for (const result of results) {
    const entry = smokeSubstitutionQuarantine(result);
    if (entry === undefined) continue;
    const record = routeQuarantineObservation(entry, options.machineKey, options.machineLabel);
    out.push(recorded(record, entry, append(root, record, options.receivedAt)));
  }
  return out;
}

/**
 * Seal an entry for every substituted outcome in the store that has none yet.
 *
 * Reads the whole store rather than one ingest's result, so an outcome ingested before quarantine existed, or
 * imported from another machine, is quarantined too: a substitution finding is never left without its entry.
 */
export function recordOutcomeSubstitutionQuarantines(root: string, contents: ObservationStoreContents, options: {
  receivedAt: string;
}): RouteQuarantineRecorded[] {
  return outcomeSubstitutionQuarantines(contents).map(({ entry, machineKey, machineLabel }) => {
    const record = routeQuarantineObservation(entry, machineKey, machineLabel);
    return recorded(record, entry, append(root, record, options.receivedAt));
  });
}

// MARK: - Reading the store back

export function routeQuarantineEntriesFrom(contents: ObservationStoreContents): { stored: StoredObservation; entry: RouteQuarantineEntry }[] {
  return contents.observations.filter((stored) => stored.record.kind === 'routeQuarantine')
    .map((stored) => ({ stored, entry: stored.record.body as unknown as RouteQuarantineEntry }));
}

export function routeQuarantineReleasesFrom(contents: ObservationStoreContents): { stored: StoredObservation; release: RouteQuarantineRelease }[] {
  return contents.observations.filter((stored) => stored.record.kind === 'routeQuarantineRelease')
    .map((stored) => ({ stored, release: stored.record.body as unknown as RouteQuarantineRelease }));
}

export interface RouteQuarantineEntryView {
  recordID: string;
  machineKey: string;
  cause: RouteQuarantineCause;
  quarantinedAt: string;
  evidence: RouteQuarantineEvidence[];
  /** The release that released this entry, or null while it is in force. */
  releasedBy: { recordID: string; releasedAt: string; reason: string } | null;
}

export interface RouteQuarantineState {
  rule: typeof ROUTE_QUARANTINE_RULE;
  routeKey: string;
  state: 'quarantined' | 'released' | 'clear';
  /** Entries in force: those no release has named. */
  active: RouteQuarantineEntryView[];
  /** Every entry, oldest first, released ones included. */
  entries: RouteQuarantineEntryView[];
  releases: { recordID: string; machineKey: string; releasedAt: string; reason: string; releases: string[] }[];
  /** The `quarantined: …` exclusion reason, present exactly while `state` is `quarantined`. */
  reason?: string;
}

const byTimeThenID = (a: { at: string; id: string }, b: { at: string; id: string }): number =>
  compareCodePoints(a.at, b.at) || compareCodePoints(a.id, b.id);

/** One route's quarantine state, derived from the store. Pure: reads nothing else, writes nothing. */
export function routeQuarantineStatus(contents: ObservationStoreContents, routeKey: string): RouteQuarantineState {
  const releases = routeQuarantineReleasesFrom(contents).filter(({ release }) => release.routeKey === routeKey)
    .map(({ stored, release }) => ({ recordID: stored.record.recordID, machineKey: stored.record.machineKey,
      releasedAt: release.releasedAt, reason: release.reason, releases: [...release.releases] }))
    .sort((a, b) => byTimeThenID({ at: a.releasedAt, id: a.recordID }, { at: b.releasedAt, id: b.recordID }));
  const entries: RouteQuarantineEntryView[] = routeQuarantineEntriesFrom(contents).filter(({ entry }) => entry.routeKey === routeKey)
    .map(({ stored, entry }) => {
      const release = releases.find((candidate) => candidate.releases.includes(stored.record.recordID));
      return { recordID: stored.record.recordID, machineKey: stored.record.machineKey, cause: entry.cause,
        quarantinedAt: entry.quarantinedAt, evidence: entry.evidence,
        releasedBy: release === undefined ? null : { recordID: release.recordID, releasedAt: release.releasedAt, reason: release.reason } };
    })
    .sort((a, b) => byTimeThenID({ at: a.quarantinedAt, id: a.recordID }, { at: b.quarantinedAt, id: b.recordID }));
  const active = entries.filter((entry) => entry.releasedBy === null);
  const state: RouteQuarantineState['state'] = active.length > 0 ? 'quarantined' : entries.length > 0 ? 'released' : 'clear';
  return {
    rule: ROUTE_QUARANTINE_RULE, routeKey, state, active, entries, releases,
    ...(state === 'quarantined' ? { reason: quarantineExclusionReason(routeKey, active) } : {}),
  };
}

/** The exclusion reason, in the `kind: detail` form every other crc2 exclusion reason takes. */
export function quarantineExclusionReason(routeKey: string, active: RouteQuarantineEntryView[]): string {
  const evidence = active.flatMap((entry) => entry.evidence.map((item) =>
    `${entry.cause} ${item.reference} (requested ${item.requestedModel}, answered ${item.actualModel}, ${item.observedAt})`));
  return `${ROUTE_QUARANTINE_EXCLUSION_KIND}: ${routeKey} is in substitution quarantine (rule ${ROUTE_QUARANTINE_RULE}) since `
    + `${active[0]!.quarantinedAt} on ${active.length} recorded substitution(s): ${evidence.join('; ')}. It leaves quarantine only `
    + `through cernum quarantine release ${routeKey} --reason <text>.`;
}

export interface RouteQuarantineList {
  schema: typeof ROUTE_QUARANTINE_RULE;
  /** Every route that has ever had an entry, by route key. */
  routes: RouteQuarantineState[];
  quarantined: string[];
  disclosure: string;
}

/** Every route with any entry, its state, and every entry and release. Pure. */
export function listRouteQuarantine(contents: ObservationStoreContents): RouteQuarantineList {
  const keys = [...new Set([
    ...routeQuarantineEntriesFrom(contents).map(({ entry }) => entry.routeKey),
    ...routeQuarantineReleasesFrom(contents).map(({ release }) => release.routeKey),
  ])].sort(compareCodePoints);
  const routes = keys.map((routeKey) => routeQuarantineStatus(contents, routeKey));
  return {
    schema: ROUTE_QUARANTINE_RULE, routes,
    quarantined: routes.filter((route) => route.state === 'quarantined').map((route) => route.routeKey),
    disclosure: ROUTE_QUARANTINE_DISCLOSURE,
  };
}

// MARK: - Release

export interface RouteQuarantineReleaseResult {
  recordID: string;
  routeKey: string;
  reason: string;
  releasedAt: string;
  releases: string[];
  state: RouteQuarantineState;
}

/**
 * Append a release of every entry in force on `routeKey`, with the person's reason.
 *
 * REFUSED, WRITING NOTHING, when the route key cannot be read, when no reason is given, or when the route has no
 * entry in force: a release of nothing would be a record that something was decided when nothing was.
 */
export function recordRouteQuarantineRelease(root: string, contents: ObservationStoreContents, routeKey: string, reason: string,
                                             options: { machineKey: string; machineLabel: string; now: Date }): RouteQuarantineReleaseResult {
  const parsed = parseQuarantineRouteKey(routeKey);
  if (parsed === undefined) {
    throw new RouteQuarantineError('invalidRoute', `'${routeKey}' is not a route key: write provider:model with a provider of `
      + `${PROVIDER_IDS.join(', ')} and no effort suffix. Nothing was released.`);
  }
  if (reason.trim().length === 0) {
    throw new RouteQuarantineError('reasonMissing', 'a release needs --reason <text>: why this route may be routed again. Nothing was released.');
  }
  const before = routeQuarantineStatus(contents, routeKey);
  if (before.state !== 'quarantined') {
    throw new RouteQuarantineError('notQuarantined', `${routeKey} has no quarantine entry in force (${before.state}), so there is `
      + 'nothing to release. Nothing was written.');
  }
  const release: RouteQuarantineRelease = {
    rule: ROUTE_QUARANTINE_RULE, routeKey, reason: reason.trim(), releasedAt: options.now.toISOString(),
    releases: before.active.map((entry) => entry.recordID).sort(compareCodePoints),
  };
  const record = routeQuarantineReleaseObservation(release, parsed.provider, options.machineKey, options.machineLabel);
  append(root, record, release.releasedAt);
  const after = routeQuarantineStatus({ ...contents, observations: [...contents.observations,
    { record, origin: 'observedHere', receivedAt: release.releasedAt }] }, routeKey);
  return { recordID: record.recordID, routeKey, reason: release.reason, releasedAt: release.releasedAt, releases: release.releases, state: after };
}
