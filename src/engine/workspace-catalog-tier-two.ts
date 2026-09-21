// Benchmark engine · the TIER 2 workspace suite: cases the foundation pack was too small to ask.
//
// WHY THIS SUITE EXISTS, IN ONE PARAGRAPH OF EVIDENCE. `pack.cernum.workspace.foundation-four@1` was
// run across four Claude models, three samples of each of four cases, forty-eight runs. Sonnet,
// Fable and Opus each scored 12/12; Haiku scored 9/12, losing `ws.receipt-refunds.sign` three times
// out of three on a root-cause diagnosis it reproducibly missed. That is a real result and the pack
// keeps its job — it is the floor, and it tells a model that cannot do small localized work apart
// from one that can. But a pack three of four models saturate has stopped separating the three, and
// the question this suite exists to ask is what does.
//
// WHAT TIER 2 ASKS FOR, AND WHAT IT DELIBERATELY DOES NOT. Moderate repository understanding:
// several interacting files, a symptom that may be misleading, more than one plausible answer, and
// diagnosis that may have to come from running things rather than from reading the instruction.
// It does NOT ask for architecture — that is Tier 3 — and it does not ask for scale. Every fixture
// here is between twelve and fifteen files and under five hundred lines of JavaScript, runs on
// `node` alone, installs nothing and reaches no network, because a pack meant to be sampled three
// times across four models has to be cheap enough to sit through. The difficulty is in the
// RELATIONSHIPS, and `workspace-difficulty.ts` is where that claim is written down as numbers a
// reader can check rather than as this paragraph.
//
// FOUR CASES, FOUR DIFFERENT REASONS TO FAIL, exactly as the foundation four were built:
//
//   ws.t2.ledger-currency.propagate   a feature across five files, with a documented
//                                     backward-compatibility rule and an API totality rule that the
//                                     visible suites never mention. Breadth.
//   ws.t2.schedule-window.diagnose    the symptom is two module boundaries from the cause, the
//                                     module it points at is correct, and two different plausible
//                                     fixes fail — one in plain sight, one only to a hidden check.
//                                     Diagnosis.
//   ws.t2.text-normalize.cluster      four consumers fail for four different-looking reasons and
//                                     share one defect; the change ceiling forbids patching them
//                                     one at a time and a fifth consumer nothing visible tests is
//                                     what proves the fix went in the middle. Clustering.
//   ws.t2.cache-eviction.recover      the obvious fix makes every visible check green and quietly
//                                     breaks a documented promise about a call that is supposed to
//                                     change nothing. Recovery, with a sharper trap than
//                                     `ws.registry-isolation.recover`.
//
// NOTHING HERE IS A RIDDLE. Every hidden check asks for a consequence stated in the fixture's own
// README or `docs/`, every instruction says plainly what is wrong and what may not be changed, and
// no case depends on guessing a name, a letter or a number that the repository does not give. The
// work is meant to be hard; finding out what was being asked is not.

import {
  RECOVERY_WEIGHTED_WORKSPACE_SCORING_POLICY, WorkspaceCase, WorkspaceSuite, fileInvariant, makeWorkspaceCase,
  makeWorkspaceSuite, workspaceCommand,
} from './workspace-case';
import { hiddenScript } from './workspace-hidden-script';

export const WORKSPACE_SUITE_TIER_TWO = 'suite.cernum.workspace.tier-two';
export const WORKSPACE_SUITE_TIER_TWO_VERSION = '1';

/** Every Tier 2 case unlocks exactly what the foundation cases unlock, and for the same reason. */
const SUBSCRIPTION_SESSION_ENVIRONMENT = ['HOME', 'USER'];

// MARK: - Hidden checks

/** `docs/FORMAT.md`: a record written before currencies existed still loads, as the default. */
const LEDGER_LEGACY_RECORD_CHECK = hiddenScript([
  "const assert = require('node:assert');",
  "const { defaultCurrency } = require('./src/config.js');",
  "const { fromWire, toWire } = require('./src/wire.js');",
  "const legacy = fromWire({ i: 'a', d: 'Written before currencies existed', a: 1250 });",
  "assert.strictEqual(legacy.currency, defaultCurrency(),",
  "  'docs/FORMAT.md: a record carrying no c must read back as the package default currency, not as undefined');",
  "assert.strictEqual(toWire(legacy).c, defaultCurrency(),",
  "  'and writing that entry back out must produce a record that carries the key');",
  "console.log('ok - an old record without c still loads');",
]);

