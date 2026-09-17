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
import {
  OPENCODE_LISTING_IS_A_CATALOGUE, OPENCODE_PROOF_PATH, OPENCODE_SUPERSEDED_NO_PROOF_PATH_FRAGMENT,
} from './opencode-cli';
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

export function readDiscoveryStore(root: string, now = new Date()): DiscoveryEvidence {
  const file = discoveryStorePath(root);
  if (!fs.existsSync(file)) return { writtenAt: '', models: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<DiscoveryEvidence>;
    // CORRECTED ON THE WAY OUT, so every surface reads the same corrected text and no caller has to
    // remember to ask. The original is preserved on the row; the next write persists both.
    const { models } = supersedeStaleOpenCodeEvidence(Array.isArray(parsed.models) ? parsed.models : [], now);
    return {
      writtenAt: typeof parsed.writtenAt === 'string' ? parsed.writtenAt : '',
      models,
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

/**
 * THE RELEASE THAT ESTABLISHED THE CORRECTION. Written onto every row it touches, so a reader can
 * tell a row that was never wrong from one that was fixed, and by what.
 */
export const OPENCODE_EVIDENCE_CORRECTION_RELEASE = 'v0.2.4';

export const OPENCODE_EVIDENCE_CORRECTION_NOTE =
  // DELIBERATELY DOES NOT QUOTE THE SUPERSEDED SENTENCE. The matcher above looks for that exact
  // fragment, and a correction note containing it would be a row that looks contaminated forever —
  // caught today only by the `supersededEvidence` guard, which is one guard too few for a string that
  // could be re-derived by any later code path. The old text is preserved on the row, where a reader
  // who wants it can read it and no matcher trips over it.
  'SUPERSEDED BY ' + OPENCODE_EVIDENCE_CORRECTION_RELEASE + '. The evidence this row was written with said Cernum had '
  + 'no way to execute an OpenCode request and therefore no way to prove an OpenCode model. That was true when it was written '
  + 'and stopped being true in v0.2.3, when the adapter shipped; the sentence was left behind and kept being written '
  + 'into this store afterwards. The original text is preserved verbatim in `supersededEvidence` — a record that was '
  + 'wrong is still a record — and the corrected statement of what does and does not prove an OpenCode model follows. '
  + 'THE AVAILABILITY OF THIS ROW IS UNCHANGED: correcting a sentence proves nothing, and nothing here promotes a '
  + 'model. Re-run discovery, or an authorized smoke, to establish the current position.';

/**
 * Correct OpenCode rows whose evidence carries the superseded v0.2.2 sentence.
 *
 * FOUR THINGS IT DELIBERATELY DOES NOT DO.
 *
 *   It does not delete a row. The contaminated records are evidence of what this tool said and when,
 *   and deleting them would make the store agree with the current build retroactively.
 *   It does not change `availability`. A wrong sentence about the proof PATH says nothing about
 *   whether this credential can call this model, so correcting it promotes nothing.
 *   It does not change `discoveredAt`. The row still describes the moment it was written; a
 *   correction is not a re-observation, and backdating freshness through an edit would be worse than
 *   the sentence it fixed.
 *   It does not touch a row it has already corrected, so reading the store a hundred times produces
 *   one correction rather than a hundred nested ones.
 */
export function supersedeStaleOpenCodeEvidence(models: DiscoveredFrontierModel[], now = new Date()):
  { models: DiscoveredFrontierModel[]; supersededCount: number } {
  const correctedAt = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  let supersededCount = 0;
  const corrected = models.map((model) => {
    if (model.provider !== 'opencodeCLI') return model;
    if (model.supersededEvidence !== undefined) return model;
    if (!model.evidence.includes(OPENCODE_SUPERSEDED_NO_PROOF_PATH_FRAGMENT)) return model;
    supersededCount += 1;
    return {
      ...model,
      supersededEvidence: model.evidence,
      evidenceCorrectedAt: correctedAt,
      evidenceCorrectedBy: OPENCODE_EVIDENCE_CORRECTION_RELEASE,
      evidence: `${OPENCODE_EVIDENCE_CORRECTION_NOTE} ${OPENCODE_LISTING_IS_A_CATALOGUE} ${OPENCODE_PROOF_PATH}`,
    };
  });
  return { models: corrected, supersededCount };
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
        : `identity smoke test at ${result.attemptedAt} (effort ${result.effort}, ${result.billingBasis}, `
          + `identity state ${result.identityState}): ${result.evidence}`
          // A metered proof COST SOMETHING, and the row says so beside the proof rather than leaving a
          // later reader to discover from a bill that the evidence was not free to obtain.
          + (result.billingBasis === 'meteredAPI'
            ? ` This request was billed per token against your own credential; its charge is `
              + `${result.marginalAPIChargeMicroUSD.provenance === 'unavailable'
                ? 'UNAVAILABLE — not zero' : `$${((result.marginalAPIChargeMicroUSD.value ?? 0) / 1_000_000).toFixed(6)} `
                  + `(${result.marginalAPIChargeMicroUSD.provenance})`}.`
            : ''),
      verifiedModelID: result.verdict === 'proven' ? result.reportedModelID : (keepExisting ? existing.verifiedModelID : ''),
      desiredEfforts: [...efforts].sort(),
      discoveredAt: result.attemptedAt,
    });
  }
  return [...byModel.values()].sort((a, b) => (a.modelID < b.modelID ? -1 : a.modelID > b.modelID ? 1 : 0));
}
