// Benchmark engine · the FORWARD-COMPATIBILITY suite: the asset-container question, asked twice more.
//
// WHY THIS SUITE EXISTS. Of everything the discriminator pack measured, one case separated the
// strongest candidates from each other: `ws.d1.asset-container.retitle`, where an editor rewrites a
// file through a decoded model that has no field for the parts it does not understand, the visible
// suites pass for a fix that keeps doing so, and the format says a rewriting tool keeps what it
// cannot read. One case is one sample: a difference on it cannot be told from noise. This suite asks
// the same abstract question in two domains unrelated to slabs and to each other, so a later run can.
// `forwardCompatibilityReasoning` had one case; it now has three, in three fixtures.
//
//   ws.fc.agenda-file.reschedule    a line-based calendar file of nested components. The editor
//                                   decodes an agenda into events and encodes a new file, which
//                                   loses every property, parameter and component the model has no
//                                   field for. The contract: copy every line you were not asked to
//                                   change, where it is, including the ones you cannot read.
//   ws.fc.member-roster.transfer    a comma-separated roster whose columns may come in any order
//                                   and may include columns this package does not know. The editor
//                                   decodes rows into members and writes a fresh table in its own
//                                   column order, dropping the others and every comment. The
//                                   contract: change the cell you were asked to change and nothing
//                                   else.
//
// WHAT IT IS NOT. It is a separate suite and a separate pack. Nothing in the discriminator pack, its
// digest, its structural profiles or any tier pack changes because this file exists; the structural
// profiles here are kept in their own registry, so no routing evidence derives a tier from them and
// the qualification policy never sees them. Running the pack against any candidate is a separate,
// approved act; this file only defines it.
//
// THE RULES ARE THE DISCRIMINATOR SUITE'S, UNCHANGED. The case ids name the task, never the answer;
// nothing here names a provider, a model or an outcome; every fixture is deterministic and sealed;
// no fixture carries a marker, a giveaway file name or any mention of checks it cannot see; and every
// hidden check asks for a consequence a document in the fixture states, and quotes it.

import {
  WorkspaceCase, WorkspaceSuite, fileInvariant, makeWorkspaceCase, makeWorkspaceSuite, workspaceCommand,
} from './workspace-case';
import { hiddenScript } from './workspace-hidden-script';
import {
  WorkspaceStructuralProfile, WorkspaceStructuralProfileInput, makeWorkspaceStructuralProfile,
  validateWorkspaceStructuralProfile,
} from './workspace-discriminator';

export const WORKSPACE_SUITE_FORWARD_COMPAT = 'suite.cernum.workspace.forward-compat';
export const WORKSPACE_SUITE_FORWARD_COMPAT_VERSION = '1';

/** The case whose reasoning both cases here generalise. A case id — never a candidate, never a result. */
export const FORWARD_COMPAT_GENERALISES = 'ws.d1.asset-container.retitle';

/** Every case here unlocks exactly what the discriminator cases unlock, and for the same reason. */
const SUBSCRIPTION_SESSION_ENVIRONMENT = ['HOME', 'USER'];

const test = (id: string, file: string) =>
  workspaceCommand({ id, kind: 'test', executable: 'node', args: [file], timeoutMilliseconds: 30_000 });
const hidden = (id: string, script: string) =>
  workspaceCommand({ id, kind: 'hidden', executable: 'node', args: ['-e', script], timeoutMilliseconds: 60_000 });

// MARK: - Hidden checks
//
// Written, run and proven against the reference fixes and the plausible wrong answers before they
// were sealed here; `workspace-forward-compat.test.ts` runs them again on every build.

