// Benchmark engine · the requested cohort, declared where losing it is impossible rather than
// merely unlikely.
//
// WHY THIS FILE EXISTS. Pass 5B produced a combined candidate list that omitted two explicitly
// required models — `claude-opus-5` and `claude-fable-5-1`. Nothing failed. No refusal was recorded,
// no row said "absent", no test went red. The models were simply never asked for, and a list of what
// WAS tested is indistinguishable from a list of what was REQUESTED once the request is forgotten.
//
// A ladder alone cannot prevent that, because the ladder is the thing that gets edited. So the
// requested cohort is declared HERE, a second time, independently — and `reconcileCohort` compares
// the two. Dropping a model now requires deleting it from both places, which is no longer something
// that can happen by inattention.
//
// THIS FILE PROVES NOTHING ABOUT AVAILABILITY. It records what was ASKED FOR. Whether any of it can
// be invoked is a question only discovery and an identity smoke can answer, and every row it
// produces is born `unproven` exactly like every other.

import { EffortLevel, ProviderID } from './provider';
import { DESIRED_CANDIDATE_LADDER } from './discovery';

/** One requested configuration: a model at one effort. The unit the cohort is counted in. */
export interface RequestedConfiguration {
  provider: ProviderID;
  modelID: string;
  displayName: string;
  effort: EffortLevel;
}

/**
 * THE 12 CONFIGURATIONS THIS PROJECT REQUESTED, written out one per row.
 *
 * Not derived from the ladder — that is the entire point. The ladder groups efforts under a model;
 * this list names every configuration separately, because "Sonnet at high" and "Sonnet at max" are
 * two measurements and a cohort that lost one of them would still show Sonnet as present.
 */
