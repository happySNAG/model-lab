// Benchmark engine · STRUCTURAL difficulty without a tier, and the design claims of a discriminator.
//
// TWO QUESTIONS THAT LOOK LIKE ONE, AND ARE NOT.
//
//   STRUCTURAL DIFFICULTY is a property of the CASE, readable before anything runs: how many files
//   an answer has to read and write, how long the chain from a failing check to a file that must
//   change, how many invariants shape the answer, how many requirements no visible check tests.
//   `workspace-difficulty.ts` defines those counts, checks each one against the sealed case, and
//   bands them into tiers. It is real information, and it is kept.
//
//   EMPIRICAL DISCRIMINATION is a property of a CAMPAIGN, readable only after one: which of a given
//   set of candidates passed a case, which failed it, whether their repeats agreed, and how. It is
//   computed from sealed records by `workspace-empirical-evidence.ts` and exists nowhere else. It is
//   relative by construction — a case that separates four candidates today may separate none of the
//   next four — and it is never written into a case, a profile or an instruction.
//
// THE TIER MATRICES ARE WHY THE TWO ARE KEPT APART. Tier 3 is the structurally hardest pack in the
// catalogue and was passed 48 times out of 48. Tier 2 separated one candidate on one case. So a tier
// describes what a case DEMANDS, faithfully, and says nothing reliable about who will FAIL it — and
// a Tier 4 made by raising the same counts would be the same bet again.
//
// SO A DISCRIMINATOR CASE CARRIES A STRUCTURAL PROFILE AND NO TIER. The same measured half, derived
// from the case and refused if it disagrees; the same declared counts, cross-checked by the same
// function (`validateWorkspaceStructuralDescriptors`) the tier profiles go through. What it does not
// carry is a tier, because a tier is a claim about ordering between cases ("harder than every case of
// the tier below on three axes") that this family was created precisely not to make. In its place it
// carries a DESIGN: the abstract reasoning pattern the case isolates, whether it is built so that a
// retry can be observed, and the plausible wrong answers it is proven to refuse. Those are statements
// of intent about the task, checked where they can be — `recoveryDesigned` must agree with the case's
// own attempt ceiling — and they are not evidence. Evidence is what the runs produce.
//
// SEALED SEPARATELY, under `cwx1:`, for the reason `cwd1:` is: an assertion ABOUT a case does not
// belong inside the case's identity, and it must still be impossible to retune after the fact.
//
// NOTHING HERE NAMES A PROVIDER, A MODEL OR A PRIOR OUTCOME. A test asserts it.

import { CanonicalValue, digestObject } from './canonical';
import { WorkspaceCase, WorkspaceDimension } from './workspace-case';
import {
  WORKSPACE_DECLARED_DIFFICULTY_AXES, WorkspaceDeclaredDifficulty, WorkspaceMeasuredDifficulty, measureWorkspaceCase,
  validateWorkspaceStructuralDescriptors,
} from './workspace-difficulty';

export class WorkspaceDiscriminatorError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'WorkspaceDiscriminatorError';
  }
}

export const WORKSPACE_STRUCTURAL_PROFILE_SCHEMA_VERSION = 1;

/** Carried on every plan and every aggregate that shows a structural profile or a discrimination reading. */
export const WORKSPACE_STRUCTURE_IS_NOT_DISCRIMINATION =
  'Structural difficulty is a property of the case — how much of a repository an answer has to read, change and '
  + 'hold true at once — and it is readable before anything runs. Empirical discrimination is a property of a '
  + 'campaign — which of a particular set of candidates passed, which failed, and whether their repeats agreed — '
  + 'and it exists only after one. Neither predicts the other: the structurally hardest pack in this catalogue was '
  + 'passed by every candidate that ran it. A discriminator case carries a structural profile and no tier, and no '
  + 'case, profile or instruction ever carries an outcome.';

/**
 * The abstract reasoning a discriminator case is built around. A small closed set, so two cases
 * that claim the same pattern can be found and two that claim different ones can be told apart.
 */
