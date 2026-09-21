// Benchmark engine · the structural profile and design claim this repository makes about each
// discriminator case.
//
// THE SAME DISCIPLINE AS THE TIER PROFILES, WITHOUT THE TIER. Every count below is defined in
// `workspace-difficulty.ts`, the measured half is recomputed from the sealed case, the three fixture
// figures are checked against the sealed tree and `expectedMinimumEditFiles` against the reference
// solution by `workspace-discriminator.test.ts`. What is different is what the numbers are FOR: they
// describe each case so a reader can see what it demands, and they are deliberately not banded into
// a tier — see the header of `workspace-discriminator.ts`.
//
// `refusedWrongAnswers` names only answers that a scripted test actually writes and actually sees
// refused. It is a list of proofs, not of guesses.

import { allWorkspaceCases } from './workspace-catalog';
import { WorkspaceCase } from './workspace-case';
import {
  WorkspaceStructuralProfile, WorkspaceStructuralProfileInput, makeWorkspaceStructuralProfile,
  validateWorkspaceStructuralProfile,
} from './workspace-discriminator';

/** Built on first use, for the reason `workspace-difficulty-catalog.ts` gives: the two catalogues are a cycle. */
function profileOf(caseID: string, input: WorkspaceStructuralProfileInput): WorkspaceStructuralProfile {
  const found = allWorkspaceCases().find((entry) => entry.id === caseID);
  if (found === undefined) throw new Error(`structural profile for '${caseID}', which this build does not carry`);
  return makeWorkspaceStructuralProfile(found as WorkspaceCase, input);
}

const CONFIG_MIGRATE_PROFILE = (): WorkspaceStructuralProfile => profileOf('ws.d1.config-migrate.upgrade', {
  rationale: 'Four visible defects sit in the rules and can all be fixed there, while the driver rebuilds the file '
    + 'from the keys it knows and the rules default what they cannot read. Passing needs the contract\'s one rule — '
    + 'change what you recognise and nothing else — applied to the driver, the sections and the fallbacks alike.',
  fixtureFileCount: 15,
  fixtureSourceFileCount: 7,
  fixtureByteCount: 16642,
  declared: {
    relevantFileCount: 10,
    expectedMinimumEditFiles: 3,
    dependencyDepth: 4,
    diagnosticDistance: 2,
    architecturalConstraintCount: 3,
    hiddenInvariantCount: 2,
    irrelevantContextFileCount: 2,
    independentDefectCount: 6,
  },
  design: {
    reasoningPattern: 'preserveUnknownDuringTransformation',
    generalises: 'ws.t2.text-normalize.cluster',
    recoveryDesigned: false,
    refusedWrongAnswers: [
      'fix the rules and keep the rebuilding driver',
      'preserve unknown keys but default what cannot be read',
      'rebuild known sections from the fields they know',
    ],
  },
});

const ASSET_CONTAINER_PROFILE = (): WorkspaceStructuralProfile => profileOf('ws.d1.asset-container.retitle', {
  rationale: 'Every visible failure is fixed by repairing the encoder, and the editor still rewrites files through a '
    + 'decoded model with no field for chunks it does not understand. Passing needs the format\'s distinction between '
    + 'reading, which may skip a chunk, and editing, which must copy it.',
  fixtureFileCount: 14,
  fixtureSourceFileCount: 9,
  fixtureByteCount: 17316,
  declared: {
    relevantFileCount: 8,
    expectedMinimumEditFiles: 2,
    dependencyDepth: 3,
    diagnosticDistance: 1,
    architecturalConstraintCount: 3,
    hiddenInvariantCount: 2,
    irrelevantContextFileCount: 4,
    independentDefectCount: 4,
  },
  design: {
    reasoningPattern: 'forwardCompatibleRewrite',
    generalises: 'ws.t2.text-normalize.cluster',
    recoveryDesigned: false,
    refusedWrongAnswers: [
      'repair the encoder and keep editing through the decoded model',
      'let the decoder skip unknown critical chunks so the model round trip succeeds',
      'strip every ancillary chunk when removing notes',
    ],
  },
});

const LOG_REDACT_PROFILE = (): WorkspaceStructuralProfile => profileOf('ws.d1.log-redact.mask', {
  rationale: 'Each leak is most quickly closed by masking more: re-serialising what parses, running the machine-looking '
    + 'heuristic over everything. The policy lists are out of scope, and passing needs masking exactly the two named '
    + 'things while every other byte of every line, parseable or not, passes through.',
  fixtureFileCount: 13,
  fixtureSourceFileCount: 8,
  fixtureByteCount: 12931,
  declared: {
    relevantFileCount: 9,
    expectedMinimumEditFiles: 2,
    dependencyDepth: 2,
    diagnosticDistance: 1,
    architecturalConstraintCount: 2,
    hiddenInvariantCount: 2,
    irrelevantContextFileCount: 3,
    independentDefectCount: 5,
  },
  design: {
    reasoningPattern: 'selectiveTransformationOverCatchAll',
    generalises: 'ws.t2.text-normalize.cluster',
    recoveryDesigned: false,
    refusedWrongAnswers: [
      'recurse and re-serialise every JSON line',
      'run the machine-looking heuristic over JSON values',
      'keep the heuristic on lines that do not parse',
    ],
  },
});