/** `docs/API.md`: totalling is total — an empty journal answers, a mixed one refuses. */
const LEDGER_TOTALLING_IS_TOTAL_CHECK = hiddenScript([
  "const assert = require('node:assert');",
  "const { defaultCurrency } = require('./src/config.js');",
  "const { createEntry } = require('./src/entry.js');",
  "const { createJournal, addEntry, totalOf } = require('./src/journal.js');",
  "assert.deepStrictEqual(totalOf(createJournal('empty')), { amountCents: 0, currency: defaultCurrency() },",
  "  'docs/API.md: an empty journal totals to zero in the default currency; it is not an error and not a mixed one');",
  "const mixed = createJournal('mixed');",
  "addEntry(mixed, createEntry({ id: 'a', description: 'Coffee', amountCents: 425, currency: 'USD' }));",
  "addEntry(mixed, createEntry({ id: 'b', description: 'Book', amountCents: 1250, currency: 'EUR' }));",
  "assert.throws(() => totalOf(mixed), RangeError,",
  "  'docs/API.md: a journal that mixes currencies has no total and must be refused, not summed');",
  "console.log('ok - totalling is total');",
]);

/** `docs/RULES.md`: one duration, one answer, and the public surface gives the same one. */
const SCHEDULE_ONE_DURATION_CHECK = hiddenScript([
  "const assert = require('node:assert');",
  "const { minutesBetween, durationLabel } = require('./src/duration.js');",
  "const { createInterval } = require('./src/interval.js');",
  "const api = require('./src/index.js');",
  "assert.strictEqual(minutesBetween(540, 600), 60,",
  "  'docs/RULES.md: a window is half-open, so 09:00-10:00 runs for 60 minutes');",
  "assert.strictEqual(minutesBetween(540, 540), 0,",
  "  'and a window that starts and ends on the same minute runs for no time');",
  "assert.strictEqual(durationLabel(minutesBetween(540, 630)), '1 hour 30 minutes');",
  "assert.strictEqual(api.minutesBetween(540, 600), 60,",
  "  'the public surface answers what the schedule answers: duration arithmetic lives in one place');",
  "assert.strictEqual(createInterval('09:00', '10:00').minutes, 60);",
  "assert.strictEqual(createInterval('09:00', '10:00').endMinute, 600,",
  "  'endMinute is the first minute after the window, not the last minute inside it');",
  "console.log('ok - one duration, one answer');",
]);

/** `docs/FOLDING.md`: every letter survives folding, and LETTER_FOLDS is the second half of it. */
const TEXT_EVERY_LETTER_SURVIVES_CHECK = hiddenScript([
  "const assert = require('node:assert');",
  "const { LETTER_FOLDS, foldDiacritics } = require('./src/unicode.js');",
  "for (const [letter, stands] of Object.entries(LETTER_FOLDS)) {",
  "  assert.strictEqual(foldDiacritics(letter), stands,",
  "    'docs/FOLDING.md: LETTER_FOLDS is the second half of folding, and it is complete for the alphabets '",
  "    + 'this package supports');",
  "}",
  "assert.strictEqual(foldDiacritics('Caf\\u00e9'), 'Cafe', 'a letter that carries a mark loses the mark');",
  "assert.strictEqual(foldDiacritics('plain ASCII 123'), 'plain ASCII 123',",
  "  'and folding leaves punctuation, spacing and digits alone');",
  "console.log('ok - every letter survives folding');",
]);

