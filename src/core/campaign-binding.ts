// Model Lab core · Cernum REQ-03 Phase 6 — binding a campaign to a scoring policy generation.
//
// A campaign must say, before it runs, WHICH generation scored it, and must be refused if that
// generation is not exactly what the catalog can still produce. This module is the whole of that
// contract. It has one rule and no fallbacks: if anything does not resolve, or does not match what
// was bound, nothing runs.
//
// ── WHY BINDING CHANGES THE CASE DIGEST, AND WHY THAT IS CORRECT ────────────────────────────────
//
// A case declares its scoring policy as `id@version`, and `caseDigest` and `comparabilityKey` both
// include that version. Binding a suite to generation 2 therefore produces cases with different
// digests and different comparability keys from the generation-1 suite.
//
// That is not drift to be papered over — it is the honest answer. Two rows scored under different
// scoring policies are NOT directly comparable, and `comparability.ts` has always said so
// (`differentScoringPolicy`, `differentScoringPolicyDigest`). Binding makes the incomparability
// visible in the keys instead of leaving it to a reader to notice.
//
// ── WHAT THIS DOES NOT DO ──────────────────────────────────────────────────────────────────────
//
// It does not touch a stored row. Generation 1 remains registered, selectable and canonical, and an
// attempt already recorded still resolves to the policy version it was recorded with.

import { BenchmarkSuite, BenchmarkCase, caseDigest, comparabilityKey } from './benchmark';
import { ScoringPolicyCatalog, policyDigest } from './scoring-policy';
import { SCORING_POLICY_GENERATION_1, SCORING_POLICY_GENERATION_2, GENERATION_2_EXCLUDED_POLICY_IDS } from './capability-generation';

export class CampaignBindingFailure extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'CampaignBindingFailure';
  }
}

export interface BoundCase {
  caseID: string;
  suiteID: string;
  suiteVersion: string;
  scoringPolicyID: string;
  scoringPolicyVersion: string;
  scoringPolicyDigest: string;
  caseDigest: string;
  comparabilityKey: string;
}

export interface CampaignScoringBinding {
  bindingFormatVersion: 1;
  /** The generation this campaign is scored under. Explicit, never inferred from a default. */
  generation: string;
  /** The whole registry's digest at bind time. Any later registry change invalidates the binding. */
  catalogDigest: string;
  /** Every case, with the exact policy version and policy digest that will judge it. */
  cases: BoundCase[];
}

export const KNOWN_GENERATIONS: readonly string[] = [SCORING_POLICY_GENERATION_1, SCORING_POLICY_GENERATION_2];

/**
 * The policy version a case resolves to under a generation.
 *
 * Generation 1 is the case's own declared version, untouched. Generation 2 is the twin — except for
 * the ids that carry no twin, which stay at their declared version and are reported as such by
 * `bindSuiteToGeneration` rather than silently resolving to something else.
 */
function versionForGeneration(c: BenchmarkCase, generation: string): string {
  if (generation === SCORING_POLICY_GENERATION_1) return c.scoringPolicyVersion;
  if (GENERATION_2_EXCLUDED_POLICY_IDS.includes(c.scoringPolicyID)) return c.scoringPolicyVersion;
  return generation;
}

/** A copy of the suite whose cases declare the generation's policy version. Fails closed. */
export function bindSuiteToGeneration(suite: BenchmarkSuite, generation: string, catalog: ScoringPolicyCatalog): BenchmarkSuite {
  if (!KNOWN_GENERATIONS.includes(generation)) {
    throw new CampaignBindingFailure('unknownGeneration',
      `campaign requests scoring policy generation '${generation}'; this build knows only ${KNOWN_GENERATIONS.join(', ')}`);
  }
  const cases = suite.cases.map((c) => {
    const version = versionForGeneration(c, generation);
    const resolved = catalog.policy(c.scoringPolicyID, version);
    if (!resolved) {
      const registered = catalog.policies.filter((p) => p.id === c.scoringPolicyID).map((p) => p.version);
      throw new CampaignBindingFailure('scoringPolicyVersionUnavailable',
        `case ${c.id.raw} cannot be scored under generation ${generation}: `
        + `${c.scoringPolicyID}@${version} is not registered (registered version(s): ${registered.join(', ') || 'none'})`);
    }
    return version === c.scoringPolicyVersion ? c : { ...c, scoringPolicyVersion: version };
  });
  return { ...suite, cases };
}

/** The manifest fragment a campaign records: generation, catalog digest, and every case's policy digest. */
export function bindCampaignScoring(suites: readonly BenchmarkSuite[], generation: string,
                                    catalog: ScoringPolicyCatalog): CampaignScoringBinding {
  const cases: BoundCase[] = [];
  for (const suite of suites) {
    for (const c of bindSuiteToGeneration(suite, generation, catalog).cases) {
      const policy = catalog.policy(c.scoringPolicyID, c.scoringPolicyVersion)!;
      cases.push({
        caseID: c.id.raw, suiteID: c.suiteID.raw, suiteVersion: c.suiteVersion,
        scoringPolicyID: c.scoringPolicyID, scoringPolicyVersion: c.scoringPolicyVersion,
        scoringPolicyDigest: policyDigest(policy),
        caseDigest: caseDigest(c), comparabilityKey: comparabilityKey(c),
      });
    }
  }
  return { bindingFormatVersion: 1, generation, catalogDigest: catalog.catalogDigest(), cases };
}

/**
 * Re-check a recorded binding against the live catalog. Throws on the first mismatch.
 *
 * This is the fail-closed gate the ruling requires: a campaign whose bound policy version or digest is
 * unavailable or has moved does not run with a substitute, and does not run with a warning. It stops.
 */
export function verifyCampaignScoringBinding(binding: CampaignScoringBinding, catalog: ScoringPolicyCatalog): void {
  if (!KNOWN_GENERATIONS.includes(binding.generation)) {
    throw new CampaignBindingFailure('unknownGeneration',
      `the manifest binds scoring policy generation '${binding.generation}', which this build does not know`);
  }
  const liveCatalogDigest = catalog.catalogDigest();
  if (binding.catalogDigest !== liveCatalogDigest) {
    throw new CampaignBindingFailure('scoringPolicyCatalogDigestMismatch',
      `the manifest binds scoring policy catalog ${binding.catalogDigest}; this build registers ${liveCatalogDigest}. `
      + 'The registry changed after the campaign was bound — nothing was scored.');
  }
  for (const bound of binding.cases) {
    const policy = catalog.policy(bound.scoringPolicyID, bound.scoringPolicyVersion);
    if (!policy) {
      throw new CampaignBindingFailure('scoringPolicyVersionUnavailable',
        `the manifest binds case ${bound.caseID} to ${bound.scoringPolicyID}@${bound.scoringPolicyVersion}, which this build does not register`);
    }
    const live = policyDigest(policy);
    if (live !== bound.scoringPolicyDigest) {
      throw new CampaignBindingFailure('scoringPolicyDigestMismatch',
        `case ${bound.caseID} is bound to ${bound.scoringPolicyID}@${bound.scoringPolicyVersion} with digest `
        + `${bound.scoringPolicyDigest}, but this build seals that policy as ${live}. The policy changed under a fixed version — nothing was scored.`);
    }
  }
}