const CATALOG_PAGING_PROFILE = (): WorkspaceStructuralProfile => profileOf('ws.d1.catalog-paging.walk', {
  rationale: 'The order and the cursor each have a defect and each fix alone leaves suites red; the cursor that turns '
    + 'every visible suite green by remembering the last id loses its place when that product is withdrawn. Passing '
    + 'needs a cursor that carries the sort key and resumes with the same comparison the listing sorts by.',
  fixtureFileCount: 15,
  fixtureSourceFileCount: 8,
  fixtureByteCount: 16203,
  declared: {
    relevantFileCount: 11,
    expectedMinimumEditFiles: 3,
    dependencyDepth: 4,
    diagnosticDistance: 3,
    architecturalConstraintCount: 3,
    hiddenInvariantCount: 2,
    irrelevantContextFileCount: 3,
    independentDefectCount: 2,
  },
  design: {
    reasoningPattern: 'interactingInvariants',
    recoveryDesigned: false,
    refusedWrongAnswers: [
      'make the order total and keep the offset cursor',
      'resume after the last product found by id',
      'resume by rank alone',
    ],
  },
});

const QUERY_CODEC_PROFILE = (): WorkspaceStructuralProfile => profileOf('ws.d1.query-codec.nest', {
  rationale: 'The round-trip promise is stated in full, and which edge of it an implementation misses cannot be known '
    + 'before it is checked. The visible suites are examples; the property check prints the first counterexample, '
    + 'which is enough to act on and not enough to fix by special-casing it.',
  fixtureFileCount: 11,
  fixtureSourceFileCount: 6,
  fixtureByteCount: 12029,
  declared: {
    relevantFileCount: 7,
    expectedMinimumEditFiles: 1,
    dependencyDepth: 3,
    diagnosticDistance: 2,
    architecturalConstraintCount: 2,
    hiddenInvariantCount: 1,
    irrelevantContextFileCount: 3,
    independentDefectCount: 1,
  },
  design: {
    reasoningPattern: 'counterexampleDrivenRecovery',
    recoveryDesigned: true,
    refusedWrongAnswers: [
      'read a numeric key as an array index',
      'percent-decode a name before finding its brackets',
      'turn + into a space after decoding',
    ],
  },
});

const TASK_BOARD_PROFILE = (): WorkspaceStructuralProfile => profileOf('ws.d1.task-board.reassign', {
  rationale: 'The natural implementation re-indexes a changed task and passes every visible suite, because the index '
    + 'it calls only ever adds. An integration check reports the stale list concretely; removing the one stale entry '
    + 'it names by hand leaves the count beside it stale.',
  fixtureFileCount: 11,
  fixtureSourceFileCount: 6,
  fixtureByteCount: 14259,
  declared: {
    relevantFileCount: 8,
    expectedMinimumEditFiles: 1,
    dependencyDepth: 2,
    diagnosticDistance: 0,
    architecturalConstraintCount: 2,
    hiddenInvariantCount: 2,
    irrelevantContextFileCount: 1,
    independentDefectCount: 1,
  },
  design: {
    reasoningPattern: 'integrationDrivenRecovery',
    recoveryDesigned: true,
    refusedWrongAnswers: [
      'set the new value and re-index',
      'remove the stale owner entry by hand',
      'validate after changing the task',
    ],
  },
});

const PROFILE_BUILDERS: (() => WorkspaceStructuralProfile)[] = [
  CONFIG_MIGRATE_PROFILE, ASSET_CONTAINER_PROFILE, LOG_REDACT_PROFILE, CATALOG_PAGING_PROFILE,
  QUERY_CODEC_PROFILE, TASK_BOARD_PROFILE,
];

let builtProfiles: WorkspaceStructuralProfile[] | undefined;

/** Every structural profile this build carries, in catalogue order. Built once, on first use. */
export function registeredWorkspaceStructuralProfiles(): WorkspaceStructuralProfile[] {
  if (builtProfiles === undefined) builtProfiles = PROFILE_BUILDERS.map((build) => build());
  return builtProfiles;
}

export function workspaceStructuralProfileFor(
  profiles: WorkspaceStructuralProfile[], caseID: string,
): WorkspaceStructuralProfile | undefined {
  return profiles.find((profile) => profile.caseID === caseID);
}

/** Refuse a structural profile that does not hold up against the case it describes. Called by `validateWorkspaceCatalog`. */
export function validateWorkspaceStructuralCatalogue(): void {
  const cases = allWorkspaceCases();
  const seen = new Set<string>();
  for (const profile of registeredWorkspaceStructuralProfiles()) {
    if (seen.has(profile.caseID)) throw new Error(`two structural profiles for ${profile.caseID}; a case is described once`);
    seen.add(profile.caseID);
    const c = cases.find((entry) => entry.id === profile.caseID);
    if (c === undefined) throw new Error(`structural profile for unknown workspace case ${profile.caseID}`);
    validateWorkspaceStructuralProfile(profile, c);
  }
}
