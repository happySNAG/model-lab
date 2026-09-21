// Benchmark engine · how HARD a workspace case is, said in numbers rather than in an adjective.
//
// WHY THIS EXISTS. `pack.cernum.workspace.foundation-four@1` was run across four Claude models and
// three of them scored 12/12. A pack every strong model saturates has stopped measuring them: it
// still says a model can do small localized work, and it says nothing about what separates the ones
// that can from the ones that can barely. Harder packs answer that — but only if "harder" is a
// property of the TASK that a reader can check, rather than a label somebody attached.
//
// SO DIFFICULTY IS A MEASUREMENT OF THE CASE, NEVER A STATEMENT ABOUT A MODEL. Nothing in this file
// mentions a provider, a model or a route, and nothing downstream may route a case by tier: every
// model receives the same sealed case, and the tier says what the case demands, not who is expected
// to manage it. "Tier 3" means substantial repository understanding, cross-cutting work and several
// interacting invariants. It does not mean "the one for the big model", and a tier that came to mean
// that would be a tier that stopped being evidence.
//
// DIFFICULTY IS NOT TOKEN COUNT. A case can be enormous and trivial — a thousand files and a typo —
// and it can be small and hard, which is what every case in `tier-three` is. The descriptors below
// are about RELATIONSHIPS: how far the symptom is from the cause, how many modules have to agree
// afterwards, how many plausible answers are wrong, how much of the tree is a decoy. Byte counts
// appear only as a sanity bound, never as a tier.
//
// ────────────────────────────────────────────────────────────────────────────────────────────────
// WHY A PROFILE IS A SEPARATE SEALED OBJECT AND NOT A FIELD ON `WorkspaceCase`
//
// This is the load-bearing decision in this file and it went the way it did for two reasons, either
// of which would have settled it.
//
//   1  A FIELD ON THE CASE WOULD MOVE EVERY EXISTING DIGEST. `workspaceCaseDigest` seals the whole
//      struct, so adding `difficulty` to it changes `cwc1:` for `ws.broken-sum.mean` — a case whose
//      text did not change by one character — and therefore `cwk1:`, and therefore the `cwp1:` of
//      `foundation-four`. Forty-eight sealed records on this machine carry those three digests. They
//      would stop matching the case, the comparability key and the pack they were produced under,
//      and a completed, valid matrix would become unreadable to prove a label that changes nothing
//      about what any model was asked to do.
//
//   2  IT IS NOT PART OF THE EXPERIMENT. `cwc1:` answers "what was this model asked to do, in what
//      tree, checked how" and `cwp1:` answers "which tasks, at which versions, sampled how often".
//      Change the instruction and a stored result is about a different task; change `diagnosticDistance`
//      from 1 to 2 because a reader recounted the module boundaries and NOTHING a model did is
//      different. A difficulty claim is an ASSERTION ABOUT a case, and assertions about a thing do
//      not belong inside that thing's identity.
//
// IT IS SEALED ALL THE SAME, under `cwd1:`, and that digest travels on the matrix plan and the
// durable record. So a result does say which difficulty claim it was published under, a profile
// cannot be quietly retuned after the fact to make a model look better or worse, and the two
// questions stay separate: `cwc1:` says what was run, `cwd1:` says what this repository claimed
// about how hard it was.
//
// MEASURED VERSUS DECLARED, AND WHY BOTH ARE HERE. `measured` is DERIVED from the sealed case — how
// many checks it runs, how many are hidden, how many attempts it allows — and cannot be typed
// wrongly, because `measureWorkspaceCase` computes it and `validateWorkspaceDifficultyProfile`
// refuses a profile that disagrees. `declared` is the part a person judges: how far the cause is
// from the symptom, how many modules must agree afterwards. Those are read off the case by a human
// and could in principle be wrong, so every one of them has a definition here that a second reader
// can apply to the same case and get the same number — and the ones that can be cross-checked are:
// `expectedMinimumEditFiles` against the reference solution in `test/engine/fixtures/`,
// `fixtureFileCount` against the sealed tree, `architecturalConstraintCount` against the invariants.
// A number nobody can check is fake precision, and the way to avoid fake precision is not to publish
// fewer numbers but to make each one answerable.

import { CanonicalValue, digestObject } from './canonical';
import { WorkspaceCase, WorkspaceDimension } from './workspace-case';