/** `README.md`: text is folded once, centrally — including for the consumer nothing visible tests. */
const TEXT_INITIALS_FOLD_TOO_CHECK = hiddenScript([
  "const assert = require('node:assert');",
  "const { initialsOf } = require('./src/initials.js');",
  "assert.strictEqual(initialsOf('Ada Lovelace'), 'AL');",
  "assert.strictEqual(initialsOf('\\u00d8ystein \\u0141ukasz'), 'OL',",
  "  'README.md: text is folded once, centrally, so every consumer reads a name the same way');",
  "assert.strictEqual(initialsOf('\\u00c6thelred \\u00d0unn'), 'AD');",
  "assert.strictEqual(initialsOf('  Grace   Hopper  '), 'GH');",
  "console.log('ok - initials fold like everything else');",
]);

/** `docs/CACHE.md`: a peek and a has are inspections, and neither counts as a use. */
const CACHE_PEEK_IS_NOT_A_USE_CHECK = hiddenScript([
  "const assert = require('node:assert');",
  "const { createClock } = require('./src/clock.js');",
  "const { createCache, set, peek, has, keys } = require('./src/cache.js');",
  "const cache = createCache({ capacity: 3, clock: createClock() });",
  "set(cache, 'a', 1); set(cache, 'b', 2); set(cache, 'c', 3);",
  "peek(cache, 'a');",
  "has(cache, 'a');",
  "assert.deepStrictEqual(keys(cache), ['a', 'b', 'c'],",
  "  'docs/CACHE.md: peek and has are inspections and neither counts as a use, so the order is untouched');",
  "set(cache, 'd', 4);",
  "assert.strictEqual(has(cache, 'a'), false,",
  "  'a was still the least recently used key, because looking at it was not using it');",
  "console.log('ok - looking at the cache does not change it');",
]);

/** `docs/CACHE.md`: an entry on its way out is never promoted first, whichever call found it. */
const CACHE_EXPIRED_IS_NOT_PROMOTED_CHECK = hiddenScript([
  "const assert = require('node:assert');",
  "const { createClock } = require('./src/clock.js');",
  "const { createCache, set, get, has, statisticsOf } = require('./src/cache.js');",
  "const clock = createClock();",
  "const cache = createCache({ capacity: 3, ttlTicks: 5, clock });",
  "set(cache, 'old', 1);",
  "clock.advance(5);",
  "set(cache, 'x', 1); set(cache, 'y', 2);",
  "assert.strictEqual(get(cache, 'old'), undefined);",
  "assert.strictEqual(has(cache, 'old'), false,",
  "  'docs/CACHE.md: reading an expired key answers undefined and drops the entry; it is not a use of it');",
  "assert.strictEqual(statisticsOf(cache).expirations, 1,",
  "  'and it is counted as an expiry rather than as an eviction');",
  "assert.strictEqual(statisticsOf(cache).evictions, 0);",
  "console.log('ok - an expired entry is gone, not promoted');",
]);

// MARK: - The cases

/**
 * Carry a currency through the model, the collection, the wire format, the rendering and the API.
 *
 * WHY THIS CASE EXISTS. `ws.task-priority.propagate` carries one field through three layers and is
 * the broadest thing in the foundation pack; every model that can be measured passes it. This asks
 * the same kind of question at a size where holding the package in mind actually costs something:
 * five files have to change, the primitive that makes it possible is already in the tree and wired
 * to nothing, and the change is not plumbing — `totalOf` gains a RULE, not a field, and a journal
 * that mixes currencies has to be refused rather than summed.
 *
 * NOTHING HERE IS A DESIGN DECISION. `src/money.js` already names the currencies, the symbols and
 * the formatting; `src/config.js` already names the default. What each layer must do is pinned by
 * assertions the model can read, and the two things the visible suites do NOT state are stated in
 * the repository: `docs/FORMAT.md` says what a record written before this field existed must read
 * back as, and `docs/API.md` says that an empty journal totals and a mixed one refuses. The two
 * hidden checks ask for exactly those and nothing else.
 *
 * THE INVARIANTS KEEP THE LAYERS APART. With a six-file ceiling the cheapest way to make five suites
 * green is to collapse the package, which passes every assertion and destroys what the case is
 * about.
 */
