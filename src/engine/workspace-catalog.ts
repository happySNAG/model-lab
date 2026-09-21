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
  RECOVERY_WEIGHTED_WORKSPACE_SCORING_POLICY, WorkspaceCase, WorkspaceSuite, makeWorkspaceCase, makeWorkspaceSuite,
  validateWorkspaceSuite, workspaceCommand, fileInvariant,
} from './workspace-case';
import {
  WorkspaceBenchmarkPack, makeWorkspaceBenchmarkPack, validateWorkspaceBenchmarkPack,
} from './workspace-pack';
import { hiddenScript } from './workspace-hidden-script';
import { workspaceTierTwoSuite } from './workspace-catalog-tier-two';
import { workspaceTierThreeSuite } from './workspace-catalog-tier-three';
import { validateWorkspaceDifficultyCatalogue } from './workspace-difficulty-catalog';

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


// MARK: - A hidden check is a `node -e` script, not a file in the tree
//
// `workspace-hidden-script.ts` says why, once, for every case in this catalogue.

/** An old record, written before `priority` existed, must still load — `docs/FORMAT.md` says so. */
const TASK_PRIORITY_LEGACY_RECORD_CHECK = hiddenScript([
  "const assert = require('node:assert');",
  "const { DEFAULT_PRIORITY } = require('./src/task.js');",
  "const { fromWire, toWire } = require('./src/wire.js');",
  "const legacy = fromWire({ i: 'a', t: 'Written before priority existed', d: false });",
  "assert.strictEqual(legacy.priority, DEFAULT_PRIORITY,",
  "  'a record carrying no p must read back as the default priority, not as undefined');",
  "assert.strictEqual(toWire(legacy).p, DEFAULT_PRIORITY,",
  "  'and writing that task back out must produce a record that carries the key');",
  "console.log('ok - an old record without p still loads');",
]);

/** The defect the visible failure is a symptom of, asked of the parser directly. */
const RECEIPT_SIGN_CHECK = hiddenScript([
  "const assert = require('node:assert');",
  "const { parseLine } = require('./src/parse.js');",
  "assert.strictEqual(parseLine('Refund: -$5.00').amountCents, -500,",
  "  'a refund line must parse to a negative number of cents');",
  "assert.strictEqual(parseLine('Coffee: $4.25').amountCents, 425,",
  "  'and an ordinary line must still parse as it did before');",
  "console.log('ok - the parser reads the sign');",
]);

/** The second and third consequences of the rule README.md states, which the visible tests do not check. */
const REGISTRY_SHARED_OPTIONS_CHECK = hiddenScript([
  "const assert = require('node:assert');",
  "const { DEFAULT_OPTIONS, createRegistry, register, namesOf } = require('./src/registry.js');",
  "const shared = { label: 'plugins', entries: [] };",
  "const first = createRegistry(shared);",
  "const second = createRegistry(shared);",
  "register(first, 'alpha');",
  "assert.deepStrictEqual(namesOf(second), [],",
  "  'two registries built from one options object must not share entries');",
  "assert.deepStrictEqual(shared.entries, [],",
  "  'and registering must not write into the caller\\'s options object');",
  "assert.deepStrictEqual(namesOf(first), ['alpha']);",
  "assert.deepStrictEqual(DEFAULT_OPTIONS.entries, []);",
  "console.log('ok - a registry owns its entries');",
]);

// MARK: - The cases

/**
 * Propagate one new field through a core model, a storage adapter and a public API.
 *
 * WHY THIS CASE EXISTS. `broken-sum` is one line in one file: it measures whether a model can read a
 * failing assertion and stop. It cannot measure the thing that separates models on real work, which
 * is holding three layers of a repository in mind at once. Here a field has to be added to the
 * constructor, carried through the wire format under the key `docs/FORMAT.md` already names, and
 * surfaced by the public rendering — and the three suites fail independently, so a change to one
 * file leaves the other two red. There is no search-and-replace that passes this: the three edits
 * are three different shapes.
 *
 * NOTHING HERE IS A DESIGN DECISION. The field name, the vocabulary, the default, the wire key and
 * the exact rendering are all pinned by assertions the model can read, and the one thing the visible
 * tests do NOT state — what a record written before the field existed must read back as — is stated
 * in `docs/FORMAT.md`, in the repository, where a model that reads before it writes will find it.
 * The hidden check asks for exactly that and nothing else.
 */