export class WorkspaceDifficultyError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'WorkspaceDifficultyError';
  }
}

export const WORKSPACE_DIFFICULTY_SCHEMA_VERSION = 1;

/**
 * THE ONE SENTENCE THAT KEEPS A TIER FROM BECOMING A ROUTING HINT, carried on every plan and every
 * aggregate that publishes a tier.
 */
export const WORKSPACE_TIER_IS_A_PROPERTY_OF_THE_TASK =
  'A difficulty tier describes the TASK — how much of a repository must be understood, how far the '
  + 'cause is from the symptom, how many invariants must hold together, how many plausible answers '
  + 'are incomplete. It never describes a model, and it never selects one: every candidate in a '
  + 'matrix receives exactly the same sealed case, and a tier a model was not expected to manage is '
  + 'still a tier that model is asked to do. Tier 3 is not "the Opus case".';

export type WorkspaceDifficultyTier = 'tier1' | 'tier2' | 'tier3';

export const ALL_WORKSPACE_DIFFICULTY_TIERS: WorkspaceDifficultyTier[] = ['tier1', 'tier2', 'tier3'];

/** The prose a reader meets beside the tier, once, so no surface invents its own wording. */
export const WORKSPACE_TIER_DESCRIPTIONS: Record<WorkspaceDifficultyTier, string> = {
  tier1: 'Small, localized work. One to three source files, a verification path that is usually '
    + 'obvious from the failure, and little architectural ambiguity. A model that cannot pass these '
    + 'cannot be measured on the rest.',
  tier2: 'Moderate repository understanding. Several interacting files or modules, a symptom that '
    + 'may be misleading or several fixes that are all plausible, diagnosis that may need the tools '
    + 'rather than the instruction, and in one case a first answer worth recovering from.',
  tier3: 'Substantial repository understanding. Architectural or cross-cutting work, several '
    + 'invariants that have to hold at once, longer dependency chains, and several answers that are '
    + 'plausible and incomplete. These are the cases expected to separate strong frontier agents.',
};

// MARK: - The descriptors

/**
 * What this engine DERIVES from the sealed case. Never typed by hand; see `measureWorkspaceCase`.
 *
 * Three of these are about the fixture's shape rather than the case struct — a case names a
 * directory, not its contents — so they are declared beside the rest and checked against the sealed
 * tree by `workspace-tier-packs.test.ts`, which already snapshots every fixture to verify its seal.
 */
export interface WorkspaceMeasuredDifficulty extends Record<string, CanonicalValue | undefined> {
  /** Files in the sealed fixture tree, checked against the tree the case is sealed against. */
  fixtureFileCount: number;
  /** Of those, the ones under `src/`. The tree the answer may change. */
  fixtureSourceFileCount: number;
  /** Bytes in the sealed fixture tree. A SANITY BOUND, never a tier — see the header. */
  fixtureByteCount: number;
  /** Visible verification commands that decide the verdict. */
  verificationCommandCount: number;
  /** Checks the agent is never told about. */
  hiddenCommandCount: number;
  /** File invariants the final tree is held to. */
  fileInvariantCount: number;
  /** What `execution.maximumAttempts` allows. 1 measures first-time; 2 measures recovery. */
  maximumAttempts: number;
  /** Paths named to the agent as a starting point. Zero means it has to find them. */
  briefingPathCount: number;
  /** `verification.maximumChangedFiles`. Zero means the case sets no ceiling. */
  changedFileCeiling: number;
}

/**
 * What a case author JUDGES, with a definition beside each one so two readers get the same number.
 *
 * Every field is a count of something in the repository, not a score out of ten. There is no
 * weighting, no composite and no "difficulty rating": the tier is decided by the bands below, from
 * these counts, and a reader who disagrees with a count can go and recount it.
 */