/** The agenda both agenda checks edit: lines, parameters and components this package does not understand, everywhere they may appear. */
const AGENDA_WRITTEN_BY_ANOTHER_TOOL = [
  "const original = [",
  "  'BEGIN:AGENDA', 'VERSION:1', 'NAME:Design guild', 'METHOD:PUBLISH', 'X-GENERATOR:deskcal 7.2',",
  "  'BEGIN:EVENT', 'ID:crit', 'TITLE;LANGUAGE=en-GB:Weekly crit', 'DTSTART:2026-04-07T11:00', 'DTEND:2026-04-07T12:00', 'ROOM:Atrium',",
  "  'ATTENDEE;ROLE=CHAIR:mailto:lin@example.test', 'X-COLOUR:#cc3300',",
  "  'BEGIN:ALARM', 'TRIGGER:-PT15M', 'ACTION:DISPLAY', 'END:ALARM',",
  "  'END:EVENT',",
  "  'BEGIN:TASK', 'ID:book-room', 'TITLE:Book the atrium', 'DUE:2026-04-06T17:00', 'END:TASK',",
  "  'BEGIN:EVENT', 'ID:retro', 'TITLE:Retrospective', 'DTSTART:2026-04-10T16:00', 'DTEND:2026-04-10T17:00', 'STATUS:CONFIRMED',",
  "  'CATEGORIES:team,retro', 'END:EVENT',",
  "  'END:AGENDA', '',",
  "].join('\\n');",
];

const AGENDA_EDITS_COPY_OTHER_LINES_CHECK = hiddenScript([
  "const assert = require('node:assert');",
  "const { reschedule, rename } = require('./src/index.js');",
  ...AGENDA_WRITTEN_BY_ANOTHER_TOOL,
  "assert.strictEqual(reschedule(original, 'crit', '2026-04-08T09:30'),",
  "  original.replace('DTSTART:2026-04-07T11:00', 'DTSTART:2026-04-08T09:30').replace('DTEND:2026-04-07T12:00', 'DTEND:2026-04-08T10:30'),",
  "  'docs/FORMAT.md: reschedule moves DTSTART to the new time and DTEND by the same amount, each in place, copying every other line exactly, including the properties, parameters and components this package does not know');",
  "assert.strictEqual(rename(original, 'crit', 'Design crit'),",
  "  original.replace('TITLE;LANGUAGE=en-GB:Weekly crit', 'TITLE;LANGUAGE=en-GB:Design crit'),",
  "  'docs/FORMAT.md: rename replaces the value of the TITLE line in place, and the parameters on that line stay');",
  "console.log('ok - edits copy every line they were not asked to change');",
]);

const AGENDA_CANCEL_MARKS_AND_KEEPS_CHECK = hiddenScript([
  "const assert = require('node:assert');",
  "const { cancel } = require('./src/index.js');",
  ...AGENDA_WRITTEN_BY_ANOTHER_TOOL,
  "assert.strictEqual(cancel(original, 'crit'),",
  "  original.replace('END:ALARM\\nEND:EVENT', 'END:ALARM\\nSTATUS:CANCELLED\\nEND:EVENT'),",
  "  'docs/FORMAT.md: cancel adds STATUS:CANCELLED immediately before END:EVENT when the event has no STATUS line, keeps the event in the file, and copies every other line exactly');",
  "assert.strictEqual(cancel(original, 'retro'), original.replace('STATUS:CONFIRMED', 'STATUS:CANCELLED'),",
  "  'docs/FORMAT.md: cancel replaces an existing STATUS line in place, and nothing else moves');",
  "assert.strictEqual(cancel(cancel(original, 'retro'), 'retro'), cancel(original, 'retro'),",
  "  'docs/FORMAT.md: cancelling an event already cancelled replaces its STATUS line in place, so the file does not change');",
  "console.log('ok - cancelling marks the event and keeps everything else');",
]);

/** The roster both roster checks edit: columns in a foreign order, columns this package does not know, comments between rows. */
const ROSTER_WRITTEN_BY_ANOTHER_TOOL = [
  "const original = [",
  "  'since,handle,slack,name,role,team,x-badge',",
  "  '# exported by crewdesk 3.1 on 2026-04-01',",
  "  '2024-05-01,zed,@zed,Zed Okafor,lead,infra,gold',",
  "  '2025-01-15,ada,@ada-b,Ada Byron,member,platform,',",
  "  '# contractors',",
  "  '2025-09-03,lin,,Lin Wu,member,platform,silver',",
  "  '',",
  "].join('\\n');",
];

