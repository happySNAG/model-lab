// Benchmark engine · the difficulty claim this repository makes about each workspace case.
//
// ONE PROFILE PER CASE, AND EVERY NUMBER ANSWERABLE. `workspace-difficulty.ts` defines what each
// descriptor means and what the tiers require; this file is where the claims are made. The measured
// half is recomputed from the sealed case and refused if it disagrees, the three fixture numbers are
// checked against the sealed tree by `workspace-tier-packs.test.ts`, and `expectedMinimumEditFiles`
// is checked against the reference solution under `test/engine/fixtures/workspace-solutions/`. What
// is left is a handful of counts a second reader can recount from the same repository — which is the
// most a difficulty claim can honestly be.
//
// THE FOUR FOUNDATION PROFILES DESCRIBE A PACK THAT HAS ALREADY RUN, and they change nothing about
// it. `ws.broken-sum.mean` is still at version 3, its `cwc1:`, `cwk1:` and the `cwp1:` of
// `pack.cernum.workspace.foundation-four@1` are the same bytes the forty-eight sealed records on
// this machine carry, and they are the same because a difficulty profile is a separate sealed object
// — see the header of `workspace-difficulty.ts` for why that decision went the way it did. Tier 1 is
// a description applied to a completed experiment, not an edit to it.

import { allWorkspaceCases } from './workspace-catalog';
import { WorkspaceCase } from './workspace-case';
import {
  WorkspaceDifficultyProfile, WorkspaceDifficultyProfileInput, makeWorkspaceDifficultyProfile,
  validateWorkspaceDifficultyProfile,
} from './workspace-difficulty';

/**
 * NOTHING HERE RUNS AT IMPORT TIME, and that is deliberate rather than stylistic.
 *
 * `validateWorkspaceCatalog` in `workspace-catalog.ts` checks the difficulty claims too — one
 * function, so a caller cannot validate half the catalogue — which makes these two files a cycle.
 * A cycle is harmless as long as neither side needs the other WHILE IT IS BEING LOADED, so every
 * profile below is built on first use and memoized. `allWorkspaceCases()` is a function for the same
 * reason and has been since the foundation.
 */
function profileOf(caseID: string, input: Omit<WorkspaceDifficultyProfileInput, 'caseID' | 'caseVersion'>): WorkspaceDifficultyProfile {
  const found = allWorkspaceCases().find((entry) => entry.id === caseID);
  if (found === undefined) {
    throw new Error(`difficulty profile for '${caseID}', which this build does not carry as a workspace case`);
  }
  const c = found as WorkspaceCase;
  return makeWorkspaceDifficultyProfile(c, { ...input, caseID: c.id, caseVersion: c.version });
}

// MARK: - Tier 1 · the foundation pack, described rather than changed

const BROKEN_SUM_MEAN_PROFILE = (): WorkspaceDifficultyProfile => profileOf('ws.broken-sum.mean', {
  tier: 'tier1',
  rationale: 'One line in one file of a three-file repository, found from an assertion that names the '
    + 'function that is wrong. There is nothing to diagnose and nothing to hold in mind: this is the floor, '
    + 'and it exists so that a model which cannot pass it is not measured on anything above it.',
  fixtureFileCount: 3,
  fixtureSourceFileCount: 1,
  fixtureByteCount: 2093,
  declared: {
    relevantFileCount: 2,
    expectedMinimumEditFiles: 1,
    dependencyDepth: 1,
    diagnosticDistance: 0,
    architecturalConstraintCount: 0,
    hiddenInvariantCount: 0,
    irrelevantContextFileCount: 0,
    independentDefectCount: 1,
  },
});

const TASK_PRIORITY_PROPAGATE_PROFILE = (): WorkspaceDifficultyProfile => profileOf('ws.task-priority.propagate', {
  tier: 'tier1',
  rationale: 'Three files, three suites that fail independently and one rule stated in docs/FORMAT.md that '
    + 'no test mentions. The broadest thing in the foundation pack — and still Tier 1, because every layer '
    + 'says plainly what it wants and nothing about where to make the change is ambiguous.',
  fixtureFileCount: 8,
  fixtureSourceFileCount: 3,
  fixtureByteCount: 8887,
  declared: {
    relevantFileCount: 7,
    expectedMinimumEditFiles: 3,
    dependencyDepth: 2,
    diagnosticDistance: 0,
    architecturalConstraintCount: 3,
    hiddenInvariantCount: 1,
    irrelevantContextFileCount: 0,
    independentDefectCount: 1,
  },
});