export type WorkspaceReasoningPattern =
  /** Apply the recognised transformations and carry everything unrecognised through unchanged. */
  | 'preserveUnknownDuringTransformation'
  /** Rewrite data a newer or foreign writer produced without losing what this code cannot read. */
  | 'forwardCompatibleRewrite'
  /** Change exactly what a policy names, where the easy fix is a catch-all that changes more. */
  | 'selectiveTransformationOverCatchAll'
  /** Two components whose invariants must agree; fixing either alone is not enough. */
  | 'interactingInvariants'
  /** A stated property, checked generatively; a failure prints a concrete counterexample. */
  | 'counterexampleDrivenRecovery'
  /** New code interacting with a module it calls; an integration check reports the state it left. */
  | 'integrationDrivenRecovery';

export const ALL_WORKSPACE_REASONING_PATTERNS: WorkspaceReasoningPattern[] = [
  'preserveUnknownDuringTransformation', 'forwardCompatibleRewrite', 'selectiveTransformationOverCatchAll',
  'interactingInvariants', 'counterexampleDrivenRecovery', 'integrationDrivenRecovery',
];

/** What the case was DESIGNED to do. Intent, checked where it can be; never evidence. */
export interface WorkspaceDiscriminatorDesign extends Record<string, CanonicalValue | undefined> {
  reasoningPattern: WorkspaceReasoningPattern;
  /**
   * The case whose reasoning shape this one generalises, when there is one. A CASE id — never a
   * candidate, never a result. It says where the hypothesis came from, not what anybody scored.
   */
  generalises?: string;
  /**
   * True when the case is built so that a failed first attempt is followed by a second one that can
   * be observed. Must agree with the case's own `maximumAttempts`.
   */
  recoveryDesigned: boolean;
  /**
   * The plausible wrong answers the case is proven to refuse, by short name. Each has a scripted
   * counterpart in `workspace-discriminator.test.ts`; a name here with no test is a claim nobody checked.
   */
  refusedWrongAnswers: string[];
}

export interface WorkspaceStructuralProfile extends Record<string, CanonicalValue | undefined> {
  schemaVersion: number;
  caseID: string;
  caseVersion: string;
  /** Always the literal family name: no tier, and nothing that could be read as one. */
  family: 'empiricalDiscriminator';
  /** One sentence saying what makes THIS case discriminating by design. A reader checks it. */
  rationale: string;
  measured: WorkspaceMeasuredDifficulty;
  declared: WorkspaceDeclaredDifficulty;
  design: WorkspaceDiscriminatorDesign;
}

export interface WorkspaceStructuralProfileInput {
  rationale: string;
  fixtureFileCount: number;
  fixtureSourceFileCount: number;
  fixtureByteCount: number;
  declared: WorkspaceDeclaredDifficulty;
  design: WorkspaceDiscriminatorDesign;
}

export function makeWorkspaceStructuralProfile(c: WorkspaceCase, input: WorkspaceStructuralProfileInput): WorkspaceStructuralProfile {
  return {
    schemaVersion: WORKSPACE_STRUCTURAL_PROFILE_SCHEMA_VERSION,
    caseID: c.id,
    caseVersion: c.version,
    family: 'empiricalDiscriminator',
    rationale: input.rationale,
    measured: measureWorkspaceCase(c, input),
    declared: { ...input.declared },
    design: {
      ...input.design,
      refusedWrongAnswers: [...input.design.refusedWrongAnswers],
    },
  };
}

/** `cwx1:` — the identity of a structural-and-design claim about one case. Never inside `cwc1:` or `cwp1:`. */
export function workspaceStructuralProfileDigest(profile: WorkspaceStructuralProfile): string {
  return 'cwx1:' + digestObject(profile as unknown as CanonicalValue);
}

/** `cwx1:` for a whole pack: every member's profile digest, in the pack's order. `undefined` when none are profiled. */
export function workspacePackStructuralDigest(profiles: WorkspaceStructuralProfile[], caseIDs: string[]): string | undefined {
  const found = caseIDs.map((caseID) => profiles.find((profile) => profile.caseID === caseID));
  if (found.every((profile) => profile === undefined)) return undefined;
  const missing = caseIDs.filter((_caseID, index) => found[index] === undefined);
  if (missing.length > 0) {
    throw new WorkspaceDiscriminatorError('packPartiallyProfiled',
      `these cases carry no structural profile: ${missing.join(', ')}. A discriminator pack is profiled whole or `
      + 'not at all.');
  }
  return 'cwx1:' + digestObject({
    cases: caseIDs.map((caseID, index) => ({
      caseID, digest: workspaceStructuralProfileDigest(found[index] as WorkspaceStructuralProfile),
    })) as unknown as CanonicalValue,
  });
}