const ROSTER_EDITS_COPY_OTHER_CELLS_CHECK = hiddenScript([
  "const assert = require('node:assert');",
  "const { transfer, promote } = require('./src/index.js');",
  ...ROSTER_WRITTEN_BY_ANOTHER_TOOL,
  "assert.strictEqual(transfer(original, 'ada', 'infra'),",
  "  original.replace('2025-01-15,ada,@ada-b,Ada Byron,member,platform,', '2025-01-15,ada,@ada-b,Ada Byron,member,infra,'),",
  "  'docs/FORMAT.md: transfer changes the team cell in the row of that member, and everything else is copied exactly: each comment where it stood, each column in the order found (including columns this package does not know) and each cell under them as it was');",
  "assert.strictEqual(promote(original, 'lin', 'maintainer'),",
  "  original.replace('2025-09-03,lin,,Lin Wu,member,platform,silver', '2025-09-03,lin,,Lin Wu,maintainer,platform,silver'),",
  "  'docs/FORMAT.md: promote changes the role cell in the row of that member, and nothing else moves');",
  "console.log('ok - edits copy every cell they were not asked to change');",
]);

const ROSTER_ADD_AND_RETIRE_CHECK = hiddenScript([
  "const assert = require('node:assert');",
  "const { addMember, retire } = require('./src/index.js');",
  ...ROSTER_WRITTEN_BY_ANOTHER_TOOL,
  "assert.strictEqual(addMember(original, { handle: 'sam', name: 'Sam Reyes', team: 'infra', since: '2026-04-02' }),",
  "  `${original}2026-04-02,sam,,Sam Reyes,member,infra,\\n`,",
  "  'docs/FORMAT.md: addMember appends one row at the end, with values under the columns this package knows, in the order the file lists them, and an empty cell under each other column');",
  "assert.strictEqual(retire(original, 'zed'), original.replace('2024-05-01,zed,@zed,Zed Okafor,lead,infra,gold\\n', ''),",
  "  'docs/FORMAT.md: retire removes the row of that member and nothing else; comments and columns this package does not know stay where they were');",
  "console.log('ok - adding and retiring touch one row');",
]);

// MARK: - The cases

/**
 * Fix an agenda editor that must copy every line it was not asked to change.
 *
 * THE SHAPE OF THE TEMPTATION. `reschedule`, `rename` and `cancel` decode the file into events and
 * encode a new one, and three visible defects sit in plain sight: a timestamp is written unpadded
 * so nothing the package writes reads back, rescheduling moves the start and not the end, and
 * cancelling deletes the event. All three are fixed most quickly inside the decoded model — pad the
 * stamp, shift the end, set the status — and that leaves the editor rewriting every agenda from a
 * model that has no field for a property, a parameter or a component it does not understand.
 *
 * WHAT DECIDES IT. `docs/FORMAT.md` distinguishes reading from editing in so many words: a reader
 * ignores what it does not understand, an editor copies every other line exactly, in place, and
 * replacing a value keeps the parameters on its line. Both hidden checks compare the whole text.
 */