export const T2_LEDGER_CURRENCY_PROPAGATE: WorkspaceCase = makeWorkspaceCase({
  id: 'ws.t2.ledger-currency.propagate',
  version: '1',
  suiteID: WORKSPACE_SUITE_TIER_TWO,
  suiteVersion: WORKSPACE_SUITE_TIER_TWO_VERSION,
  title: 'Carry a currency through five layers of a ledger',
  description: 'A feature across five files, with a backward-compatibility rule in docs/FORMAT.md and a '
    + 'totality rule in docs/API.md that the five visible suites never mention.',
  dimensions: ['repositoryComprehension', 'multiFileEditing', 'toolUse', 'regressionAvoidance'],
  source: {
    fixturePath: 'workspace/t2-ledger-currency',
    expectedTreeDigest: 'b7bdef0dbfb6acbb549847edb4ea63a999750a36dd008647be31d2a0eff7822d',
  },
  task: {
    instruction: [
      'This package keeps a ledger. Money in it is meant to be a number AND a currency, and at the moment only the',
      'number is carried: src/money.js knows about currencies and nothing above it uses what it knows.',
      '',
      'Five test suites describe exactly what is expected. Run them, read the failures, and implement what they ask',
      'for.',
      '',
      'Before you change the storage layer, read docs/FORMAT.md: it says what a reader of an OLD record — one written',
      'before this field existed — must still get. Before you change the totals, read docs/API.md: it says what',
      'totalling promises, including the one case it refuses rather than answering.',
      '',
      'Do not change any test. Do not change what the tests assert. Fix the code they are testing.',
    ].join('\n'),
    // Deliberately no `briefingPaths`: finding the five layers is part of what this case measures.
    scope: { allowed: ['src/**'], forbidden: ['test/**', 'docs/**'] },
  },
  execution: {
    timeoutMilliseconds: 900_000,
    // ONE ATTEMPT. This case measures whether a model can hold a package in mind, not whether it can
    // recover; `ws.t2.cache-eviction.recover` measures that, and measuring both here would make
    // neither reading clean.
    maximumAttempts: 1,
    tools: { fileRead: true, fileWrite: true, commandExecution: true, allowedExecutables: [] },
    networkPolicy: 'providerOnly',
    environmentAllowlist: SUBSCRIPTION_SESSION_ENVIRONMENT,
  },
  verification: {
    commands: [
      workspaceCommand({ id: 'entry-tests', kind: 'test', executable: 'node', args: ['test/entry.test.js'], timeoutMilliseconds: 30_000 }),
      workspaceCommand({ id: 'journal-tests', kind: 'test', executable: 'node', args: ['test/journal.test.js'], timeoutMilliseconds: 30_000 }),
      workspaceCommand({ id: 'wire-tests', kind: 'test', executable: 'node', args: ['test/wire.test.js'], timeoutMilliseconds: 30_000 }),
      workspaceCommand({ id: 'report-tests', kind: 'test', executable: 'node', args: ['test/report.test.js'], timeoutMilliseconds: 30_000 }),
      workspaceCommand({ id: 'api-tests', kind: 'test', executable: 'node', args: ['test/api.test.js'], timeoutMilliseconds: 30_000 }),
    ],
    hiddenCommands: [
      workspaceCommand({ id: 'legacy-record', kind: 'hidden', executable: 'node',
        args: ['-e', LEDGER_LEGACY_RECORD_CHECK], timeoutMilliseconds: 30_000 }),
      workspaceCommand({ id: 'totalling-is-total', kind: 'hidden', executable: 'node',
        args: ['-e', LEDGER_TOTALLING_IS_TOTAL_CHECK], timeoutMilliseconds: 30_000 }),
    ],
    invariants: [
      fileInvariant({ path: 'src/money.js', mustExist: true, mustContain: ['CURRENCIES', 'formatMoney'] }),
      fileInvariant({ path: 'src/config.js', mustExist: true, mustContain: ['defaultCurrency'] }),
      fileInvariant({ path: 'src/entry.js', mustExist: true, mustContain: ['createEntry'] }),
      fileInvariant({ path: 'src/journal.js', mustExist: true, mustContain: ['totalOf'] }),
      fileInvariant({ path: 'src/wire.js', mustExist: true, mustContain: ['toWire', 'fromWire'] }),
    ],
    forbiddenChanges: ['docs/**', 'test/**'],
    requirePatchCleanliness: true,
    establishBaseline: true,
    maximumChangedFiles: 6,
    maximumChangedLines: 220,
  },
  tags: ['feature', 'javascript', 'multi-file', 'tier2'],
});