/**
 * Refuse a structural profile that does not describe the case it names.
 *
 * The same structural checks a tier profile passes, plus the design's own: a known pattern, a
 * recovery claim that agrees with the attempt ceiling, and at least one named wrong answer — a
 * discriminator that refuses nothing in particular has not said what it discriminates.
 */
export function validateWorkspaceStructuralProfile(profile: WorkspaceStructuralProfile, c: WorkspaceCase): void {
  const refuse = (code: string, message: string): never => {
    throw new WorkspaceDiscriminatorError(code, `structural profile for ${profile.caseID}: ${message}`);
  };
  if (profile.caseID !== c.id) refuse('caseMismatch', `describes '${profile.caseID}' but was checked against '${c.id}'`);
  if (profile.caseVersion !== c.version) {
    refuse('caseVersionMismatch', `was written for version ${profile.caseVersion} and the catalogue carries `
      + `version ${c.version}. A case whose task changed has to be described again.`);
  }
  if (profile.family !== 'empiricalDiscriminator') refuse('unknownFamily', `declares family '${String(profile.family)}'`);
  if ((profile as Record<string, unknown>).tier !== undefined) {
    refuse('tierOnAStructuralProfile', 'carries a tier. A discriminator case is untiered by design; a tier is a claim '
      + 'about ordering between cases that this family exists not to make.');
  }
  if (profile.rationale.trim().length === 0) refuse('noRationale', 'states no rationale');

  validateWorkspaceStructuralDescriptors(profile.measured, profile.declared, c, refuse);

  if (!ALL_WORKSPACE_REASONING_PATTERNS.includes(profile.design.reasoningPattern)) {
    refuse('unknownPattern', `declares reasoning pattern '${String(profile.design.reasoningPattern)}'`);
  }
  if (profile.design.recoveryDesigned !== (c.execution.maximumAttempts > 1)) {
    refuse('recoveryDesignDisagrees', `claims recoveryDesigned ${String(profile.design.recoveryDesigned)} and the case `
      + `allows ${c.execution.maximumAttempts} attempt(s). A case built to observe recovery has to allow a second attempt, `
      + 'and one that allows a second attempt has to say whether that is what it is for.');
  }
  if (profile.design.refusedWrongAnswers.length === 0) {
    refuse('noWrongAnswers', 'names no plausible wrong answer it refuses, so nothing says what it discriminates');
  }
}

/** The lines a preview prints for one discriminator case. One place, so no surface invents its own. */
export function describeWorkspaceStructuralProfile(profile: WorkspaceStructuralProfile, dimensions: WorkspaceDimension[]): string[] {
  const declared = WORKSPACE_DECLARED_DIFFICULTY_AXES
    .map((axis) => `${axis} ${String(profile.declared[axis])}`)
    .join(', ');
  return [
    'tier            none — empirical discriminator family; structure is described, not banded',
    `  pattern       ${profile.design.reasoningPattern}`
      + `${profile.design.generalises === undefined ? '' : ` (generalises the reasoning of ${profile.design.generalises})`}`,
    `  rationale     ${profile.rationale}`,
    `  capabilities  ${dimensions.join(', ')} — declared intent, not evidence`,
    `  recovery      ${profile.design.recoveryDesigned
      ? `designed: attempt 2 is observable when attempt 1 fails (${profile.measured.maximumAttempts} attempts)`
      : 'not designed: one attempt, so this case can never produce recovery evidence'}`,
    `  refuses       ${profile.design.refusedWrongAnswers.join('; ')}`,
    `  measured      fixture ${profile.measured.fixtureFileCount} files `
      + `(${profile.measured.fixtureSourceFileCount} under src/, ${profile.measured.fixtureByteCount} bytes), `
      + `${profile.measured.verificationCommandCount} visible check(s), `
      + `${profile.measured.hiddenCommandCount} hidden, ${profile.measured.fileInvariantCount} invariant(s), `
      + `${profile.measured.maximumAttempts} attempt(s)`,
    `  declared      ${declared}`,
    `  structure     ${workspaceStructuralProfileDigest(profile)}`,
  ];
}