export interface WorkspaceDeclaredDifficulty extends Record<string, CanonicalValue | undefined> {
  /**
   * Files in the fixture a correct answer must READ: the ones it changes, the ones those depend on,
   * the checks that fail, and the documents that state a requirement it has to meet.
   */
  relevantFileCount: number;
  /**
   * Files the reference solution WRITES.
   *
   * Cross-checked: `test/engine/fixtures/workspace-solutions/<case-id>/` holds that solution, and
   * the discrimination test counts its files against this number.
   */
  expectedMinimumEditFiles: number;
  /**
   * The longest chain of module-to-module requires from a failing check to a file that must change.
   *
   * A test that requires the broken module directly is 1. A test that requires a module that
   * requires the broken one is 2.
   */
  dependencyDepth: number;
  /**
   * Module boundaries between where the failure is OBSERVED and where the defect IS.
   *
   * 0 when the failing assertion is about the function that is wrong. 2 when the failure is in a
   * module two requires away from the one that has to change — which is what makes a symptom
   * misleading rather than merely indirect.
   */
  diagnosticDistance: number;
  /**
   * Requirements about the SHAPE of the answer rather than its behaviour: a module that must keep
   * existing, an export that must stay where it is, a decision that must live in one place.
   *
   * Counted from the case's own file invariants, so it can never exceed `fileInvariantCount`.
   */
  architecturalConstraintCount: number;
  /**
   * Requirements the repository states and no VISIBLE check tests, which the hidden checks ask for.
   *
   * Zero is legitimate and means the case's whole verdict is visible in advance. A case declaring
   * more than zero must have a hidden command, and one with a hidden command must declare more than
   * zero — a hidden check that tests nothing the repository states would be a trap.
   */
  hiddenInvariantCount: number;
  /**
   * Source files in the fixture a correct answer never needs to read or change.
   *
   * The decoys. A repository where everything is relevant is a repository that has told the model
   * where to look.
   */
  irrelevantContextFileCount: number;
  /**
   * Defects that must BOTH be fixed for the case to pass, where fixing one leaves checks failing
   * that the other is responsible for. 1 for every case with a single cause.
   */
  independentDefectCount: number;
}

/** Every declared axis, in the order a table prints them. */
export const WORKSPACE_DECLARED_DIFFICULTY_AXES: (keyof WorkspaceDeclaredDifficulty)[] = [
  'relevantFileCount', 'expectedMinimumEditFiles', 'dependencyDepth', 'diagnosticDistance',
  'architecturalConstraintCount', 'hiddenInvariantCount', 'irrelevantContextFileCount',
  'independentDefectCount',
];

/**
 * One case's difficulty, sealed under `cwd1:`.
 *
 * It names the case AND the case version it describes, because a case whose task changed is a case
 * whose difficulty claim has to be looked at again; `validateWorkspaceDifficultyProfile` refuses a
 * profile whose `caseVersion` is not the version the catalogue carries.
 */
export interface WorkspaceDifficultyProfile extends Record<string, CanonicalValue | undefined> {
  schemaVersion: number;
  caseID: string;
  caseVersion: string;
  tier: WorkspaceDifficultyTier;
  /** One sentence saying what makes THIS case its tier. Not boilerplate; a reader checks it. */
  rationale: string;
  measured: WorkspaceMeasuredDifficulty;
  declared: WorkspaceDeclaredDifficulty;
}

export interface WorkspaceDifficultyProfileInput {
  caseID: string;
  caseVersion: string;
  tier: WorkspaceDifficultyTier;
  rationale: string;
  fixtureFileCount: number;
  fixtureSourceFileCount: number;
  fixtureByteCount: number;
  declared: WorkspaceDeclaredDifficulty;
}

/**
 * The measured half, read off the sealed case.
 *
 * The three fixture numbers come from the input because a case names a directory rather than
 * carrying it; everything else is computed here and cannot be supplied.
 */
export function measureWorkspaceCase(
  c: WorkspaceCase,
  fixture: { fixtureFileCount: number; fixtureSourceFileCount: number; fixtureByteCount: number },
): WorkspaceMeasuredDifficulty {
  return {
    fixtureFileCount: fixture.fixtureFileCount,
    fixtureSourceFileCount: fixture.fixtureSourceFileCount,
    fixtureByteCount: fixture.fixtureByteCount,
    verificationCommandCount: c.verification.commands.filter((command) => command.required).length,
    hiddenCommandCount: c.verification.hiddenCommands.length,
    fileInvariantCount: c.verification.invariants.length,
    maximumAttempts: c.execution.maximumAttempts,
    briefingPathCount: c.task.briefingPaths.length,
    changedFileCeiling: c.verification.maximumChangedFiles,
  };
}