/**
 * A room that reports a conflict between two bookings that merely touch.
 *
 * WHY THIS CASE EXISTS, AND WHY THE MISDIRECTION IS FAIR. `ws.receipt-refunds.sign` puts the cause
 * one module from the symptom and is the case Haiku reproducibly failed; this puts it two, and adds
 * the part that makes real diagnosis hard — the module the failure POINTS AT is correct, and there
 * is a test that says so. `test/overlap.test.js` hands `overlap.js` its windows as bare minute marks
 * and passes, exactly as `receipt-refunds` establishes that its sums are right when values are
 * handed to them directly. So the failing suite is `schedule`, the suspicious module is `overlap`,
 * and the defect is a `+ 1` in `duration.js` two requires further down.
 *
 * TWO PLAUSIBLE WRONG ANSWERS, AND EACH FAILS SOMEWHERE DIFFERENT. Making `overlap.js` subtract a
 * minute before comparing cures the conflict report and leaves `test/agenda.test.js` red, because
 * every booking still runs a minute too long — that one fails in plain sight. Computing the window
 * length inside `interval.js` instead of asking `duration.js` makes every visible suite green and
 * leaves `minutesBetween` — which `README.md` calls the one place a duration is worked out, and
 * which the public API exports — answering 61 for an hour. The hidden check asks it directly.
 */
export const T2_SCHEDULE_WINDOW_DIAGNOSE: WorkspaceCase = makeWorkspaceCase({
  id: 'ws.t2.schedule-window.diagnose',
  version: '1',
  suiteID: WORKSPACE_SUITE_TIER_TWO,
  suiteVersion: WORKSPACE_SUITE_TIER_TWO_VERSION,
  title: 'Find why two bookings that merely touch are reported as a conflict',
  description: 'The failing suite points at a module that is correct and has a passing test to prove it; '
    + 'the defect is two requires further down, and the obvious fix leaves a different suite red.',
  dimensions: ['failureInterpretation', 'fileLocation', 'repositoryComprehension', 'regressionAvoidance'],
  source: {
    fixturePath: 'workspace/t2-schedule-window',
    expectedTreeDigest: '12e3c511eda8771a3fee617545fa4bf9249fee2d3b0c82aa7c72b1b797275e86',
  },
  task: {
    instruction: [
      'A room shows as double-booked when two bookings merely touch: one ends at 10:00, the next starts at 10:00, and',
      'the schedule calls that a conflict. It is not one — docs/RULES.md says a booking window includes the minute it',
      'starts on and excludes the minute it ends on.',
      '',
      'Bookings that genuinely share a minute, including exactly one minute, ARE a conflict and must stay one.',
      '',
      'Run the test suite, work out what is actually wrong, and fix it.',
      '',
      'Do not change any test. Do not change what the tests assert. Fix the code they are testing.',
    ].join('\n'),
    scope: { allowed: ['src/**'], forbidden: ['test/**', 'docs/**'] },
  },
  execution: {
    timeoutMilliseconds: 900_000,
    // ONE ATTEMPT, for the reason `ws.receipt-refunds.sign` allows one: what this measures is whether
    // the FIRST diagnosis was the right one. A second go after being shown the hidden check's output
    // would measure something else, and that something else has a case of its own.
    maximumAttempts: 1,
    tools: { fileRead: true, fileWrite: true, commandExecution: true, allowedExecutables: [] },
    networkPolicy: 'providerOnly',
    environmentAllowlist: SUBSCRIPTION_SESSION_ENVIRONMENT,
  },
  verification: {
    commands: [
      workspaceCommand({ id: 'timeparse-tests', kind: 'test', executable: 'node', args: ['test/timeparse.test.js'], timeoutMilliseconds: 30_000 }),
      workspaceCommand({ id: 'overlap-tests', kind: 'test', executable: 'node', args: ['test/overlap.test.js'], timeoutMilliseconds: 30_000 }),
      workspaceCommand({ id: 'schedule-tests', kind: 'test', executable: 'node', args: ['test/schedule.test.js'], timeoutMilliseconds: 30_000 }),
      workspaceCommand({ id: 'agenda-tests', kind: 'test', executable: 'node', args: ['test/agenda.test.js'], timeoutMilliseconds: 30_000 }),
    ],
    hiddenCommands: [
      workspaceCommand({ id: 'one-duration', kind: 'hidden', executable: 'node',
        args: ['-e', SCHEDULE_ONE_DURATION_CHECK], timeoutMilliseconds: 30_000 }),
    ],
    invariants: [
      // The bug's own shape, named directly, exactly as `broken-sum` names its divisor.
      fileInvariant({ path: 'src/duration.js', mustExist: true, mustNotContain: ['endMinute - startMinute + 1'] }),
      // And the two architectural rules `README.md` states: duration arithmetic lives in one place,
      // and the module that decides overlap is still the module that decides overlap.
      fileInvariant({ path: 'src/interval.js', mustExist: true, mustContain: ['minutesBetween'] }),
      fileInvariant({ path: 'src/overlap.js', mustExist: true, mustContain: ['intervalsOverlap'] }),
    ],
    forbiddenChanges: ['docs/**', 'test/**'],
    requirePatchCleanliness: true,
    establishBaseline: true,
    maximumChangedFiles: 2,
    maximumChangedLines: 40,
  },
  tags: ['bugfix', 'diagnosis', 'javascript', 'tier2'],
});