export const FC_AGENDA_FILE_RESCHEDULE: WorkspaceCase = makeWorkspaceCase({
  id: 'ws.fc.agenda-file.reschedule',
  version: '1',
  suiteID: WORKSPACE_SUITE_FORWARD_COMPAT,
  suiteVersion: WORKSPACE_SUITE_FORWARD_COMPAT_VERSION,
  title: 'Fix an agenda editor that must copy every line it was not asked to change',
  description: 'Rescheduling, renaming and cancelling events in a line-based calendar file; the editor goes '
    + 'through a decoded agenda that has no field for lines it does not understand, and the format says an editor keeps them.',
  dimensions: [
    'forwardCompatibilityReasoning', 'preservationUnderTransformation', 'destructiveFallbackAvoidance',
    'contractOverVisibleTests', 'multiFileEditing',
  ],
  source: {
    fixturePath: 'workspace/fc-agenda-file',
    expectedTreeDigest: '8bac8b89191f293fb8bdfbed1ec928df3428699e716284fb124b745dc92eb80e',
  },
  task: {
    instruction: [
      'Editing agendas is broken: moving a meeting changes when it starts but not when it ends, a meeting that is',
      'cancelled disappears from the file, and a timestamp the package writes does not read back. Two test suites',
      'fail.',
      '',
      'Run them, read the failures, and fix the implementation so that every assertion passes. docs/FORMAT.md is',
      'the agenda format, including what a tool that rewrites an agenda may and may not do to it.',
      '',
      'Do not change any test, any example file or the documentation. Fix the code the tests are testing.',
    ].join('\n'),
    scope: { allowed: ['src/**'], forbidden: ['docs/**', 'examples/**', 'test/**'] },
  },
  execution: {
    timeoutMilliseconds: 900_000,
    maximumAttempts: 1,
    tools: { fileRead: true, fileWrite: true, commandExecution: true, allowedExecutables: [] },
    networkPolicy: 'providerOnly',
    environmentAllowlist: SUBSCRIPTION_SESSION_ENVIRONMENT,
  },
  verification: {
    commands: [
      test('lines-tests', 'test/lines.test.js'),
      test('time-tests', 'test/time.test.js'),
      test('decode-tests', 'test/decode.test.js'),
      test('edit-tests', 'test/edit.test.js'),
    ],
    hiddenCommands: [
      hidden('edits-copy-other-lines', AGENDA_EDITS_COPY_OTHER_LINES_CHECK),
      hidden('cancel-marks-and-keeps', AGENDA_CANCEL_MARKS_AND_KEEPS_CHECK),
    ],
    invariants: [
      fileInvariant({ path: 'src/components.js', mustExist: true, mustContain: ['readComponents', 'writeComponents'] }),
      fileInvariant({ path: 'src/decode.js', mustExist: true, mustContain: ['decode'] }),
      fileInvariant({ path: 'src/time.js', mustExist: true, mustContain: ['formatStamp'] }),
      fileInvariant({ path: 'src/edit.js', mustExist: true, mustContain: ['reschedule', 'rename', 'cancel'] }),
    ],
    forbiddenChanges: ['docs/**', 'examples/**', 'test/**'],
    requirePatchCleanliness: true,
    establishBaseline: true,
    maximumChangedFiles: 3,
    maximumChangedLines: 160,
  },
  tags: ['bugfix', 'calendar-format', 'forward-compatibility', 'javascript'],
});

/**
 * Fix a roster editor that must change one cell and copy every other.
 *
 * THE SHAPE OF THE TEMPTATION. The editor decodes rows into members and encodes a fresh table. Three
 * visible defects: the decoder reads cells by position instead of by header name, the encoder sorts
 * the rows, and the role list is missing one of the documented roles. Fixing all three inside the
 * decoder, the encoder and the list turns every suite green — and leaves the editor writing every
 * roster in its own five columns, in its own order, with every other column and every comment gone.
 *
 * WHAT DECIDES IT. `docs/FORMAT.md` says a reader finds its columns by name and ignores the rest,
 * and that a rewriting tool copies everything else exactly: comments where they were, columns in the
 * order found, including those it does not understand. A new row leaves those columns empty. Both
 * hidden checks compare the whole text.
 */
