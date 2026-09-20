// Benchmark engine · the sealed workspace suites, and the one place a case's text lives.
//
// A workspace case is DATA, exactly as a prose case is: it is defined here once, sealed by
// `workspaceCaseDigest`, and every result that mentions it carries that digest. Nothing composes a
// task at run time, nothing templates an instruction, and no surface has its own copy of one — for
// the same reason `src/core/catalog.ts` holds the prose suites and the engine only projects them.
//
// SEALING A FIXTURE IS A DELIBERATE ACT. `expectedTreeDigest` is the SHA-256 of the fixture's
// content-addressed listing, and a case carrying one refuses to run against any other tree. Editing
// a fixture therefore breaks its case loudly, at the fixture check, before a request is sent —
// which is the whole point. `scripts/` has no generator for these on purpose: a digest that a script
// refreshes is a digest that silently follows whatever the tree became.

import {
  WorkspaceCase, WorkspaceSuite, makeWorkspaceCase, makeWorkspaceSuite, validateWorkspaceSuite, workspaceCommand,
  fileInvariant,
} from './workspace-case';

export const WORKSPACE_SUITE_FOUNDATION = 'suite.cernum.workspace.foundation';
export const WORKSPACE_SUITE_FOUNDATION_VERSION = '1';

/**
 * Fix a one-line arithmetic bug, with the failing test named and the test file off limits.
 *
 * WHY THIS IS THE FIRST CASE. It is the smallest task that still needs every capability the prose
 * benchmark cannot see: the model has to find the defect from a failing assertion rather than from
 * the instruction, change the implementation rather than the assertion, run something, and stop.
 * The test file is forbidden, so the shortest path to a green run — edit the expectation — is a
 * `scopeFailure` rather than a pass, and `mean` is reachable from `sum`, so a change that breaks
 * `sum` to make `mean` look right is a regression the baseline reading catches.
 */
export const BROKEN_SUM_MEAN: WorkspaceCase = makeWorkspaceCase({
  id: 'ws.broken-sum.mean',
  // 3 — `environmentAllowlist: ['HOME', 'USER']`. Version 1 unlocked nothing, because the only driver
  // that had ever run this case was the scripted one, which needs no session. A real subscription
  // CLI does. Version 2 unlocked `HOME` on the assumption that a home directory was what `claude`
  // needed to find its session; the first live run disproved it, failing with `Not logged in` before
  // it sent anything, and a zero-cost `claude auth status` probe showed that `USER` is the name that
  // actually matters — the OAuth token is read from the macOS Keychain by an account name taken from
  // it. See `ENVIRONMENT_NAMES_A_CASE_MAY_UNLOCK` for the full reading, including the finding that
  // withholding `HOME` does not withhold the home directory on this platform.
  //
  // Both are asked for BY NAME, here, where a reader sees them — and `workspaceComparabilityKey`
  // names `environmentAllowlist` explicitly, so a result produced with them can never be merged with
  // one produced without. Nothing injects either behind the case: a driver that needed one and did
  // not find it in the frozen allow-list fails to authenticate, loudly, which is exactly what
  // happened and is why this version exists.
  version: '3',
  suiteID: WORKSPACE_SUITE_FOUNDATION,
  suiteVersion: WORKSPACE_SUITE_FOUNDATION_VERSION,
  title: 'Fix the arithmetic mean without touching its test',
  description: 'A one-line defect in a two-function module, found from a failing assertion and fixed in place.',
  dimensions: ['repositoryComprehension', 'fileLocation', 'failureInterpretation', 'regressionAvoidance', 'scopeDiscipline'],
  source: {
    fixturePath: 'workspace/broken-sum',
    // Filled in by sealing the fixture; see the header. `sealed` is derived from its presence.
    expectedTreeDigest: 'e8b6fd5c963dbe6ff6da5b0e68ad68799abf8947e6b7b88c6ddfacf5077aab0b',
  },
  task: {
    instruction: [
      'The test suite in this repository fails. Run it, read the failures, and fix the implementation so that every',
      'assertion passes.',
      '',
      'Do not change any test. Do not change what the tests assert. Fix the code they are testing.',
    ].join('\n'),
    scope: {
      allowed: ['src/**'],
      forbidden: ['test/**'],
    },
  },
  execution: {
    timeoutMilliseconds: 600_000,
    maximumAttempts: 2,
    tools: { fileRead: true, fileWrite: true, commandExecution: true, allowedExecutables: [] },
    networkPolicy: 'providerOnly',
    // The two names a case may unlock, and the whole reason `ENVIRONMENT_NAMES_A_CASE_MAY_UNLOCK`
    // exists. `USER` is the one that makes the subscription session reachable; `HOME` is stated
    // because this case means to be explicit about it, not because withholding it would be a
    // control. See `WORKSPACE_ENVIRONMENT_IS_NOT_A_SANDBOX` and the note on that constant.
    environmentAllowlist: ['HOME', 'USER'],
  },
  verification: {
    commands: [
      workspaceCommand({ id: 'stats-tests', kind: 'test', executable: 'node', args: ['test/stats.test.js'], timeoutMilliseconds: 30_000 }),
    ],
    invariants: [
      // The bug's own shape, named directly: a fix that leaves `length + 1` in place did not fix it,
      // whatever else it did to make the assertions pass.
      fileInvariant({ path: 'src/stats.js', mustExist: true, mustNotContain: ['values.length + 1'] }),
    ],
    forbiddenChanges: ['test/**'],
    requirePatchCleanliness: true,
    establishBaseline: true,
    maximumChangedFiles: 2,
    maximumChangedLines: 40,
  },
  tags: ['bugfix', 'javascript', 'single-file'],
});

export const workspaceFoundationSuite: WorkspaceSuite = makeWorkspaceSuite(
  WORKSPACE_SUITE_FOUNDATION,
  WORKSPACE_SUITE_FOUNDATION_VERSION,
  'Workspace foundation',
  [BROKEN_SUM_MEAN],
);

export const registeredWorkspaceSuites: WorkspaceSuite[] = [workspaceFoundationSuite];

export function workspaceSuiteByID(id: string): WorkspaceSuite | undefined {
  return registeredWorkspaceSuites.find((suite) => suite.id === id);
}

export function allWorkspaceCases(): WorkspaceCase[] {
  return registeredWorkspaceSuites.flatMap((suite) => suite.cases);
}

/** Fail-closed at import time is too eager; callers validate before planning, exactly as the core does. */
export function validateWorkspaceCatalog(): void {
  for (const suite of registeredWorkspaceSuites) validateWorkspaceSuite(suite);
}