export function makeWorkspaceDifficultyProfile(
  c: WorkspaceCase, input: WorkspaceDifficultyProfileInput,
): WorkspaceDifficultyProfile {
  return {
    schemaVersion: WORKSPACE_DIFFICULTY_SCHEMA_VERSION,
    caseID: input.caseID,
    caseVersion: input.caseVersion,
    tier: input.tier,
    rationale: input.rationale,
    measured: measureWorkspaceCase(c, input),
    declared: { ...input.declared },
  };
}

/**
 * `cwd1:` — the identity of a difficulty CLAIM.
 *
 * Deliberately NOT inside `cwc1:` or `cwp1:`; see the header. It binds the case it is about and the
 * case version it was judged against, so a profile can never be read as describing a different task
 * than the one it was written for.
 */
export function workspaceDifficultyDigest(profile: WorkspaceDifficultyProfile): string {
  return 'cwd1:' + digestObject(profile as unknown as CanonicalValue);
}

// MARK: - What a tier MEANS, as bands rather than as an adjective

/**
 * The bands a case must satisfy to carry a tier.
 *
 * `minimum` and `maximum` are floors and ceilings every member meets. `minimumAxesBeyondPreviousTier`
 * is the part that stops a tier being "the previous tier but slightly bigger": a case must go beyond
 * EVERY case of the tier below on at least this many INDEPENDENT axes. Three, because one axis is a
 * coincidence and two is a pair of related measurements — `relevantFileCount` and
 * `verificationCommandCount` tend to move together — while three different kinds of demand is a
 * genuinely different task.
 *
 * WHY NOT REQUIRE EVERY AXIS. Because the tiers would then only admit cases that are hard in every
 * way at once, and those are the least interesting ones. `ws.t2.text-normalize.cluster` is a
 * one-file fix: what makes it Tier 2 is that four consumers fail for four different-looking reasons
 * and the change ceiling forbids patching them one at a time. `ws.t2.ledger-currency.propagate` is
 * the opposite — five files, no misdirection at all. A band that demanded both would have excluded
 * both, and the pack would measure one kind of difficulty four times.
 */
export interface WorkspaceTierBand {
  minimum: Partial<WorkspaceDeclaredDifficulty & WorkspaceMeasuredDifficulty>;
  maximum: Partial<WorkspaceDeclaredDifficulty & WorkspaceMeasuredDifficulty>;
  minimumAxesBeyondPreviousTier: number;
}

/**
 * The axes a case may escalate on, and the only ones counted toward the rule above.
 *
 * `fixtureFileCount` and `fixtureByteCount` are deliberately ABSENT. A bigger tree is not a harder
 * task — that is the whole point of the header — and counting size as escalation would let a case
 * reach Tier 3 by adding files nobody has to read.
 */
export const WORKSPACE_ESCALATION_AXES: (keyof (WorkspaceDeclaredDifficulty & WorkspaceMeasuredDifficulty))[] = [
  'relevantFileCount', 'expectedMinimumEditFiles', 'dependencyDepth', 'diagnosticDistance',
  'architecturalConstraintCount', 'hiddenInvariantCount', 'irrelevantContextFileCount',
  'independentDefectCount', 'verificationCommandCount',
];

export const WORKSPACE_TIER_BANDS: Record<WorkspaceDifficultyTier, WorkspaceTierBand> = {
  tier1: {
    minimum: {},
    maximum: {
      relevantFileCount: 8,
      expectedMinimumEditFiles: 3,
      dependencyDepth: 2,
      diagnosticDistance: 1,
      architecturalConstraintCount: 3,
      hiddenInvariantCount: 2,
      irrelevantContextFileCount: 0,
      independentDefectCount: 1,
      verificationCommandCount: 3,
      fixtureFileCount: 10,
    },
    minimumAxesBeyondPreviousTier: 0,
  },
  tier2: {
    minimum: {
      relevantFileCount: 8,
      hiddenInvariantCount: 1,
      verificationCommandCount: 4,
      fixtureFileCount: 10,
    },
    maximum: {
      relevantFileCount: 12,
      expectedMinimumEditFiles: 6,
      dependencyDepth: 3,
      diagnosticDistance: 2,
      architecturalConstraintCount: 6,
      hiddenInvariantCount: 2,
      irrelevantContextFileCount: 2,
      independentDefectCount: 2,
      verificationCommandCount: 5,
      fixtureFileCount: 22,
    },
    minimumAxesBeyondPreviousTier: 3,
  },
  tier3: {
    minimum: {
      relevantFileCount: 12,
      hiddenInvariantCount: 3,
      verificationCommandCount: 5,
      fixtureFileCount: 14,
    },
    maximum: {},
    minimumAxesBeyondPreviousTier: 3,
  },
};