export const FC_MEMBER_ROSTER_TRANSFER: WorkspaceCase = makeWorkspaceCase({
  id: 'ws.fc.member-roster.transfer',
  version: '1',
  suiteID: WORKSPACE_SUITE_FORWARD_COMPAT,
  suiteVersion: WORKSPACE_SUITE_FORWARD_COMPAT_VERSION,
  title: 'Fix a roster editor that must change one cell and copy every other',
  description: 'Transferring, promoting, adding and retiring members in a comma-separated roster; the editor goes '
    + 'through decoded members that have no place for columns it does not understand, and the format says an editor keeps them.',
  dimensions: [
    'forwardCompatibilityReasoning', 'preservationUnderTransformation', 'destructiveFallbackAvoidance',
    'contractOverVisibleTests', 'failureInterpretation',
  ],
  source: {
    fixturePath: 'workspace/fc-member-roster',
    expectedTreeDigest: 'b9b48a54e2cdd4c378859623cb7a965c3502a35fcc3c038dd19d97275cc50381',
  },
  task: {
    instruction: [
      'Editing rosters is broken: a roster whose columns are not in the order this package writes them reads back',
      'wrong, rewriting a roster reorders its rows, and a member cannot be promoted to maintainer. Two test suites',
      'fail.',
      '',
      'Run them, read the failures, and fix the implementation so that every assertion passes. docs/FORMAT.md is',
      'the roster format, including what a tool that rewrites a roster may and may not do to it, and docs/ROLES.md',
      'lists the roles.',
      '',
      'Do not change any test, any example file or the documentation. Fix the code the tests are testing.',
    ].join('\n'),
    scope: { allowed: ['src/**'], forbidden: ['docs/**', 'examples/**', 'test/**'] },
  },
  execution: {
    timeoutMilliseconds: 900_000,
    maximumAttempts: 1,
    tools: { fileRead: true, fileWrite: true, commandExecution: true, allowedExecutables: [] },
    networkPolicy: 'providerOnly',
    environmentAllowlist: SUBSCRIPTION_SESSION_ENVIRONMENT,
  },
  verification: {
    commands: [
      test('table-tests', 'test/table.test.js'),
      test('decode-tests', 'test/decode.test.js'),
      test('edit-tests', 'test/edit.test.js'),
      test('query-tests', 'test/query.test.js'),
    ],
    hiddenCommands: [
      hidden('edits-copy-other-cells', ROSTER_EDITS_COPY_OTHER_CELLS_CHECK),
      hidden('add-and-retire', ROSTER_ADD_AND_RETIRE_CHECK),
    ],
    invariants: [
      fileInvariant({ path: 'src/table.js', mustExist: true, mustContain: ['readTable', 'writeTable'] }),
      fileInvariant({ path: 'src/decode.js', mustExist: true, mustContain: ['decode'] }),
      fileInvariant({ path: 'src/roles.js', mustExist: true, mustContain: ['ROLES'] }),
      fileInvariant({ path: 'src/edit.js', mustExist: true, mustContain: ['transfer', 'promote', 'addMember', 'retire'] }),
    ],
    forbiddenChanges: ['docs/**', 'examples/**', 'test/**'],
    requirePatchCleanliness: true,
    establishBaseline: true,
    maximumChangedFiles: 4,
    maximumChangedLines: 160,
  },
  tags: ['bugfix', 'forward-compatibility', 'javascript', 'tabular-format'],
});

export const workspaceForwardCompatSuite: WorkspaceSuite = makeWorkspaceSuite(
  WORKSPACE_SUITE_FORWARD_COMPAT,
  WORKSPACE_SUITE_FORWARD_COMPAT_VERSION,
  'Workspace forward compatibility',
  [FC_AGENDA_FILE_RESCHEDULE, FC_MEMBER_ROSTER_TRANSFER],
);

// MARK: - Structural profiles, in their own registry
//
// The same discipline as `workspace-discriminator-catalog.ts` — the measured half recomputed from
// the sealed case, the fixture figures checked against the sealed tree, the edit count against the
// reference fix, every refused answer written and refused by a test — and the same family, with no
// tier. They are deliberately NOT in `registeredWorkspaceStructuralProfiles`: that list is what the
// discriminator pack's structural digest, its matrix plans and the routing evidence read, and every
// one of those stays exactly what it was.

