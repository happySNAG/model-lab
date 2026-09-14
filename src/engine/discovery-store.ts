// Benchmark engine · what discovery established, written down with WHEN, and allowed to go stale.
//
// A CAMPAIGN MUST DEPEND ON EVIDENCE, NOT ON A LIST IN THE SOURCE. Nothing in this repository says
// which models this account can call. Saying so in code would be a claim nobody checked, it would be
// wrong the week a provider changed its lineup, and it would be wrong in a different way for the
// next person, whose subscription is not this one. So the answer lives in a FILE that discovery
// writes and a campaign reads, and every row in it carries what established it and when.
//
// EVIDENCE EXPIRES, BECAUSE THE THING IT DESCRIBES CHANGES. A proof that an account could call a
// model is a proof about a moment: plans get downgraded, models get retired, a CLI updates itself
// overnight. Evidence older than the window below is not deleted and is not quietly ignored — it is
// reported as EXPIRED, with its age, and a campaign that wants to use it has to have it re-proved.
// The alternative is a benchmark that fails halfway through because a candidate proved six months
// ago no longer exists, having already spent the allowance getting there.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { DiscoveredFrontierModel } from './discovery';
import { IdentitySmokeResult } from './identity-smoke';
import { ProviderID } from './provider';

/**
 * How long a proof is good for.
 *
 * Seven days is chosen against how fast the thing being proved actually moves: a subscription CLI
 * updates itself on roughly a weekly cadence, and a model lineup changes on no cadence at all. A
 * longer window would let a campaign plan around a model that has since been retired; a much shorter
 * one would make an identity smoke a routine cost rather than an occasional one.
 */
export const DISCOVERY_EVIDENCE_MAX_AGE_MILLISECONDS = 7 * 24 * 60 * 60 * 1_000;

export interface DiscoveryEvidence {
  writtenAt: string;
  models: DiscoveredFrontierModel[];
}

export function discoveryStorePath(root: string): string {
  return path.join(root, '.providers', 'discovered.json');
}

export function readDiscoveryStore(root: string): DiscoveryEvidence {
  const file = discoveryStorePath(root);
  if (!fs.existsSync(file)) return { writtenAt: '', models: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<DiscoveryEvidence>;
    return {
      writtenAt: typeof parsed.writtenAt === 'string' ? parsed.writtenAt : '',
      models: Array.isArray(parsed.models) ? parsed.models : [],
    };
  } catch {
    // A store that does not parse establishes NOTHING. Returning an empty one makes every candidate
    // unproven again, which is the safe direction: the failure mode is an extra smoke test, not a
    // campaign built on half a file.
    return { writtenAt: '', models: [] };
  }
}

export function writeDiscoveryStore(root: string, models: DiscoveredFrontierModel[], at = new Date()): void {
  const file = discoveryStorePath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const evidence: DiscoveryEvidence = { writtenAt: at.toISOString(), models };
  fs.writeFileSync(file, JSON.stringify(evidence, null, 2) + '\n', 'utf8');
}

/** How old one row's evidence is, in milliseconds, or undefined when it carries no usable timestamp. */
export function evidenceAgeMilliseconds(model: DiscoveredFrontierModel, now: Date): number | undefined {
  const at = Date.parse(model.discoveredAt);
  if (Number.isNaN(at)) return undefined;
  return now.getTime() - at;
}

export function isEvidenceExpired(model: DiscoveredFrontierModel, now: Date,
                                  maxAge = DISCOVERY_EVIDENCE_MAX_AGE_MILLISECONDS): boolean {
  const age = evidenceAgeMilliseconds(model, now);
  // A row with no readable timestamp cannot be shown to be fresh, and "cannot be shown to be fresh"
  // is treated as expired rather than as fine.
  return age === undefined || age > maxAge;
}

/**
 * The models a campaign may actually select, and the ones whose proof has gone stale.
 *
 * `proven` is necessary and not sufficient: an expired proof is reported separately rather than
 * being silently downgraded, so a person is told their evidence aged out instead of wondering where
 * a candidate went.
 */
export function selectableFromStore(evidence: DiscoveryEvidence, now = new Date(),
                                    maxAge = DISCOVERY_EVIDENCE_MAX_AGE_MILLISECONDS):
  { selectable: DiscoveredFrontierModel[]; expired: DiscoveredFrontierModel[] } {
  const proven = evidence.models.filter((model) => model.availability === 'proven');
  return {
    selectable: proven.filter((model) => !isEvidenceExpired(model, now, maxAge)),
    expired: proven.filter((model) => isEvidenceExpired(model, now, maxAge)),
  };
}

/** The sentence shown about an expired proof. One wording, so no surface softens it. */
export function describeExpiry(model: DiscoveredFrontierModel, now = new Date()): string {
  const age = evidenceAgeMilliseconds(model, now);
  const days = age === undefined ? undefined : Math.floor(age / (24 * 60 * 60 * 1_000));
  return `${model.modelID}: the proof that this account can call it is `
    + `${days === undefined ? 'undated' : `${days} day(s) old`} and has expired. It is not selectable until an `
    + 'identity smoke test proves it again — a lineup can change, and a stale proof spends a campaign\'s allowance '
    + 'discovering that it has.';
}

/**
 * Turn identity-smoke verdicts into store rows.
 *
 * `substituted` becomes `refused`, not `proven`. Something answered, so the request "worked" in the
 * sense that bytes came back — but the identifier the campaign would freeze is not the identifier
 * that answers to it, and a candidate selected on that basis would produce results attributed to the
 * wrong model. `unverifiable` stays `unproven`: nothing was established either way.
 */
export function modelsFromSmokes(results: IdentitySmokeResult[],
                                 displayNames: Map<string, string> = new Map()): DiscoveredFrontierModel[] {
  const byModel = new Map<string, DiscoveredFrontierModel>();
  for (const result of results) {
    const availability = result.verdict === 'proven' ? 'proven' as const
      : result.verdict === 'unverifiable' ? 'unproven' as const
        : 'refused' as const;
    const key = `${result.provider}:${result.requestedModelID}`;
    const existing = byModel.get(key);
    const efforts = new Set(existing?.desiredEfforts ?? []);
    efforts.add(result.effort);

    // Several efforts of one model share a row. A model proven at one effort and refused at another
    // is recorded as REFUSED, because the pessimistic reading is the one that cannot mislead a
    // campaign into freezing a level the account cannot actually use.
    const keepExisting = existing !== undefined && existing.availability !== 'proven' && availability === 'proven';
    byModel.set(key, {
      provider: result.provider as ProviderID,
      modelID: result.requestedModelID,
      displayName: displayNames.get(result.requestedModelID) ?? result.requestedModelID,
      availability: keepExisting ? existing.availability : availability,
      evidence: keepExisting ? existing.evidence
        : `identity smoke test at ${result.attemptedAt} (effort ${result.effort}): ${result.evidence}`,
      verifiedModelID: result.verdict === 'proven' ? result.reportedModelID : (keepExisting ? existing.verifiedModelID : ''),
      desiredEfforts: [...efforts].sort(),
      discoveredAt: result.attemptedAt,
    });
  }
  return [...byModel.values()].sort((a, b) => (a.modelID < b.modelID ? -1 : a.modelID > b.modelID ? 1 : 0));
}