/** The tier below, or `undefined` for the floor. */
export function tierBelow(tier: WorkspaceDifficultyTier): WorkspaceDifficultyTier | undefined {
  const index = ALL_WORKSPACE_DIFFICULTY_TIERS.indexOf(tier);
  return index <= 0 ? undefined : ALL_WORKSPACE_DIFFICULTY_TIERS[index - 1];
}

function axisValue(
  profile: WorkspaceDifficultyProfile,
  axis: keyof (WorkspaceDeclaredDifficulty & WorkspaceMeasuredDifficulty),
): number | undefined {
  const declared = (profile.declared as Record<string, CanonicalValue | undefined>)[axis as string];
  if (typeof declared === 'number') return declared;
  const measured = (profile.measured as Record<string, CanonicalValue | undefined>)[axis as string];
  return typeof measured === 'number' ? measured : undefined;
}

/**
 * The axes on which this profile goes beyond every case of the tier below.
 *
 * "Beyond" means strictly greater than the tier-below BAND's ceiling for that axis, not greater than
 * some particular sibling case: a ceiling is a statement about every member, so clearing it clears
 * all of them at once and stays true when a case is added to the tier below.
 */
export function axesBeyondPreviousTier(
  profile: WorkspaceDifficultyProfile,
): (keyof (WorkspaceDeclaredDifficulty & WorkspaceMeasuredDifficulty))[] {
  const previous = tierBelow(profile.tier);
  if (previous === undefined) return [];
  const ceilings = WORKSPACE_TIER_BANDS[previous].maximum as Record<string, number | undefined>;
  return WORKSPACE_ESCALATION_AXES.filter((axis) => {
    const ceiling = ceilings[axis as string];
    const value = axisValue(profile, axis);
    return ceiling !== undefined && value !== undefined && value > ceiling;
  });
}

// MARK: - Validation (fail-closed; a profile that does not hold up is refused at authoring time)

const COUNT_FIELDS_MUST_BE_WHOLE_AND_NOT_NEGATIVE = 'every difficulty descriptor is a whole count of '
  + 'something in the repository, so it is a non-negative integer. There is no score out of ten here.';

/**
 * Refuse a profile that does not describe the case it names, at authoring time.
 *
 * FAIL-CLOSED AND CROSS-CHECKED. The measured half is recomputed from the case and compared, so a
 * profile cannot claim four visible checks for a case that runs six. The declared half is checked
 * against the case where a check exists — `architecturalConstraintCount` cannot exceed the
 * invariants the case actually carries, `hiddenInvariantCount` and the hidden commands must agree
 * about whether there are any. And the tier's own bands are applied, so a case cannot be labelled
 * Tier 3 because somebody felt it was hard.
 */
export function validateWorkspaceDifficultyProfile(profile: WorkspaceDifficultyProfile, c: WorkspaceCase): void {
  const refuse = (code: string, message: string): never => {
    throw new WorkspaceDifficultyError(code, `difficulty profile for ${profile.caseID}: ${message}`);
  };

  if (profile.caseID !== c.id) refuse('caseMismatch', `describes '${profile.caseID}' but was checked against '${c.id}'`);
  if (profile.caseVersion !== c.version) {
    refuse('caseVersionMismatch', `was written for version ${profile.caseVersion} and the catalogue carries `
      + `version ${c.version}. A case whose task changed is a case whose difficulty has to be judged again.`);
  }
  if (!ALL_WORKSPACE_DIFFICULTY_TIERS.includes(profile.tier)) refuse('unknownTier', `declares tier '${profile.tier}'`);
  if (profile.rationale.trim().length === 0) {
    refuse('noRationale', 'states no rationale. A tier with no sentence saying what makes THIS case that '
      + 'tier is a label, and a label is what this file exists to replace.');
  }

  validateWorkspaceStructuralDescriptors(profile.measured, profile.declared, c, refuse);

  const band = WORKSPACE_TIER_BANDS[profile.tier];
  for (const [axis, floor] of Object.entries(band.minimum)) {
    const value = axisValue(profile, axis as keyof WorkspaceDeclaredDifficulty);
    if (value === undefined || value < (floor as number)) {
      refuse('belowTierFloor', `declares ${profile.tier} with ${axis} of ${String(value)}; ${profile.tier} asks for at `
        + `least ${String(floor)}. ${WORKSPACE_TIER_DESCRIPTIONS[profile.tier]}`);
    }
  }
  for (const [axis, ceiling] of Object.entries(band.maximum)) {
    const value = axisValue(profile, axis as keyof WorkspaceDeclaredDifficulty);
    if (value !== undefined && value > (ceiling as number)) {
      refuse('aboveTierCeiling', `declares ${profile.tier} with ${axis} of ${value}, above the ${ceiling} that tier `
        + 'allows. A case that demands more than its tier describes belongs in the tier above, where a reader '
        + 'comparing two results at one tier can rely on them having asked for comparable work.');
    }
  }

  const beyond = axesBeyondPreviousTier(profile);
  if (beyond.length < band.minimumAxesBeyondPreviousTier) {
    refuse('notBeyondPreviousTier', `declares ${profile.tier} while going beyond every ${tierBelow(profile.tier)} case `
      + `on only ${beyond.length} axis/axes (${beyond.join(', ') || 'none'}); `
      + `${band.minimumAxesBeyondPreviousTier} are required. A tier is not the tier below with more files in it.`);
  }
}