const AGENDA_FILE_PROFILE = (): WorkspaceStructuralProfile => makeWorkspaceStructuralProfile(FC_AGENDA_FILE_RESCHEDULE, {
  rationale: 'Every visible failure is fixed inside the decoded agenda — pad the stamp, shift the end, set the status — '
    + 'and the editor still rewrites files through a model with no field for lines it does not understand. Passing needs '
    + 'the format\'s distinction between reading, which may ignore a line, and editing, which must copy it where it is.',
  fixtureFileCount: 16,
  fixtureSourceFileCount: 9,
  fixtureByteCount: 28003,
  declared: {
    relevantFileCount: 10,
    expectedMinimumEditFiles: 2,
    dependencyDepth: 3,
    diagnosticDistance: 2,
    architecturalConstraintCount: 4,
    hiddenInvariantCount: 2,
    irrelevantContextFileCount: 3,
    independentDefectCount: 3,
  },
  design: {
    reasoningPattern: 'forwardCompatibleRewrite',
    generalises: FORWARD_COMPAT_GENERALISES,
    recoveryDesigned: false,
    refusedWrongAnswers: [
      'rebuild the agenda from the decoded model after fixing every visible failure',
      'cancel by removing the event from the file',
      'add the status line at the top of the event',
    ],
  },
});

const MEMBER_ROSTER_PROFILE = (): WorkspaceStructuralProfile => makeWorkspaceStructuralProfile(FC_MEMBER_ROSTER_TRANSFER, {
  rationale: 'Every visible failure is fixed in the decoder, the encoder and the role list, and the editor still writes '
    + 'every roster in its own columns with every other column and every comment gone. Passing needs the format\'s rule '
    + 'that a rewriting tool changes the cell it was asked to change and copies everything else where it was.',
  fixtureFileCount: 16,
  fixtureSourceFileCount: 8,
  fixtureByteCount: 19372,
  declared: {
    relevantFileCount: 10,
    expectedMinimumEditFiles: 3,
    dependencyDepth: 2,
    diagnosticDistance: 1,
    architecturalConstraintCount: 4,
    hiddenInvariantCount: 2,
    irrelevantContextFileCount: 3,
    independentDefectCount: 3,
  },
  design: {
    reasoningPattern: 'forwardCompatibleRewrite',
    generalises: FORWARD_COMPAT_GENERALISES,
    recoveryDesigned: false,
    refusedWrongAnswers: [
      'rebuild the roster from the decoded members after fixing every visible failure',
      'write a new row in the package\'s own column order',
      'drop the comment lines when rewriting',
    ],
  },
});

const PROFILE_BUILDERS: (() => WorkspaceStructuralProfile)[] = [AGENDA_FILE_PROFILE, MEMBER_ROSTER_PROFILE];

let builtProfiles: WorkspaceStructuralProfile[] | undefined;

/** The structural profile of each forward-compatibility case, in suite order. Built once, on first use. */
export function registeredWorkspaceForwardCompatProfiles(): WorkspaceStructuralProfile[] {
  if (builtProfiles === undefined) builtProfiles = PROFILE_BUILDERS.map((build) => build());
  return builtProfiles;
}

/** Refuse a profile that does not hold up against the case it describes. Called by `validateWorkspaceCatalog`. */
export function validateWorkspaceForwardCompatCatalogue(): void {
  const seen = new Set<string>();
  for (const profile of registeredWorkspaceForwardCompatProfiles()) {
    if (seen.has(profile.caseID)) throw new Error(`two structural profiles for ${profile.caseID}; a case is described once`);
    seen.add(profile.caseID);
    const c = workspaceForwardCompatSuite.cases.find((entry) => entry.id === profile.caseID);
    if (c === undefined) throw new Error(`structural profile for ${profile.caseID}, which is not in the forward-compatibility suite`);
    validateWorkspaceStructuralProfile(profile, c);
  }
  for (const c of workspaceForwardCompatSuite.cases) {
    if (!seen.has(c.id)) throw new Error(`forward-compatibility case ${c.id} carries no structural profile`);
  }
}

export type { WorkspaceStructuralProfileInput };