/**
 * Four suites failing four different-looking ways, and one defect underneath all of them.
 *
 * WHY THIS CASE EXISTS. Every case before it has one symptom. This one has three: a slug loses a
 * letter, a search misses a name it should find, and a name files under the wrong letter. They look
 * like three bugs in three modules, and the expensive mistake — the one this case is built to
 * measure — is to fix them where they are felt. `maximumChangedFiles` is two, so patching three
 * consumers is not merely wrong, it is refused; and `src/initials.js` is a fourth consumer that
 * nothing visible tests, so an answer that went to the consumers rather than to the middle fails a
 * check it never saw even if it somehow stayed inside the ceiling.
 *
 * THE DEFECT IS SUBTLE AND THE RULE IS WRITTEN DOWN. `foldDiacritics` decomposes and then deletes
 * every non-ASCII code point, which works perfectly for a letter that carries a mark — `é` becomes
 * `e` — and deletes outright a letter that has no decomposition, so `Ørsted` becomes `rsted`.
 * `docs/FOLDING.md` states the rule in two parts, says that every letter survives folding, and says
 * that `LETTER_FOLDS` — already in the tree, complete, and used by nothing — is the second half of
 * it. A model that reads it can pass first time.
 */
export const T2_TEXT_NORMALIZE_CLUSTER: WorkspaceCase = makeWorkspaceCase({
  id: 'ws.t2.text-normalize.cluster',
  version: '1',
  suiteID: WORKSPACE_SUITE_TIER_TWO,
  suiteVersion: WORKSPACE_SUITE_TIER_TWO_VERSION,
  title: 'Find the one defect behind three different-looking failures',
  description: 'Slugs, search and filing each fail differently and share one defect in the folding '
    + 'everything goes through; the change ceiling forbids fixing them one at a time.',
  dimensions: ['failureInterpretation', 'repositoryComprehension', 'regressionAvoidance', 'toolUse'],
  source: {
    fixturePath: 'workspace/t2-text-normalize',
    expectedTreeDigest: '376bcb7e18effc5af2e88881ec0cbaf2e59ddee70bd7898de3e454069aa9d0b2',
  },
  task: {
    instruction: [
      'Three test suites in this repository fail, and they fail in three different-looking ways: a slug comes out',
      'missing a letter, a search does not find a name it should, and a name files under the wrong letter.',
      '',
      'Run them, read the failures, and fix the implementation so that every assertion passes. README.md says how many',
      'places in this package are allowed to decide what a letter becomes, and docs/FOLDING.md says what folding',
      'promises and what the two halves of it are.',
      '',
      'Do not change any test. Do not change what the tests assert. Fix the code they are testing.',
    ].join('\n'),
    scope: { allowed: ['src/**'], forbidden: ['test/**', 'docs/**'] },
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
      workspaceCommand({ id: 'slug-tests', kind: 'test', executable: 'node', args: ['test/slug.test.js'], timeoutMilliseconds: 30_000 }),
      workspaceCommand({ id: 'search-tests', kind: 'test', executable: 'node', args: ['test/search.test.js'], timeoutMilliseconds: 30_000 }),
      workspaceCommand({ id: 'sortkey-tests', kind: 'test', executable: 'node', args: ['test/sortkey.test.js'], timeoutMilliseconds: 30_000 }),
      workspaceCommand({ id: 'wrap-tests', kind: 'test', executable: 'node', args: ['test/wrap.test.js'], timeoutMilliseconds: 30_000 }),
    ],
    hiddenCommands: [
      workspaceCommand({ id: 'every-letter-survives', kind: 'hidden', executable: 'node',
        args: ['-e', TEXT_EVERY_LETTER_SURVIVES_CHECK], timeoutMilliseconds: 30_000 }),
      workspaceCommand({ id: 'initials-fold-too', kind: 'hidden', executable: 'node',
        args: ['-e', TEXT_INITIALS_FOLD_TOO_CHECK], timeoutMilliseconds: 30_000 }),
    ],
    invariants: [
      // The bug's own shape, plus the four consumers that must still be asking rather than deciding.
      fileInvariant({ path: 'src/unicode.js', mustExist: true, mustContain: ['LETTER_FOLDS'], mustNotContain: ['[^\\u0000-\\u007f]'] }),
      fileInvariant({ path: 'src/slug.js', mustExist: true, mustContain: ['foldDiacritics'] }),
      fileInvariant({ path: 'src/search.js', mustExist: true, mustContain: ['foldForComparison'] }),
      fileInvariant({ path: 'src/sortkey.js', mustExist: true, mustContain: ['foldForComparison'] }),
      fileInvariant({ path: 'src/initials.js', mustExist: true, mustContain: ['foldDiacritics'] }),
    ],
    forbiddenChanges: ['docs/**', 'test/**'],
    requirePatchCleanliness: true,
    establishBaseline: true,
    maximumChangedFiles: 2,
    maximumChangedLines: 40,
  },
  tags: ['bugfix', 'clustering', 'javascript', 'tier2'],
});