/**
 * The checks every structural claim about a case must pass, WHATEVER it is used for.
 *
 * Shared by the tier profiles above and by the untiered structural profiles in
 * `workspace-discriminator.ts`, so the two kinds of claim are held to one standard: the measured
 * half is recomputed from the sealed case, and the declared half is cross-checked wherever the case
 * gives something to check it against. What a TIER adds on top — floors, ceilings and the
 * three-axes rule — stays in `validateWorkspaceDifficultyProfile`, because it is a claim about
 * ordering between cases that an untiered profile does not make.
 */
export function validateWorkspaceStructuralDescriptors(
  measured: WorkspaceMeasuredDifficulty, declared: WorkspaceDeclaredDifficulty, c: WorkspaceCase,
  refuse: (code: string, message: string) => never,
): void {
  const counts = { ...measured, ...declared } as Record<string, CanonicalValue | undefined>;
  for (const [name, value] of Object.entries(counts)) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      refuse('invalidDescriptor', `declares ${name} as ${String(value)}. ${COUNT_FIELDS_MUST_BE_WHOLE_AND_NOT_NEGATIVE}`);
    }
  }

  const recomputed = measureWorkspaceCase(c, measured);
  for (const [name, value] of Object.entries(recomputed)) {
    if ((measured as Record<string, CanonicalValue | undefined>)[name] !== value) {
      refuse('measurementDisagrees', `claims ${name} is `
        + `${String((measured as Record<string, CanonicalValue | undefined>)[name])}, and the sealed case says `
        + `${String(value)}. The measured half is derived, not asserted.`);
    }
  }

  if (declared.architecturalConstraintCount > measured.fileInvariantCount) {
    refuse('moreConstraintsThanInvariants', `claims ${declared.architecturalConstraintCount} architectural `
      + `constraints and the case carries ${measured.fileInvariantCount} file invariants. A constraint on the `
      + 'shape of an answer is something the case enforces, not something a profile asserts.');
  }
  if ((declared.hiddenInvariantCount > 0) !== (measured.hiddenCommandCount > 0)) {
    refuse('hiddenInvariantsDisagree', `claims ${declared.hiddenInvariantCount} hidden invariants and the case `
      + `carries ${measured.hiddenCommandCount} hidden commands. A hidden invariant with nothing checking it `
      + 'is not measured, and a hidden check testing nothing the repository states is a trap.');
  }
  if (declared.relevantFileCount + declared.irrelevantContextFileCount > measured.fixtureFileCount) {
    refuse('moreFilesThanThereAre', `accounts for ${declared.relevantFileCount} relevant and `
      + `${declared.irrelevantContextFileCount} irrelevant files in a tree of ${measured.fixtureFileCount}`);
  }
  if (declared.expectedMinimumEditFiles < 1) {
    refuse('noEdits', 'expects a correct answer to change no files, which would make every no-op a pass');
  }
  if (declared.independentDefectCount < 1) {
    refuse('noDefects', 'declares no defect to fix, so there would be nothing to measure');
  }
  if (declared.independentDefectCount > 1 && measured.verificationCommandCount < 2) {
    refuse('defectsCannotBeSeparated', `claims ${declared.independentDefectCount} independent defects behind a `
      + 'single verification command, so fixing one of them could never be told apart from fixing both');
  }
}