export const TASK_PRIORITY_PROPAGATE: WorkspaceCase = makeWorkspaceCase({
  id: 'ws.task-priority.propagate',
  version: '1',
  suiteID: WORKSPACE_SUITE_FOUNDATION,
  suiteVersion: WORKSPACE_SUITE_FOUNDATION_VERSION,
  title: 'Carry a new field through the model, the wire format and the public API',
  description: 'One field, three layers, three suites that fail independently — and a documented '
    + 'backward-compatibility rule the visible tests never mention.',
  dimensions: ['repositoryComprehension', 'multiFileEditing', 'toolUse', 'regressionAvoidance'],
  source: {
    fixturePath: 'workspace/task-priority',
    expectedTreeDigest: '6a6116a915ae60e32e33e006d32f6bb8b3fa7ee6f0562c49e2bbd6cdf13ab5d7',
  },
  task: {
    instruction: [
      'This package stores tasks. It needs a `priority` field. The test suite already describes exactly what that',
      'means: run it, read the failures, and implement what they ask for.',
      '',
      'Before you change the storage layer, read docs/FORMAT.md. It says what a reader of an OLD record — one written',
      'before this field existed — must still get, and that is a separate question from what a new record carries.',
      '',
      'Do not change any test. Do not change what the tests assert. Fix the code they are testing.',
    ].join('\n'),
    // Deliberately no `briefingPaths`: finding the three layers is part of what this case measures.
    scope: {
      allowed: ['src/**'],
      forbidden: ['test/**'],
    },
  },
  execution: {
    timeoutMilliseconds: 600_000,
    // ONE ATTEMPT. This case measures whether a model can hold a repository in mind, not whether it
    // can recover — `ws.registry-isolation.recover` measures that, and measuring both here would
    // make neither reading clean. `firstAttempt` is therefore recorded as unavailable rather than
    // as a perfect score nobody was tested on.
    maximumAttempts: 1,
    tools: { fileRead: true, fileWrite: true, commandExecution: true, allowedExecutables: [] },
    networkPolicy: 'providerOnly',
    environmentAllowlist: ['HOME', 'USER'],
  },
  verification: {
    commands: [
      workspaceCommand({ id: 'core-tests', kind: 'test', executable: 'node', args: ['test/core.test.js'], timeoutMilliseconds: 30_000 }),
      workspaceCommand({ id: 'wire-tests', kind: 'test', executable: 'node', args: ['test/wire.test.js'], timeoutMilliseconds: 30_000 }),
      workspaceCommand({ id: 'api-tests', kind: 'test', executable: 'node', args: ['test/api.test.js'], timeoutMilliseconds: 30_000 }),
    ],
    hiddenCommands: [
      workspaceCommand({ id: 'legacy-record', kind: 'hidden', executable: 'node',
        args: ['-e', TASK_PRIORITY_LEGACY_RECORD_CHECK], timeoutMilliseconds: 30_000 }),
    ],
    invariants: [
      // THE THREE LAYERS MUST STILL BE THREE LAYERS. With a three-file change ceiling, the cheapest
      // way to make every suite green is to collapse the package into one file and re-export it,
      // which passes every assertion and destroys the thing the case is about.
      fileInvariant({ path: 'src/task.js', mustExist: true, mustContain: ['PRIORITIES'] }),
      fileInvariant({ path: 'src/wire.js', mustExist: true, mustContain: ['toWire', 'fromWire'] }),
      fileInvariant({ path: 'src/index.js', mustExist: true, mustContain: ['describeTask'] }),
    ],
    forbiddenChanges: ['test/**'],
    requirePatchCleanliness: true,
    establishBaseline: true,
    maximumChangedFiles: 3,
    maximumChangedLines: 120,
  },
  tags: ['feature', 'javascript', 'multi-file'],
});

