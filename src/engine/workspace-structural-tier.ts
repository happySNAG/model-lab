// Benchmark engine · a ROUTING TIER for a case that carries no declared tier, DERIVED by the existing bands.
//
// WHY THIS EXISTS. `recommend <task> --tier <n> --contract crr2` asks `routing-contract.ts` for a
// `workspace-tier:<tier>` capability, and the qualification view and the metrics rollup produce one only
// for a run whose case has a difficulty profile. A case of the empirical discriminator family carries an
// untiered STRUCTURAL profile instead (`workspace-discriminator.ts`), so its sealed runs could never count
// toward any tier, however its structure measured.
//
// WHAT IT DOES. For each structural profile, the counts it already carries — the measured half recomputed
// from the sealed case, the declared half cross-checked against it — are put through the tier bands by
// `deriveWorkspaceStructuralTier`, the same floors, ceilings and three-axes rule a declared tier profile
// must pass. Where exactly one band holds, the case gets a difficulty profile at that tier, for routing
// evidence alone. Where none holds, it gets nothing, and a `--tier` query finds no evidence there.
//
// WHAT IT IS NOT, AND EACH OF THESE IS A RULE.
//
//   NOT A HAND-ASSIGNED TIER. No tier is typed anywhere in this file; every one comes out of the bands.
//   NOT A CHANGE TO THE CATALOGUE. The structural profile keeps no tier and `validateWorkspaceStructuralProfile`
//   still refuses one on it. The derived profiles go only to the routing evidence they are handed to.
//   NOT A THRESHOLD. A tier row is judged by the record's own qualification policy (cqp1 unless another is
//   passed), exactly like a declared tier's row.

import {
  WORKSPACE_DIFFICULTY_SCHEMA_VERSION, WorkspaceDifficultyProfile, deriveWorkspaceStructuralTier,
} from './workspace-difficulty';
import { WorkspaceStructuralProfile, workspaceStructuralProfileDigest } from './workspace-discriminator';

/** One structural profile's tier as the bands derive it, or why none was derived. */
export interface WorkspaceStructuralTierReading {
  caseID: string;
  caseVersion: string;
  /** The `cwx1:` claim the counts were read from. */
  structure: string;
  tier?: WorkspaceDifficultyProfile['tier'];
  reasons: string[];
}

export function workspaceStructuralTierReading(profile: WorkspaceStructuralProfile): WorkspaceStructuralTierReading {
  const derived = deriveWorkspaceStructuralTier(profile.measured, profile.declared);
  return {
    caseID: profile.caseID, caseVersion: profile.caseVersion, structure: workspaceStructuralProfileDigest(profile),
    ...(derived.tier === undefined ? {} : { tier: derived.tier }), reasons: derived.reasons,
  };
}

/** A difficulty profile at the DERIVED tier, or `undefined` when the bands derive none. */
export function difficultyProfileFromStructure(profile: WorkspaceStructuralProfile): WorkspaceDifficultyProfile | undefined {
  const reading = workspaceStructuralTierReading(profile);
  if (reading.tier === undefined) return undefined;
  return {
    schemaVersion: WORKSPACE_DIFFICULTY_SCHEMA_VERSION,
    caseID: profile.caseID,
    caseVersion: profile.caseVersion,
    tier: reading.tier,
    rationale: `derived, not declared: ${reading.reasons.join('; ')}, from the structural counts of ${reading.structure}`,
    measured: { ...profile.measured },
    declared: { ...profile.declared },
  };
}

/**
 * The difficulty profiles routing evidence is read with: every declared profile, then a derived one for each
 * structurally profiled case that has no declared profile and whose counts a band holds. A declared tier is
 * never replaced, and a case no band holds is simply absent — never filed under a default.
 */
export function routingDifficultyProfiles(
  declared: WorkspaceDifficultyProfile[], structural: WorkspaceStructuralProfile[],
): WorkspaceDifficultyProfile[] {
  const judged = new Set(declared.map((profile) => profile.caseID));
  const derived = structural
    .filter((profile) => !judged.has(profile.caseID))
    .map(difficultyProfileFromStructure)
    .filter((profile): profile is WorkspaceDifficultyProfile => profile !== undefined);
  return [...declared, ...derived];
}