const RECEIPT_REFUNDS_SIGN_PROFILE = (): WorkspaceDifficultyProfile => profileOf('ws.receipt-refunds.sign', {
  tier: 'tier1',
  rationale: 'The one case in the foundation pack with any diagnostic distance at all: the failure is in the '
    + 'reporting layer and the defect is one module below it. That single boundary is what Haiku missed '
    + 'three times out of three while passing everything else — which is exactly why the tier above it is '
    + 'built around distance rather than around size.',
  fixtureFileCount: 4,
  fixtureSourceFileCount: 2,
  fixtureByteCount: 4395,
  declared: {
    relevantFileCount: 4,
    expectedMinimumEditFiles: 1,
    dependencyDepth: 2,
    diagnosticDistance: 1,
    architecturalConstraintCount: 0,
    hiddenInvariantCount: 1,
    irrelevantContextFileCount: 0,
    independentDefectCount: 1,
  },
});

const REGISTRY_ISOLATION_RECOVER_PROFILE = (): WorkspaceDifficultyProfile => profileOf('ws.registry-isolation.recover', {
  tier: 'tier1',
  rationale: 'One file, one defect, and two of its three consequences left standing by the obvious fix. The '
    + 'recovery case of the foundation pack: what makes it harder than broken-sum is the second reading of '
    + 'a rule the README states, not the size of anything.',
  fixtureFileCount: 3,
  fixtureSourceFileCount: 1,
  fixtureByteCount: 3776,
  declared: {
    relevantFileCount: 3,
    expectedMinimumEditFiles: 1,
    dependencyDepth: 1,
    diagnosticDistance: 0,
    architecturalConstraintCount: 1,
    hiddenInvariantCount: 2,
    irrelevantContextFileCount: 0,
    independentDefectCount: 1,
  },
});

// MARK: - Tier 2

const T2_LEDGER_CURRENCY_PROFILE = (): WorkspaceDifficultyProfile => profileOf('ws.t2.ledger-currency.propagate', {
  tier: 'tier2',
  rationale: 'Five files must change together, five suites fail independently, and two rules the suites never '
    + 'mention are written in docs/FORMAT.md and docs/API.md. Beyond every Tier 1 case on breadth, edits, '
    + 'dependency depth, architectural constraint and number of checks at once.',
  fixtureFileCount: 15,
  fixtureSourceFileCount: 7,
  fixtureByteCount: 18338,
  declared: {
    relevantFileCount: 12,
    expectedMinimumEditFiles: 5,
    dependencyDepth: 3,
    diagnosticDistance: 0,
    architecturalConstraintCount: 5,
    hiddenInvariantCount: 2,
    irrelevantContextFileCount: 0,
    independentDefectCount: 1,
  },
});

const T2_SCHEDULE_WINDOW_PROFILE = (): WorkspaceDifficultyProfile => profileOf('ws.t2.schedule-window.diagnose', {
  tier: 'tier2',
  rationale: 'The symptom is two module boundaries from the cause and the module in between has a passing test '
    + 'saying it is correct. Two decoy modules, two plausible wrong answers — one failing a visible suite and '
    + 'one only the hidden check. Beyond Tier 1 on depth, diagnostic distance, breadth, decoys and checks.',
  fixtureFileCount: 15,
  fixtureSourceFileCount: 9,
  fixtureByteCount: 19014,
  declared: {
    relevantFileCount: 11,
    expectedMinimumEditFiles: 1,
    dependencyDepth: 3,
    diagnosticDistance: 2,
    architecturalConstraintCount: 2,
    hiddenInvariantCount: 1,
    irrelevantContextFileCount: 2,
    independentDefectCount: 1,
  },
});