export const REQUESTED_COHORT: RequestedConfiguration[] = [
  { provider: 'claudeCLI', modelID: 'claude-opus-5', displayName: 'Claude Opus 5', effort: 'none' },
  { provider: 'claudeCLI', modelID: 'claude-fable-5-1', displayName: 'Claude Fable 5.1', effort: 'high' },
  { provider: 'claudeCLI', modelID: 'claude-haiku-4-5', displayName: 'Claude Haiku 4.5', effort: 'none' },
  { provider: 'claudeCLI', modelID: 'claude-sonnet-5', displayName: 'Claude Sonnet 5', effort: 'high' },
  { provider: 'claudeCLI', modelID: 'claude-sonnet-5', displayName: 'Claude Sonnet 5', effort: 'max' },
  { provider: 'claudeCLI', modelID: 'claude-opus-4-8', displayName: 'Claude Opus 4.8', effort: 'none' },
  { provider: 'codexCLI', modelID: 'gpt-5.6-luna', displayName: 'GPT-5.6 Luna', effort: 'max' },
  { provider: 'codexCLI', modelID: 'gpt-5.6-terra', displayName: 'GPT-5.6 Terra', effort: 'medium' },
  { provider: 'codexCLI', modelID: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', effort: 'medium' },
  { provider: 'codexCLI', modelID: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', effort: 'max' },
  { provider: 'codexCLI', modelID: 'gpt-6-astra', displayName: 'GPT-6 Astra', effort: 'medium' },
  { provider: 'codexCLI', modelID: 'gpt-6-astra', displayName: 'GPT-6 Astra', effort: 'max' },
];

/**
 * Candidates authorised for Cernum V2, AFTER and SEPARATE FROM the frozen Pass 5C request.
 *
 * WHY THIS IS NOT APPENDED TO `REQUESTED_COHORT`. That list is the Pass 5C request as it was
 * approved, and the whole point of declaring it independently is that it can be compared against
 * what the ladder later became. Editing it to accommodate a new candidate would erase the very
 * baseline the comparison depends on -- and it would do it in the way that is hardest to notice,
 * by making the test go green.
 *
 * So a new candidate is declared here, under its own authority, and the ladder is reconciled against
 * BOTH lists. Nothing is missing, nothing is extra, and an entry that appears in the ladder without
 * appearing in either list is still reported as extra.
 *
 * UNION ALPHA IS NOT A MEMBER OF THE PASS 5C COHORT and must never be counted as one. It is reached
 * through a METERED API rather than a subscription CLI, nothing has benchmarked it, and no Cernum
 * campaign has ever run through OpenCode. Its presence here authorises Cernum to OFFER it; only
 * discovery can make it selectable, and only a person can put it in a campaign.
 */
export const CERNUM_V2_ADDITIONS: RequestedConfiguration[] = [
  { provider: 'opencodeCLI', modelID: 'opencode/union-alpha', displayName: 'Union Alpha', effort: 'none' },
];

/** Everything the ladder is allowed to contain: the frozen request, plus what was added since. */
export const AUTHORIZED_COHORT: RequestedConfiguration[] = [...REQUESTED_COHORT, ...CERNUM_V2_ADDITIONS];

/**
 * The two models Pass 5B lost, named explicitly.
 *
 * A test asserts these are in `REQUESTED_COHORT`, which is circular-looking and deliberate: it makes
 * the specific regression that already happened once impossible to reintroduce, independently of
 * whatever else the cohort grows or loses later.
 */
export const RECONCILED_IN_PASS_5C: string[] = ['claude-opus-5', 'claude-fable-5-1'];

/**
 * Models that must never be accepted as a stand-in for a required one.
 *
 * These are not errors anybody would make in the abstract. They are the errors that become
 * attractive at the exact moment a required model is unavailable and a cohort looks short.
 */
export const FORBIDDEN_SUBSTITUTIONS: { requested: string; notThis: string; because: string }[] = [
  {
    requested: 'claude-opus-5', notThis: 'claude-opus-4-8',
    because: 'a different model in the same family, not a build or alias of Opus 5',
  },
  {
    requested: 'claude-fable-5-1', notThis: 'claude-sonnet-5',
    because: 'a different model that shares only a version number; Fable is its own line',
  },
];

export function configurationKey(entry: { provider: ProviderID; modelID: string; effort: string }): string {
  return `${entry.provider}:${entry.modelID}:${entry.effort}`;
}

export interface CohortReconciliation {
  /** Requested, and absent from the ladder. Non-empty means the cohort has silently shrunk. */
  missingFromLadder: RequestedConfiguration[];
  /** In the ladder, and never requested. Recorded, not deleted — an extra is a question, not a fault. */
  extraInLadder: { provider: ProviderID; modelID: string; effort: string }[];
  /** Every requested configuration is present. */
  complete: boolean;
  requestedCount: number;
}

/** Expand the ladder into one row per configuration, so it can be compared like for like. */
export function ladderConfigurations(): { provider: ProviderID; modelID: string; effort: string }[] {
  return DESIRED_CANDIDATE_LADDER.flatMap((entry) =>
    entry.desiredEfforts.map((effort) => ({ provider: entry.provider, modelID: entry.modelID, effort })));
}

/** Compare what was requested against what the ladder plans to ask for. */
export function reconcileCohort(): CohortReconciliation {
  const ladder = new Set(ladderConfigurations().map(configurationKey));
  // MISSING is measured against the FROZEN Pass 5C request, because that is the list that must never
  // quietly shrink. EXTRA is measured against everything authorised since, because a ladder entry
  // nobody authorised is exactly as much of a defect as a requested one that vanished.
  const authorized = new Set(AUTHORIZED_COHORT.map(configurationKey));
  return {
    missingFromLadder: REQUESTED_COHORT.filter((entry) => !ladder.has(configurationKey(entry))),
    extraInLadder: ladderConfigurations().filter((entry) => !authorized.has(configurationKey(entry))),
    complete: REQUESTED_COHORT.every((entry) => ladder.has(configurationKey(entry))),
    requestedCount: REQUESTED_COHORT.length,
  };
}

/**
 * Refuse to proceed with a cohort that has lost a requested model.
 *
 * Called by the terminal before it prints an inventory and before a campaign is planned. It fails
 * LOUDLY and by name, because the failure it guards against is silence.
 */
export function assertCohortComplete(): void {
  const result = reconcileCohort();
  if (result.complete) return;
  const lost = result.missingFromLadder.map((entry) => `${entry.modelID} (${entry.effort})`).join(', ');
  throw new Error(
    `the requested cohort has lost ${result.missingFromLadder.length} of ${result.requestedCount} `
    + `configuration(s): ${lost}. These were explicitly requested and are no longer in the candidate `
    + 'ladder. Restore them, or record why they were withdrawn — do NOT substitute a neighbouring '
    + 'model for one of them.');
}

// MARK: - Historical identity evidence

/**
 * Identity evidence captured BEFORE this pass, preserved verbatim and never treated as proof of
 * current availability.
 *
 * WHY IT IS HERE AND WHY IT PROVES NOTHING TODAY. Both models were verified once, properly, with a
 * structured identity match. That history is why they belong in the plan, and it is the reason a
 * reader should not accept "we have no record of them" as grounds for dropping them. It is NOT a
 * substitute for a current smoke: a subscription tier can change, a lineup can change, and evidence
 * in this engine expires after 7 days by design. `availability` therefore stays `unproven` on the
 * strength of anything in this list.
 */
export interface HistoricalIdentityEvidence {
  modelID: string;
  displayName: string;
  capturedAt: string;
  /** What named the model. Structured stream fields only — never a model's prose about itself. */
  identitySource: string;
  verdict: 'verifiedMatch';
  detail: string;
  evidencePath: string;
  /** Why this cannot stand in for a current proof. */
  notCurrentProofBecause: string;
}

export const HISTORICAL_IDENTITY_EVIDENCE: HistoricalIdentityEvidence[] = [
  {
    modelID: 'claude-opus-5',
    displayName: 'Claude Opus 5',
    capturedAt: '2026-08-19',
    identitySource: 'adapter:claude-cli:live structured identity field, across 108 stored attempts',
    verdict: 'verifiedMatch',
    detail:
      '108 attempts ran through the live Claude CLI adapter with identity recorded as verifiedMatch. '
      + 'The attempts themselves are NOT reusable as benchmark rows — they ran suite v2 against a '
      + 'scoring policy the v3 manifest replaced — but the identity observation is independent of the '
      + 'suite that was being scored, and it is that observation, not the scores, which is preserved here.',
    evidencePath: 'model-lab-results/MODEL-LAB-DIAGNOSTIC-AND-FRONTIER-HANDOFF-01.md §6.1',
    notCurrentProofBecause:
      'captured 2026-08-19, far beyond the 7-day evidence expiry this engine enforces, and against a '
      + 'CLI build and subscription state that have both moved since.',
  },
  {
    modelID: 'claude-fable-5-1',
    displayName: 'Claude Fable 5.1',
    capturedAt: '2026-09-02',
    identitySource: 'adapter:claude-cli:live structured stream self-name (NOT the prose answer)',
    verdict: 'verifiedMatch',
    detail:
      'One authorized probe, CLI 2.1.251, effort low, 64-token ceiling, tools and MCP disabled, empty '
      + 'work directory, no session persistence. The structured stream named `claude-fable-5-1` and it '
      + 'matched the request. Worth carrying forward precisely: the model\'s PROSE said "This is Claude '
      + 'Fable 5, built by Anthropic", dropping the .1 — so a reader keying on prose would have recorded '
      + 'an identity mismatch on a correct answer. The structured field is the identity; prose never is.',
    evidencePath: 'model-lab-results/campaigns/diagnostic-macmini81-20260902T185032Z-prewarm/evidence/frontier-probe-fable-5-1.txt',
    notCurrentProofBecause:
      'captured 2026-09-02 at effort `low`, beyond the 7-day expiry, and the cohort requests `high`; '
      + 'an effort level is not verifiable on the Claude CLI in any case.',
  },
];

export function historicalEvidenceFor(modelID: string): HistoricalIdentityEvidence | undefined {
  return HISTORICAL_IDENTITY_EVIDENCE.find((entry) => entry.modelID === modelID);
}