/**
 * A cache whose eviction order is wrong, where the obvious fix breaks a promise nothing visible
 * checks.
 *
 * WHY THIS TRAP IS SHARPER THAN `ws.registry-isolation.recover`. There the obvious fix is half a
 * fix — it leaves part of the same bug standing. Here the obvious fix is a WHOLE fix of the stated
 * problem that BREAKS SOMETHING ELSE, and the something else is a documented promise about a call
 * that is supposed to change nothing. `get` and `peek` share `read`, because expiry has to be judged
 * the same way for both; the one-line place to refresh recency is inside `read`, where the entry is
 * already in hand; and doing it there makes every one of the four visible suites green while
 * quietly turning `peek` — the call that exists so a caller can look without disturbing anything —
 * into a call that reorders the cache.
 *
 * `README.md` says it in four words, `docs/CACHE.md` has it in a table, and the hidden check asks
 * for exactly that. So a model that reads the contract before editing passes on the first attempt,
 * and a model that makes the failing suite green does not.
 *
 * TWO ATTEMPTS, AND THE RECOVERY-WEIGHTED POLICY. When the hidden check fails its output is quoted
 * verbatim into the retry briefing, so the second attempt is a model reading a real report about a
 * peek that changed the eviction order — which is what `recoveryFromError` is supposed to mean.
 */