const T2_TEXT_NORMALIZE_PROFILE = (): WorkspaceDifficultyProfile => profileOf('ws.t2.text-normalize.cluster', {
  tier: 'tier2',
  rationale: 'Three suites fail three different-looking ways over one defect, a two-file change ceiling forbids '
    + 'treating them separately, and a fourth consumer nothing visible tests proves where the fix went. '
    + 'Beyond Tier 1 on breadth, architectural constraint, decoys and checks.',
  fixtureFileCount: 14,
  fixtureSourceFileCount: 8,
  fixtureByteCount: 13905,
  declared: {
    relevantFileCount: 10,
    expectedMinimumEditFiles: 1,
    dependencyDepth: 2,
    diagnosticDistance: 1,
    architecturalConstraintCount: 4,
    hiddenInvariantCount: 2,
    irrelevantContextFileCount: 2,
    independentDefectCount: 1,
  },
});

const T2_CACHE_EVICTION_PROFILE = (): WorkspaceDifficultyProfile => profileOf('ws.t2.cache-eviction.recover', {
  tier: 'tier2',
  rationale: 'Two independent defects, and the obvious place to fix the larger one is shared with a call that '
    + 'promises to change nothing — so the plausible answer makes every visible check green and breaks a '
    + 'documented promise. It clears Tier 1 on exactly three axes, which is the minimum, and it is in this '
    + 'tier for the trap rather than for the size.',
  fixtureFileCount: 12,
  fixtureSourceFileCount: 6,
  fixtureByteCount: 17715,
  declared: {
    relevantFileCount: 11,
    expectedMinimumEditFiles: 1,
    dependencyDepth: 2,
    diagnosticDistance: 0,
    architecturalConstraintCount: 2,
    hiddenInvariantCount: 2,
    irrelevantContextFileCount: 0,
    independentDefectCount: 2,
  },
});

// MARK: - Tier 3

const T3_PERMISSION_GATE_PROFILE = (): WorkspaceDifficultyProfile => profileOf('ws.t3.permission-gate.centralize', {
  tier: 'tier3',
  rationale: 'A boundary that does not exist has to be built at a path the architecture names, seven files '
    + 'change, five consumers move onto it, eight invariants hold the shape, and three hidden checks walk '
    + 'the whole decision table. The answer that fixes the reported leak passes every behaviour test in the '
    + 'repository.',
  fixtureFileCount: 24,
  fixtureSourceFileCount: 15,
  fixtureByteCount: 30311,
  declared: {
    relevantFileCount: 19,
    expectedMinimumEditFiles: 7,
    dependencyDepth: 3,
    diagnosticDistance: 0,
    architecturalConstraintCount: 8,
    hiddenInvariantCount: 3,
    irrelevantContextFileCount: 2,
    independentDefectCount: 1,
  },
});

const T3_EVENT_REPLAY_PROFILE = (): WorkspaceDifficultyProfile => profileOf('ws.t3.event-replay.pair', {
  tier: 'tier3',
  rationale: 'Two independent defects behind four failing suites, and each fix on its own turns exactly one '
    + 'suite green — which is the shape that makes stopping early feel like progress. Six checks, three '
    + 'hidden invariants, and invariants that stop the loop being reimplemented around them.',
  fixtureFileCount: 19,
  fixtureSourceFileCount: 11,
  fixtureByteCount: 26580,
  declared: {
    relevantFileCount: 13,
    expectedMinimumEditFiles: 2,
    dependencyDepth: 3,
    diagnosticDistance: 1,
    architecturalConstraintCount: 5,
    hiddenInvariantCount: 3,
    irrelevantContextFileCount: 2,
    independentDefectCount: 2,
  },
});

const T3_VALIDATOR_RULES_PROFILE = (): WorkspaceDifficultyProfile => profileOf('ws.t3.validator-rules.refactor', {
  tier: 'tier3',
  rationale: 'Nine files are written to rearrange a package whose caller-visible behaviour must not move by a '
    + 'byte, and the three answers short of correct — a partial migration, a wrapper around the old chain, '
    + 'and a regression — each fail something different. Eight invariants say where a condition may live.',
  fixtureFileCount: 15,
  fixtureSourceFileCount: 7,
  fixtureByteCount: 24726,
  declared: {
    relevantFileCount: 15,
    expectedMinimumEditFiles: 9,
    dependencyDepth: 2,
    diagnosticDistance: 0,
    architecturalConstraintCount: 8,
    hiddenInvariantCount: 3,
    irrelevantContextFileCount: 0,
    independentDefectCount: 1,
  },
});