/**
 * A wrong total on the report, whose cause is in the parser two layers down.
 *
 * WHY THIS CASE EXISTS. Every case above names the defect where it is felt. This one names it where
 * a USER feels it — "a receipt with a refund on it reports the wrong total" — and the line to change
 * is in neither the test nor the file the failure points at. The parser drops the minus sign, so the
 * refund is added instead of subtracted, and by the time `report.js` sees a record the sign is gone.
 *
 * THE SUPERFICIAL FIX IS THE ONE WORTH MEASURING. Patching the totals layer to special-case a line
 * that looks like a refund makes the visible suite green — the third visible check, which uses a
 * refund named something else entirely, is there so the laziest version of that fix fails in plain
 * sight. The version that re-reads the original text in `report.js` passes everything visible and is
 * caught by the hidden check, which asks the parser directly what it made of one line. A pass on
 * this case means the model found the cause; it cannot be reached by making the symptom go away.
 */
export const RECEIPT_REFUNDS_SIGN: WorkspaceCase = makeWorkspaceCase({
  id: 'ws.receipt-refunds.sign',
  version: '1',
  suiteID: WORKSPACE_SUITE_FOUNDATION,
  suiteVersion: WORKSPACE_SUITE_FOUNDATION_VERSION,
  title: 'Find why a refund makes the receipt total wrong',
  description: 'The symptom is a failing report assertion; the defect is in the parser, and a fix at '
    + 'the reporting layer passes the visible suite and fails the hidden one.',
  dimensions: ['failureInterpretation', 'fileLocation', 'repositoryComprehension', 'regressionAvoidance'],
  source: {
    fixturePath: 'workspace/receipt-refunds',
    expectedTreeDigest: '44219dd743c4d2d2a87559a7c7387ad836315d226618c7930edde40c19171d6b',
  },
  task: {
    instruction: [
      'A receipt that contains a refund reports the wrong total: the refund is ADDED to the bill instead of taken off',
      'it. A receipt with no refund on it reports the right total, and the sums and formatting are right when values',
      'are handed to them directly.',
      '',
      'Run the test suite, work out what is actually wrong, and fix it.',
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
    // ONE ATTEMPT, and deliberately. What this case measures is whether the first diagnosis was the
    // right one; a second go after being shown the hidden check's output would measure something
    // else, and that something else already has a case of its own.
    maximumAttempts: 1,
    tools: { fileRead: true, fileWrite: true, commandExecution: true, allowedExecutables: [] },
    networkPolicy: 'providerOnly',
    environmentAllowlist: ['HOME', 'USER'],
  },
  verification: {
    commands: [
      workspaceCommand({ id: 'report-tests', kind: 'test', executable: 'node', args: ['test/report.test.js'], timeoutMilliseconds: 30_000 }),
    ],
    hiddenCommands: [
      workspaceCommand({ id: 'parser-sign', kind: 'hidden', executable: 'node',
        args: ['-e', RECEIPT_SIGN_CHECK], timeoutMilliseconds: 30_000 }),
    ],
    invariants: [
      // The bug's own shape, named directly, exactly as `broken-sum` names its divisor: a fix that
      // leaves the sign-blind pattern in place did not fix the parser, whatever else it did.
      fileInvariant({ path: 'src/parse.js', mustExist: true, mustNotContain: ['/\\$([0-9]+(?:\\.[0-9]{1,2})?)/'] }),
    ],
    forbiddenChanges: ['test/**'],
    requirePatchCleanliness: true,
    establishBaseline: true,
    maximumChangedFiles: 2,
    maximumChangedLines: 40,
  },
  tags: ['bugfix', 'diagnosis', 'javascript'],
});

/**
 * A shared mutable default, where the obvious fix cures the symptom and leaves the disease.
 *
 * WHY THIS CASE EXISTS, AND WHY THE TRAP IS NOT A TRICK. `createRegistry` hands out the SAME array
 * to every registry built without options, so the visible suite fails. The first fix anyone reaches
 * for is to build a fresh default object per call — which is a real improvement, makes the whole
 * visible suite green, and leaves the second half of the bug untouched: a registry built FROM A
 * CALLER'S OPTIONS OBJECT still aliases that caller's array. That is the same defect wearing a
 * different hat, it is the one a shallow reading misses, and it is the one that bites in production.
 *
 * `README.md` states the rule as one promise with three consequences, the instruction says the
 * visible tests do not check all three, and the hidden check asks for the two they leave out. So
 * nothing here depends on guessing what an unseen test wants: a model that reads the repository
 * before it edits can pass on the first attempt, and a model that patches until green cannot.
 *
 * TWO ATTEMPTS, because the failure is legible. When the hidden check fails, its output is quoted
 * verbatim into the retry briefing, so the second attempt is a model reading a real failure report
 * about aliasing — which is what `recoveryFromError` is supposed to mean. The recovery-weighted
 * scoring policy is what makes the three outcomes — right first time, right second time, wrong
 * twice — land at visibly different scores instead of within a rounding error of each other.
 */
export const REGISTRY_ISOLATION_RECOVER: WorkspaceCase = makeWorkspaceCase({
  id: 'ws.registry-isolation.recover',
  version: '1',
  suiteID: WORKSPACE_SUITE_FOUNDATION,
  suiteVersion: WORKSPACE_SUITE_FOUNDATION_VERSION,
  title: 'Stop registries sharing state, including with the options they were built from',
  description: 'A shared mutable default whose obvious fix passes every visible check and leaves the '
    + 'aliasing in place. Two attempts, scored so that first-time and second-time are not the same result.',
  dimensions: ['recoveryFromError', 'failureInterpretation', 'testExecution', 'regressionAvoidance'],
  source: {
    fixturePath: 'workspace/registry-isolation',
    expectedTreeDigest: '1bf0ca7d3ef3a7b41f94b7a40824be8b166a35fc868eabb4ef56138493a67c98',
  },
  task: {
    instruction: [
      'The test suite in this repository fails. Run it, read the failures, and fix the implementation so that every',
      'assertion passes.',
      '',
      'README.md states the rule this package promises about a registry owning its entries. It is one rule with three',
      'consequences, and the visible tests do not check all three.',
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
    // TWO, and this is the case the number is for. Attempt 2 starts from a fresh copy of the fixture
    // and is handed what the checks reported, so what it measures is reading a failure rather than
    // accumulating half-edits in a dirty tree.
    maximumAttempts: 2,
    tools: { fileRead: true, fileWrite: true, commandExecution: true, allowedExecutables: [] },
    networkPolicy: 'providerOnly',
    environmentAllowlist: ['HOME', 'USER'],
  },
  verification: {
    commands: [
      workspaceCommand({ id: 'registry-tests', kind: 'test', executable: 'node', args: ['test/registry.test.js'], timeoutMilliseconds: 30_000 }),
    ],
    hiddenCommands: [
      workspaceCommand({ id: 'shared-options', kind: 'hidden', executable: 'node',
        args: ['-e', REGISTRY_SHARED_OPTIONS_CHECK], timeoutMilliseconds: 30_000 }),
    ],
    invariants: [
      fileInvariant({ path: 'src/registry.js', mustExist: true, mustContain: ['createRegistry', 'namesOf'] }),
    ],
    forbiddenChanges: ['test/**'],
    requirePatchCleanliness: true,
    establishBaseline: true,
    maximumChangedFiles: 1,
    maximumChangedLines: 30,
  },
  scoring: RECOVERY_WEIGHTED_WORKSPACE_SCORING_POLICY,
  tags: ['bugfix', 'javascript', 'recovery'],
});

export const workspaceFoundationSuite: WorkspaceSuite = makeWorkspaceSuite(
  WORKSPACE_SUITE_FOUNDATION,
  WORKSPACE_SUITE_FOUNDATION_VERSION,
  'Workspace foundation',
  [BROKEN_SUM_MEAN, TASK_PRIORITY_PROPAGATE, RECEIPT_REFUNDS_SIGN, REGISTRY_ISOLATION_RECOVER],
);

export const registeredWorkspaceSuites: WorkspaceSuite[] = [
  workspaceFoundationSuite, workspaceTierTwoSuite, workspaceTierThreeSuite,
];

// MARK: - Packs

export const WORKSPACE_PACK_FOUNDATION_FOUR = 'pack.cernum.workspace.foundation-four';

/**
 * THE FIRST COMPARATIVE PACK: four cases that fail for four different reasons.
 *
 * Small on purpose. The question a first matrix has to answer is whether four models can be told
 * apart at all, and four cases that each exercise a DIFFERENT capability answer it better than forty
 * that exercise one. What the four separate:
 *
 *   ws.broken-sum.mean              one line, one file, found from a failing assertion. The floor:
 *                                   a model that cannot pass this cannot be measured on the rest.
 *   ws.task-priority.propagate      one field through three layers, with a rule stated in the
 *                                   repository and nowhere in the tests. Breadth of comprehension.
 *   ws.receipt-refunds.sign         the symptom is two layers away from the cause, and the obvious
 *                                   fix passes everything visible. Diagnosis.
 *   ws.registry-isolation.recover   the obvious fix is half a fix, and the check says so. Recovery.
 *
 * THREE REPEATS, because one sample of an agentic task is an anecdote. An agent run is not
 * deterministic — the same model on the same sealed tree takes different routes on different
 * occasions — so a single run cannot distinguish a model that passes reliably from one that passed
 * once. Three is the smallest number that shows a spread at all, and 4 models x 4 cases x 3 repeats
 * is 48 runs, which is a size a person can actually sit through and pay for.
 *
 * THE REPEATS ARE NOT RETRIES. Two of these cases allow a second ATTEMPT inside one run; all four
 * get three independent RUNS. See `WORKSPACE_REPEAT_IS_NOT_RETRY`.
 */
export const foundationFourPack: WorkspaceBenchmarkPack = makeWorkspaceBenchmarkPack({
  id: WORKSPACE_PACK_FOUNDATION_FOUR,
  version: '1',
  title: 'Foundation four',
  description: 'Four sealed workspace cases — a one-line fix, a multi-file feature, a misdirected '
    + 'diagnosis and a recovery — sampled three times each.',
  caseIDs: [
    BROKEN_SUM_MEAN.id, TASK_PRIORITY_PROPAGATE.id, RECEIPT_REFUNDS_SIGN.id, REGISTRY_ISOLATION_RECOVER.id,
  ],
  repeatsPerCase: 3,
});

/**
 * TIER 2: four cases the foundation pack was too small to ask.
 *
 * WHY IT IS A SECOND PACK AND NOT A LONGER FIRST ONE. `foundation-four` has been RUN — forty-eight
 * sealed records on this machine carry its `cwp1:` — and a pack digest is the identity of one
 * experiment. Adding cases to it would move that digest and make the completed matrix a record of
 * an experiment that no longer exists. A pack is cheap; a result is not.
 *
 * SAME SHAPE, SO THE TWO TABLES CAN BE READ SIDE BY SIDE. Four cases, three repeats, four different
 * capabilities. Across four models that is forty-eight independent runs again — the same run count
 * the foundation matrix produced, which is what makes "Haiku 9/12 at Tier 1" and whatever this
 * produces comparable as counts.
 *
 * ONE OF THE FOUR — `ws.t2.cache-eviction.recover` — allows a second attempt, so a four-model matrix
 * is at most sixty provider requests. Foundation carried two retry-capable cases and so ran to at
 * most seventy-two: the RUNS are the same arithmetic, the REQUESTS are not, and a reader budgeting
 * an evening wants the second number rather than the first.
 */
export const WORKSPACE_PACK_TIER_TWO = 'pack.cernum.workspace.tier-two';

export const tierTwoPack: WorkspaceBenchmarkPack = makeWorkspaceBenchmarkPack({
  id: WORKSPACE_PACK_TIER_TWO,
  version: '1',
  title: 'Tier two',
  description: 'Four sealed workspace cases at tier2 — a five-layer feature, a symptom two modules from '
    + 'its cause, three failures with one defect under them, and a recovery whose obvious fix breaks a '
    + 'documented promise — sampled three times each.',
  caseIDs: [
    'ws.t2.ledger-currency.propagate', 'ws.t2.schedule-window.diagnose',
    'ws.t2.text-normalize.cluster', 'ws.t2.cache-eviction.recover',
  ],
  repeatsPerCase: 3,
});

/**
 * TIER 3: the cases meant to separate strong frontier agents.
 *
 * Same size and same sampling as the two packs below it, for the same reason: a reader comparing
 * three tables wants the difference between them to be the DIFFICULTY and not the arithmetic. One
 * of these four — `ws.t3.import-pipeline.finish` — allows a second attempt, so this too is
 * forty-eight runs and at most sixty requests per four-model matrix.
 *
 * THERE IS DELIBERATELY NO COMBINED TWELVE-CASE PACK. Each tier runs on its own, so a matrix can be
 * stopped after Tier 2 without a half-finished experiment, and so a Tier 3 table is never quietly
 * averaged with a Tier 1 one — which `workspacePackTier` refuses outright for a pack whose members
 * do not share a tier.
 */
export const WORKSPACE_PACK_TIER_THREE = 'pack.cernum.workspace.tier-three';

export const tierThreePack: WorkspaceBenchmarkPack = makeWorkspaceBenchmarkPack({
  id: WORKSPACE_PACK_TIER_THREE,
  version: '1',
  title: 'Tier three',
  description: 'Four sealed workspace cases at tier3 — an authorization boundary that has to be built, '
    + 'two interacting defects, a refactor with the behaviour held byte-identical, and a pipeline to '
    + 'finish — sampled three times each.',
  caseIDs: [
    'ws.t3.permission-gate.centralize', 'ws.t3.event-replay.pair',
    'ws.t3.validator-rules.refactor', 'ws.t3.import-pipeline.finish',
  ],
  repeatsPerCase: 3,
});

export const registeredWorkspacePacks: WorkspaceBenchmarkPack[] = [
  foundationFourPack, tierTwoPack, tierThreePack,
];

export function workspacePackByID(id: string): WorkspaceBenchmarkPack | undefined {
  return registeredWorkspacePacks.find((pack) => pack.id === id);
}

export function workspaceSuiteByID(id: string): WorkspaceSuite | undefined {
  return registeredWorkspaceSuites.find((suite) => suite.id === id);
}

export function allWorkspaceCases(): WorkspaceCase[] {
  return registeredWorkspaceSuites.flatMap((suite) => suite.cases);
}

/**
 * Fail-closed at import time is too eager; callers validate before planning, exactly as the core does.
 *
 * ONE FUNCTION FOR THE WHOLE CATALOGUE, including the difficulty claims. A second entry point that
 * checked only the cases would be one a caller could reach for by accident, and a matrix planned
 * without checking the tiers would print a difficulty nobody verified.
 */
export function validateWorkspaceCatalog(): void {
  for (const suite of registeredWorkspaceSuites) validateWorkspaceSuite(suite);
  const cases = allWorkspaceCases();
  for (const pack of registeredWorkspacePacks) validateWorkspaceBenchmarkPack(pack, cases);
  validateWorkspaceDifficultyCatalogue();
}