// MARK: - Reading a set of profiles

export interface WorkspaceDifficultyCatalogue {
  profiles: WorkspaceDifficultyProfile[];
}

export function workspaceDifficultyProfileFor(
  profiles: WorkspaceDifficultyProfile[], caseID: string,
): WorkspaceDifficultyProfile | undefined {
  return profiles.find((profile) => profile.caseID === caseID);
}

/**
 * The tier a whole PACK carries, or a refusal.
 *
 * A pack has ONE tier or it has none: a pack mixing tiers would publish a table whose rows are not
 * comparable in the one respect the tier exists to state, and a reader seeing "Tier 2: 9/12" would
 * be reading an average over three difficulties. `undefined` is returned for a pack whose members
 * have no profiles at all, which is how a pack authored before this file existed stays runnable.
 */
export function workspacePackTier(
  profiles: WorkspaceDifficultyProfile[], caseIDs: string[],
): WorkspaceDifficultyTier | undefined {
  const found = caseIDs.map((caseID) => workspaceDifficultyProfileFor(profiles, caseID));
  if (found.every((profile) => profile === undefined)) return undefined;
  const missing = caseIDs.filter((caseID) => workspaceDifficultyProfileFor(profiles, caseID) === undefined);
  if (missing.length > 0) {
    throw new WorkspaceDifficultyError('packPartiallyProfiled',
      `these cases carry no difficulty profile: ${missing.join(', ')}. A pack is profiled or it is not; half a `
      + 'profile would publish a tier for a table some of whose rows nobody judged.');
  }
  const tiers = [...new Set(found.map((profile) => (profile as WorkspaceDifficultyProfile).tier))];
  if (tiers.length > 1) {
    throw new WorkspaceDifficultyError('packMixesTiers',
      `names cases at ${tiers.join(' and ')}. A pack carries one tier or none: a mixed pack publishes a table whose `
      + 'rows differ in the one respect the tier exists to state, and its per-model figures would be an average '
      + 'over difficulties nobody asked to have averaged.');
  }
  return tiers[0];
}

/** `cwd1:` for a whole pack: every member's profile digest, in the pack's own order. */
export function workspacePackDifficultyDigest(
  profiles: WorkspaceDifficultyProfile[], caseIDs: string[],
): string | undefined {
  if (workspacePackTier(profiles, caseIDs) === undefined) return undefined;
  return 'cwd1:' + digestObject({
    cases: caseIDs.map((caseID) => {
      const profile = workspaceDifficultyProfileFor(profiles, caseID) as WorkspaceDifficultyProfile;
      return { caseID, digest: workspaceDifficultyDigest(profile) };
    }) as unknown as CanonicalValue,
  });
}

/**
 * The lines a preview prints for one case's difficulty. One place, so no surface invents its own.
 */
export function describeWorkspaceDifficulty(profile: WorkspaceDifficultyProfile, dimensions: WorkspaceDimension[]): string[] {
  const declared = WORKSPACE_DECLARED_DIFFICULTY_AXES
    .map((axis) => `${axis} ${String(profile.declared[axis])}`)
    .join(', ');
  return [
    `tier            ${profile.tier} — ${WORKSPACE_TIER_DESCRIPTIONS[profile.tier].split('.')[0]}`,
    `  rationale     ${profile.rationale}`,
    `  dimensions    ${dimensions.join(', ')}`,
    `  measured      fixture ${profile.measured.fixtureFileCount} files `
      + `(${profile.measured.fixtureSourceFileCount} under src/, ${profile.measured.fixtureByteCount} bytes), `
      + `${profile.measured.verificationCommandCount} visible check(s), `
      + `${profile.measured.hiddenCommandCount} hidden, ${profile.measured.fileInvariantCount} invariant(s), `
      + `${profile.measured.maximumAttempts} attempt(s)`,
    `  declared      ${declared}`,
    `  beyond ${tierBelow(profile.tier) ?? 'nothing'}  ${axesBeyondPreviousTier(profile).join(', ') || '(this is the floor tier)'}`,
    `  difficulty    ${workspaceDifficultyDigest(profile)}`,
  ];
}