const T3_IMPORT_PIPELINE_PROFILE = (): WorkspaceDifficultyProfile => profileOf('ws.t3.import-pipeline.finish', {
  tier: 'tier3',
  rationale: 'Six stages, four failing suites, two defects in three different stages, seventeen files that have '
    + 'to be read, and a first answer that is right about the key and wrong about the blank cell — which is '
    + 'what makes the second attempt worth measuring rather than worth skipping.',
  fixtureFileCount: 19,
  fixtureSourceFileCount: 10,
  fixtureByteCount: 25277,
  declared: {
    relevantFileCount: 17,
    expectedMinimumEditFiles: 3,
    dependencyDepth: 3,
    diagnosticDistance: 1,
    architecturalConstraintCount: 4,
    hiddenInvariantCount: 3,
    irrelevantContextFileCount: 0,
    independentDefectCount: 2,
  },
});

const PROFILE_BUILDERS: (() => WorkspaceDifficultyProfile)[] = [
  BROKEN_SUM_MEAN_PROFILE,
  TASK_PRIORITY_PROPAGATE_PROFILE,
  RECEIPT_REFUNDS_SIGN_PROFILE,
  REGISTRY_ISOLATION_RECOVER_PROFILE,
  T2_LEDGER_CURRENCY_PROFILE,
  T2_SCHEDULE_WINDOW_PROFILE,
  T2_TEXT_NORMALIZE_PROFILE,
  T2_CACHE_EVICTION_PROFILE,
  T3_PERMISSION_GATE_PROFILE,
  T3_EVENT_REPLAY_PROFILE,
  T3_VALIDATOR_RULES_PROFILE,
  T3_IMPORT_PIPELINE_PROFILE,
];

let builtProfiles: WorkspaceDifficultyProfile[] | undefined;

/** Every difficulty claim this build makes, in catalogue order. Built once, on first use. */
export function registeredWorkspaceDifficultyProfiles(): WorkspaceDifficultyProfile[] {
  if (builtProfiles === undefined) builtProfiles = PROFILE_BUILDERS.map((build) => build());
  return builtProfiles;
}

/**
 * Refuse a profile that does not hold up against the case it describes.
 *
 * Called by `validateWorkspaceCatalog`, so a preview or a matrix run refuses before anything is sent
 * rather than publishing a tier nobody checked.
 */
export function validateWorkspaceDifficultyCatalogue(describedStructurallyInstead: string[] = []): void {
  const cases = allWorkspaceCases();
  const seen = new Set<string>();
  for (const profile of registeredWorkspaceDifficultyProfiles()) {
    if (seen.has(profile.caseID)) {
      throw new Error(`two difficulty profiles for ${profile.caseID}; a case is judged once`);
    }
    seen.add(profile.caseID);
    const c = cases.find((entry) => entry.id === profile.caseID);
    if (c === undefined) throw new Error(`difficulty profile for unknown workspace case ${profile.caseID}`);
    validateWorkspaceDifficultyProfile(profile, c);
  }
  // EVERY case carries one — or, for the empirical discriminator family, an untiered STRUCTURAL
  // profile instead (`workspace-discriminator.ts`), and never both. A catalogue where some cases had
  // no structural claim at all would publish tables a reader cannot put beside each other, and
  // `workspacePackTier` refuses a half-profiled pack for the same reason.
  for (const c of cases) {
    const structural = describedStructurallyInstead.includes(c.id);
    if (seen.has(c.id) && structural) {
      throw new Error(`workspace case ${c.id} carries both a tier and an untiered structural profile. A case is either `
        + 'banded into a tier or deliberately left out of the tiers; it cannot be both.');
    }
    if (!seen.has(c.id) && !structural) {
      throw new Error(`workspace case ${c.id} carries no difficulty profile. Every case declares its tier, or a `
        + 'reader comparing two packs has no way to know whether they asked for comparable work.');
    }
  }
}