export const T2_CACHE_EVICTION_RECOVER: WorkspaceCase = makeWorkspaceCase({
  id: 'ws.t2.cache-eviction.recover',
  version: '1',
  suiteID: WORKSPACE_SUITE_TIER_TWO,
  suiteVersion: WORKSPACE_SUITE_TIER_TWO_VERSION,
  title: 'Make a read count as a use, without making a look count as one',
  description: 'The obvious place to refresh recency is shared with the call that promises to change '
    + 'nothing. Every visible check goes green either way; only the contract says which is right.',
  dimensions: ['recoveryFromError', 'failureInterpretation', 'testExecution', 'regressionAvoidance'],
  source: {
    fixturePath: 'workspace/t2-cache-eviction',
    expectedTreeDigest: '48fe70d197803af59608930f5c4186c31adaf5f7b24a8ba0bbd5cf9fdf31eac1',
  },
  task: {
    instruction: [
      'This cache evicts the wrong key: reading a key is supposed to make it the most recently used one, and at the',
      'moment it does not, so the key that goes is the one that was read most recently rather than the one nobody has',
      'asked for. A second suite fails too.',
      '',
      'Run the tests, read the failures, and fix the implementation so that every assertion passes.',
      '',
      'README.md states what this cache promises about which calls count as a use and which do not, and',
      'docs/CACHE.md has the whole contract in a table. The visible tests do not check all of it.',
      '',
      'Do not change any test. Do not change what the tests assert. Fix the code they are testing.',
    ].join('\n'),
    scope: { allowed: ['src/**'], forbidden: ['test/**', 'docs/**'] },
  },
  execution: {
    timeoutMilliseconds: 900_000,
    // TWO, and this is one of the two cases the number is for. Attempt 2 starts from a fresh copy of
    // the fixture and is handed what the checks reported, so what it measures is reading a failure
    // rather than accumulating half-edits in a dirty tree.
    maximumAttempts: 2,
    tools: { fileRead: true, fileWrite: true, commandExecution: true, allowedExecutables: [] },
    networkPolicy: 'providerOnly',
    environmentAllowlist: SUBSCRIPTION_SESSION_ENVIRONMENT,
  },
  verification: {
    commands: [
      workspaceCommand({ id: 'basic-tests', kind: 'test', executable: 'node', args: ['test/basic.test.js'], timeoutMilliseconds: 30_000 }),
      workspaceCommand({ id: 'expiry-tests', kind: 'test', executable: 'node', args: ['test/expiry.test.js'], timeoutMilliseconds: 30_000 }),
      workspaceCommand({ id: 'eviction-tests', kind: 'test', executable: 'node', args: ['test/eviction.test.js'], timeoutMilliseconds: 30_000 }),
      workspaceCommand({ id: 'stats-tests', kind: 'test', executable: 'node', args: ['test/stats.test.js'], timeoutMilliseconds: 30_000 }),
    ],
    hiddenCommands: [
      workspaceCommand({ id: 'peek-is-not-a-use', kind: 'hidden', executable: 'node',
        args: ['-e', CACHE_PEEK_IS_NOT_A_USE_CHECK], timeoutMilliseconds: 30_000 }),
      workspaceCommand({ id: 'expired-is-not-promoted', kind: 'hidden', executable: 'node',
        args: ['-e', CACHE_EXPIRED_IS_NOT_PROMOTED_CHECK], timeoutMilliseconds: 30_000 }),
    ],
    invariants: [
      fileInvariant({ path: 'src/cache.js', mustExist: true, mustContain: ['peek', 'touch'] }),
      fileInvariant({ path: 'src/eviction.js', mustExist: true, mustContain: ['leastRecentlyUsed'] }),
    ],
    forbiddenChanges: ['docs/**', 'test/**'],
    requirePatchCleanliness: true,
    establishBaseline: true,
    maximumChangedFiles: 2,
    maximumChangedLines: 40,
  },
  scoring: RECOVERY_WEIGHTED_WORKSPACE_SCORING_POLICY,
  tags: ['bugfix', 'javascript', 'recovery', 'tier2'],
});

export const workspaceTierTwoSuite: WorkspaceSuite = makeWorkspaceSuite(
  WORKSPACE_SUITE_TIER_TWO,
  WORKSPACE_SUITE_TIER_TWO_VERSION,
  'Workspace tier two',
  [T2_LEDGER_CURRENCY_PROPAGATE, T2_SCHEDULE_WINDOW_DIAGNOSE, T2_TEXT_NORMALIZE_CLUSTER, T2_CACHE_EVICTION_RECOVER],
);
