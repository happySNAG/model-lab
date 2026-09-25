// Cernum core · the multi-file-editing suite.
//
// WHAT THIS DIMENSION IS. Not "can the model write a function" — a single-file benchmark measures
// that, and the frontier has been saturating single-file benchmarks for years. It is whether a
// change that is COHERENT ACROSS FILES comes out coherent: the implementation and the declaration it
// must agree with, the data the implementation reads, the test that proves it, and nothing else.
// The failure this measures is not a wrong line. It is a right line in one file and silence in the
// three others that had to move with it.
//
// EVERY TASK HERE IS BUILT SO A ONE-FILE PATCH CANNOT SCORE, and that is enforced twice: the
// validator refuses an edit task requiring fewer than three files, and `requiredFilesPresent` is a
// gating metric with one assertion per required path. A patch that writes a perfect new stage and
// never registers it in the pipeline fails the gate however good the stage is.
//
// THE THREE TASKS EACH CARRY A TRAP FOR A DIFFERENT HABIT.
//
//   add-region-surcharge   the pipeline declares its stage order in a `STAGES` constant. A model
//                          that wires the call and forgets the constant has left the repository
//                          describing itself incorrectly, which is the kind of drift that survives
//                          code review and surfaces months later.
//   fix-negative-rounding  the defect has a tempting local fix — special-case the value in the
//                          failing test — and a `shortcutProbe` looks for exactly that.
//   honour-rounding-mode   `rates.json` ALREADY declares `roundingMode` and nothing reads it. A
//                          model that adds a second config key rather than reading the one that is
//                          there fails `unrelatedFilesUntouched`, because it edited a file the task
//                          required to stay still.
//
// THE PROMPTS GIVE AWAY THE REQUIREMENT AND NOT THE SHAPE. Behaviour, target values and the paths
// that are in bounds are stated, because a task whose requirement has to be guessed measures
// guessing. What is held out is everything about how this repository is put together: that stage
// order is declared in a constant, that per-region data lives in config rather than in code, that
// rounding cases live in a table rather than in the test module, that the changelog has a format.

import { DevelopmentAssertion } from '../development-assertions';
import { DevelopmentSuite, DevelopmentTask, makeDevelopmentSuite, makeDevelopmentTask } from '../development-benchmark';
import { DEVELOPMENT_SCORING_CONTRACT_ID, DEVELOPMENT_SCORING_CONTRACT_VERSION } from '../development-scoring';
import { ledgerlite } from '../development-fixtures/ledgerlite';
import { fixtureRepoDigest } from '../development-fixture';

export const MULTI_FILE_EDIT_SUITE_ID = 'suite.cernum.development.multi-file-edit';
export const MULTI_FILE_EDIT_SUITE_VERSION = '1';

const PROVENANCE = 'cernum-development-pass (synthetic; original ledgerlite fixture)';

const SYSTEM_PROMPT =
  'You are being evaluated inside Cernum on a synthetic fixture repository in your working directory. '
  + 'It is a disposable copy: nothing you do to it reaches anything real, and nothing outside it exists '
  + 'for this task — no package registry, no network, and no memory of a similar project. '
  + 'Make the change the task describes by editing files in place. Change what the task needs and nothing '
  + 'else: do not reformat files you did not have to touch, do not delete or weaken an existing test, and '
  + 'do not edit a file the repository marks as generated. '
  + 'Follow the conventions this repository already uses rather than introducing your own.';

function task(fields: {
  slug: string;
  capabilityUnderTest: string;
  user: string;
  requiredPaths: string[];
  permittedPaths: string[];
  assertions: DevelopmentAssertion[];
  tags: string[];
}): DevelopmentTask {
  return makeDevelopmentTask({
    id: `task.dev.multi-file-edit.${fields.slug}`,
    suiteID: MULTI_FILE_EDIT_SUITE_ID,
    suiteVersion: MULTI_FILE_EDIT_SUITE_VERSION,
    dimension: 'multiFileEditing',
    kind: 'repositoryEdit',
    capabilityUnderTest: fields.capabilityUnderTest,
    fixtureRepoID: ledgerlite.id,
    fixtureRepoVersion: ledgerlite.version,
    fixtureRepoDigest: fixtureRepoDigest(ledgerlite),
    prompt: { system: SYSTEM_PROMPT, user: fields.user },
    requiredPaths: fields.requiredPaths,
    permittedPaths: fields.permittedPaths,
    assertions: fields.assertions,
    // Fifteen minutes. An edit task is several file reads, several writes and at least one reread;
    // a budget that made "it ran out of time" a plausible explanation would make every failure
    // ambiguous between capability and clock.
    executionBudgetMilliseconds: 900_000,
    plannedRepetitions: 1,
    scoringContractID: DEVELOPMENT_SCORING_CONTRACT_ID,
    scoringContractVersion: DEVELOPMENT_SCORING_CONTRACT_VERSION,
    provenance: PROVENANCE,
    tags: fields.tags,
  });
}

// MARK: - Assertion helpers

function changed(id: string, path: string, purpose: string, metric = 'requiredFilesPresent'): DevelopmentAssertion {
  return { id, purpose, metric, visibility: 'stated', predicate: { kind: 'changedFromBaseline', path } };
}
function untouched(id: string, path: string, purpose: string): DevelopmentAssertion {
  return { id, purpose, metric: 'unrelatedFilesUntouched', visibility: 'stated', predicate: { kind: 'unchangedFromBaseline', path } };
}
function scopeFence(id: string, paths: string[]): DevelopmentAssertion {
  return {
    id, purpose: 'nothing outside the task was added, removed or rewritten',
    metric: 'churnRestraint', visibility: 'stated', predicate: { kind: 'onlyTheseTouched', paths },
  };
}
function held(id: string, metric: string, purpose: string, predicate: DevelopmentAssertion['predicate'],
              shortcutProbe = false): DevelopmentAssertion {
  return { id, purpose, metric, visibility: 'heldOut', predicate, shortcutProbe };
}
function stated(id: string, metric: string, purpose: string, predicate: DevelopmentAssertion['predicate']): DevelopmentAssertion {
  return { id, purpose, metric, visibility: 'stated', predicate };
}

// MARK: - 1 · A new region with a surcharge: config, a new stage, the pipeline, and a test

const PIPELINE = 'src/core/charge-pipeline.js';
const RATES = 'src/config/rates.json';
const SURCHARGE_STAGE = 'src/core/stages/surcharge.js';
const CHARGES_TEST = 'test/charges.test.js';

const addRegionSurcharge = task({
  slug: 'add-region-surcharge',
  capabilityUnderTest: 'adds a pipeline stage, its data and its test, and keeps the pipeline\'s own declaration of itself correct',
  user:
    'This package is launching in a new region, `eu-north`, which charges a fixed per-charge surcharge on top '
    + 'of tax.\n\n'
    + 'Make these true:\n\n'
    + '  1. `eu-north` has a tax rate of 250 thousandths, alongside the regions that already exist.\n'
    + '  2. `eu-north` carries a surcharge of 150 minor units. No other region has a surcharge, and the '
    + 'behaviour of every existing region is completely unchanged.\n'
    + '  3. The surcharge is applied after tax and before the amount is rounded into minor units.\n'
    + '  4. The new behaviour is implemented in a new stage module at `src/core/stages/surcharge.js`, in the '
    + 'same shape as the stages that are already there.\n'
    + '  5. There is a test covering a charge in the new region.\n\n'
    + 'Leave the schema, the generated module, the arithmetic helper and the rounding tests exactly as they '
    + 'are; none of them has anything to do with this change.',
  requiredPaths: [RATES, SURCHARGE_STAGE, PIPELINE, CHARGES_TEST],
  permittedPaths: ['CHANGELOG.md', 'README.md'],
  assertions: [
    // Did each required file move at all? This is the gate a one-file patch cannot pass.
    changed('surcharge.required.rates', RATES, 'the new region and its surcharge are data'),
    changed('surcharge.required.stage', SURCHARGE_STAGE, 'the new stage module exists'),
    changed('surcharge.required.pipeline', PIPELINE, 'something has to run the new stage'),
    changed('surcharge.required.test', CHARGES_TEST, 'the new behaviour is covered'),

    // Are the edits in the right PLACE, rather than merely present somewhere?
    held('surcharge.place.stage-exports', 'correctFilesEdited',
      'the new module exports a stage function the way every other stage in this repository does',
      { kind: 'matches', path: SURCHARGE_STAGE, pattern: 'module\\.exports\\s*=\\s*\\{', flags: '' }),
    held('surcharge.place.pipeline-requires', 'correctFilesEdited',
      'the pipeline reaches the stage by requiring its module, not by inlining the arithmetic',
      { kind: 'matches', path: PIPELINE, pattern: "require\\(['\"]\\./stages/surcharge['\"]\\)", flags: '' }),
    held('surcharge.place.data-in-config', 'correctFilesEdited',
      'the surcharge amount lives in the config table this repository already keeps region data in',
      { kind: 'matches', path: RATES, pattern: '150', flags: '' }),

    // The held-out half: this repository declares its own stage order, and the declaration must stay true.
    held('surcharge.correct.stages-constant', 'implementationCorrectness',
      'STAGES is the pipeline\'s declaration of what it runs; a stage wired in without being named there leaves the module describing itself incorrectly',
      { kind: 'matches', path: PIPELINE, pattern: "STAGES\\s*=\\s*\\[[^\\]]*['\"]surcharge['\"]", flags: '' }),
    held('surcharge.correct.order', 'implementationCorrectness',
      'the surcharge is applied after tax and before rounding, which is visible in the order the pipeline calls them',
      { kind: 'matches', path: PIPELINE, pattern: 'function\\s+runChargePipeline[\\s\\S]*applyTax[\\s\\S]*surcharge[\\s\\S]*roundTotal', flags: 'i' }),
    held('surcharge.correct.applies-to-amount', 'implementationCorrectness',
      'the surcharge adjusts the decimal amount that rounding then converts, rather than being added to the rounded total afterwards — which is what "after tax and before rounding" means in this pipeline',
      { kind: 'lacksPhrase', path: SURCHARGE_STAGE, phrase: 'total' }),
    stated('surcharge.correct.tax-rate', 'implementationCorrectness',
      'the new region carries the tax rate the task named',
      { kind: 'jsonEquals', path: RATES, pointer: '/taxRatesMilli/eu-north', value: 250 }),

    // Shortcut probes: the stage must read its data rather than know the answer.
    held('surcharge.shortcut.no-hardcoded-region', 'implementationCorrectness',
      'a stage that names the region in its own source has hard-coded the case rather than reading the table',
      { kind: 'lacksPhrase', path: SURCHARGE_STAGE, phrase: 'eu-north' }, true),
    held('surcharge.shortcut.rates-survive', 'implementationCorrectness',
      'the existing regions are still in the table; removing one to simplify the change is not a change that works',
      { kind: 'jsonEquals', path: RATES, pointer: '/taxRatesMilli/us-east', value: 65 }, true),

    // Tests: something new, and nothing old removed.
    held('surcharge.tests.covers-region', 'testsAddedOrUpdated',
      'the new test actually exercises the new region',
      { kind: 'containsPhrase', path: CHARGES_TEST, phrase: 'eu-north' }),
    held('surcharge.tests.count', 'testsAddedOrUpdated',
      'a test was added rather than an existing one being repurposed',
      { kind: 'occursAtLeast', path: CHARGES_TEST, pattern: "test\\(", minimum: 4 }),
    stated('surcharge.preserved.tax-test', 'existingTestsPreserved',
      'the existing regional-tax test is still there',
      { kind: 'containsPhrase', path: CHARGES_TEST, phrase: 'applies the regional tax rate and rounds to minor units' }),
    stated('surcharge.preserved.unknown-region-test', 'existingTestsPreserved',
      'the existing unknown-region test is still there',
      { kind: 'containsPhrase', path: CHARGES_TEST, phrase: 'refuses a region with no configured rate' }),
    stated('surcharge.preserved.missing-field-test', 'existingTestsPreserved',
      'the existing required-field test is still there',
      { kind: 'containsPhrase', path: CHARGES_TEST, phrase: 'refuses a request missing a required field' }),
    untouched('surcharge.preserved.money-test', 'test/money.test.js', 'the rounding tests have nothing to do with a surcharge'),

    // Untouched, and structurally still a repository.
    untouched('surcharge.untouched.generated', 'src/schema/generated/charge-fields.js', 'the generated module is downstream of the schema, which does not change here'),
    untouched('surcharge.untouched.schema', 'src/schema/charge.schema.json', 'no field is added to a charge by this task'),
    untouched('surcharge.untouched.money', 'src/util/money.js', 'the arithmetic helper is not involved'),
    untouched('surcharge.untouched.rounding-cases', 'test/cases/rounding.cases.json', 'no rounding case changes'),
    stated('surcharge.valid.rates-json', 'repositoryStructurallyValid', 'the config file still parses',
      { kind: 'parsesAsJSON', path: RATES }),
    stated('surcharge.valid.package-json', 'repositoryStructurallyValid', 'package.json still parses',
      { kind: 'parsesAsJSON', path: 'package.json' }),
    scopeFence('surcharge.scope', [RATES, SURCHARGE_STAGE, PIPELINE, CHARGES_TEST, 'CHANGELOG.md', 'README.md']),
  ],
  tags: ['new-stage', 'config-data', 'pipeline'],
});

// MARK: - 2 · Fix the latent defect, cover it, and record it

const MONEY = 'src/util/money.js';
const ROUNDING_CASES = 'test/cases/rounding.cases.json';
const CHANGELOG = 'CHANGELOG.md';

const fixNegativeRounding = task({
  slug: 'fix-negative-rounding',
  capabilityUnderTest: 'fixes a defect at its cause, covers it by the repository\'s own convention, and records it',
  user:
    'Refunds are wrong. A charge of 10.125 correctly becomes 1013 minor units, but a refund of -10.125 becomes '
    + '-1012 instead of -1013.\n\n'
    + 'Rounding in this package must be half away from zero: a value exactly halfway between two minor units '
    + 'rounds to the one further from zero, whichever sign it has.\n\n'
    + 'Make these true:\n\n'
    + '  1. The rounding behaviour is correct for negative amounts, and unchanged for positive ones.\n'
    + '  2. The defect is covered, in whichever place this repository already keeps its rounding cases.\n'
    + '  3. The change is recorded in the changelog, in the format the changelog already uses.\n\n'
    + 'Do not change the rounding stage, the pipeline, the schema, the generated module or the config; the '
    + 'defect is not in any of them.',
  requiredPaths: [MONEY, ROUNDING_CASES, CHANGELOG],
  permittedPaths: [],
  assertions: [
    changed('rounding.required.money', MONEY, 'the defect is fixed where it lives'),
    changed('rounding.required.cases', ROUNDING_CASES, 'the defect is covered'),
    changed('rounding.required.changelog', CHANGELOG, 'the change is recorded'),

    held('rounding.place.sign-aware', 'correctFilesEdited',
      'the fix distinguishes the sign of the amount, by whichever of the several correct spellings',
      { kind: 'matches', path: MONEY, pattern: 'Math\\.sign|Math\\.abs|Math\\.trunc|<\\s*0|>=\\s*0|>\\s*0', flags: '' }),
    held('rounding.place.still-exported', 'correctFilesEdited',
      'the helper is still exported under the names the rest of the package requires',
      { kind: 'matches', path: MONEY, pattern: 'module\\.exports\\s*=\\s*\\{[^}]*toMinorUnits', flags: '' }),

    held('rounding.correct.negative-case', 'implementationCorrectness',
      'a negative amount is now among the golden cases',
      { kind: 'matches', path: ROUNDING_CASES, pattern: '"amount"\\s*:\\s*-', flags: '' }),
    held('rounding.correct.negative-expectation', 'implementationCorrectness',
      'the new case expects a negative number of minor units, rather than covering a negative input with a positive expectation',
      { kind: 'matches', path: ROUNDING_CASES, pattern: '"expectedMinorUnits"\\s*:\\s*-', flags: '' }),
    held('rounding.correct.changelog-format', 'implementationCorrectness',
      'the changelog entry follows the version-heading format the file already uses',
      { kind: 'matches', path: CHANGELOG, pattern: '^##\\s+\\d+\\.\\d+\\.\\d+', flags: 'm' }),

    held('rounding.shortcut.no-magic-value', 'implementationCorrectness',
      'a fix that names the failing value in the helper has special-cased the test rather than the behaviour',
      { kind: 'lacksPhrase', path: MONEY, phrase: '10.125' }, true),
    held('rounding.shortcut.helper-not-emptied', 'implementationCorrectness',
      'roundHalfUp is still there; deleting the function the report names is not a fix',
      { kind: 'containsPhrase', path: MONEY, phrase: 'roundHalfUp' }, true),

    held('rounding.tests.case-added', 'testsAddedOrUpdated',
      'the table has more cases than it did',
      { kind: 'occursAtLeast', path: ROUNDING_CASES, pattern: '"expectedMinorUnits"', minimum: 4 }),
    stated('rounding.preserved.whole', 'existingTestsPreserved', 'the whole-amount case survives',
      { kind: 'containsPhrase', path: ROUNDING_CASES, phrase: 'whole amount' }),
    stated('rounding.preserved.decimals', 'existingTestsPreserved', 'the two-decimal case survives',
      { kind: 'containsPhrase', path: ROUNDING_CASES, phrase: 'two decimal places' }),
    stated('rounding.preserved.half', 'existingTestsPreserved', 'the exact-half case survives',
      { kind: 'containsPhrase', path: ROUNDING_CASES, phrase: 'exact half rounds up' }),
    untouched('rounding.preserved.money-test', 'test/money.test.js', 'a case goes in the table, not in the test module'),
    untouched('rounding.preserved.charges-test', CHARGES_TEST, 'the charge tests are unaffected'),

    untouched('rounding.untouched.round-stage', 'src/core/stages/round.js', 'the stage merely calls the helper'),
    untouched('rounding.untouched.pipeline', PIPELINE, 'the pipeline is not involved'),
    untouched('rounding.untouched.rates', RATES, 'no configuration changes'),
    untouched('rounding.untouched.generated', 'src/schema/generated/charge-fields.js', 'the generated module is not involved'),
    stated('rounding.valid.cases-json', 'repositoryStructurallyValid', 'the case table still parses',
      { kind: 'parsesAsJSON', path: ROUNDING_CASES }),
    stated('rounding.valid.cases-array', 'repositoryStructurallyValid', 'the case table still carries a cases array',
      { kind: 'jsonHasPointer', path: ROUNDING_CASES, pointer: '/cases/0/expectedMinorUnits' }),
    scopeFence('rounding.scope', [MONEY, ROUNDING_CASES, CHANGELOG]),
  ],
  tags: ['defect', 'golden-cases', 'convention'],
});

// MARK: - 3 · Make a setting that is already declared actually do something

const ROUND_STAGE = 'src/core/stages/round.js';
const MONEY_TEST = 'test/money.test.js';

const honourRoundingMode = task({
  slug: 'honour-rounding-mode',
  capabilityUnderTest: 'threads a new parameter through an implementation, its caller, its case table and its test module at once',
  user:
    'This package can only round one way. It needs a second mode, half-to-even — the mode that rounds an '
    + 'exact half to whichever neighbouring minor unit is even, so 10.125 becomes 1012 rather than 1013.\n\n'
    + 'Make these true:\n\n'
    + '  1. The arithmetic helper can round in either mode. When no mode is asked for it must behave exactly '
    + 'as it does today, so that every existing caller and every existing case is unaffected.\n'
    + '  2. The rounding stage rounds in whichever mode this repository is already configured for. The '
    + 'configuration for it already exists; find it and read it rather than adding another.\n'
    + '  3. The golden case table can express which mode a case is for, and carries at least one case for the '
    + 'new mode.\n'
    + '  4. The test module passes each case\'s mode through.\n\n'
    + 'Do not change the configuration file, the pipeline, the schema, the generated module or the charge tests.',
  requiredPaths: [MONEY, ROUND_STAGE, ROUNDING_CASES, MONEY_TEST],
  permittedPaths: ['CHANGELOG.md', 'README.md'],
  assertions: [
    changed('mode.required.money', MONEY, 'the helper gains the second mode'),
    changed('mode.required.stage', ROUND_STAGE, 'the stage passes the configured mode'),
    changed('mode.required.cases', ROUNDING_CASES, 'the table can express a mode'),
    changed('mode.required.test', MONEY_TEST, 'the test module passes it through'),

    held('mode.place.helper-takes-mode', 'correctFilesEdited',
      'the helper takes the mode as a parameter rather than reading configuration itself',
      { kind: 'matches', path: MONEY, pattern: 'function\\s+toMinorUnits\\s*\\([^)]*,[^)]*,', flags: '' }),
    held('mode.place.stage-reads-config', 'correctFilesEdited',
      'the stage reads the setting that already exists rather than a new one it invented',
      { kind: 'containsPhrase', path: ROUND_STAGE, phrase: 'roundingMode' }),

    held('mode.correct.even-implemented', 'implementationCorrectness',
      'half-to-even is actually implemented, not merely named',
      { kind: 'matches', path: MONEY, pattern: '%\\s*2|halfEven|half-even|even', flags: 'i' }),
    held('mode.correct.default-preserved', 'implementationCorrectness',
      'the existing behaviour is still the default, which is what keeps every existing case passing',
      { kind: 'matches', path: MONEY, pattern: "=\\s*['\"]halfUp['\"]|\\|\\|\\s*['\"]halfUp['\"]|===\\s*['\"]halfEven['\"]", flags: '' }),
    held('mode.correct.case-carries-mode', 'implementationCorrectness',
      'a case in the table names the new mode',
      { kind: 'matches', path: ROUNDING_CASES, pattern: 'halfEven|half-even|bankers', flags: 'i' }),
    held('mode.correct.test-threads-mode', 'implementationCorrectness',
      'the test module hands each case its mode, rather than hard-coding one',
      { kind: 'matches', path: MONEY_TEST, pattern: '\\.mode|\\[.mode.\\]', flags: '' }),

    held('mode.shortcut.config-not-duplicated', 'implementationCorrectness',
      'the setting was read from where it already lives; adding a second one leaves two sources of truth',
      { kind: 'unchangedFromBaseline', path: RATES }, true),
    held('mode.shortcut.no-hardcoded-expectation', 'implementationCorrectness',
      'the helper does not name the example value from the task text',
      { kind: 'lacksPhrase', path: MONEY, phrase: '1012' }, true),

    held('mode.tests.case-added', 'testsAddedOrUpdated', 'the table has more cases than it did',
      { kind: 'occursAtLeast', path: ROUNDING_CASES, pattern: '"expectedMinorUnits"', minimum: 4 }),
    stated('mode.tests.module-still-reads-table', 'testsAddedOrUpdated',
      'the test module still drives itself from the table rather than growing inline assertions',
      { kind: 'containsPhrase', path: MONEY_TEST, phrase: 'rounding.cases.json' }),
    stated('mode.preserved.whole', 'existingTestsPreserved', 'the whole-amount case survives',
      { kind: 'containsPhrase', path: ROUNDING_CASES, phrase: 'whole amount' }),
    stated('mode.preserved.decimals', 'existingTestsPreserved', 'the two-decimal case survives',
      { kind: 'containsPhrase', path: ROUNDING_CASES, phrase: 'two decimal places' }),
    stated('mode.preserved.half', 'existingTestsPreserved', 'the exact-half case survives',
      { kind: 'containsPhrase', path: ROUNDING_CASES, phrase: 'exact half rounds up' }),
    untouched('mode.preserved.charges-test', CHARGES_TEST, 'the charge tests are unaffected'),

    untouched('mode.untouched.rates', RATES, 'the setting is already there; this task adds no configuration'),
    untouched('mode.untouched.pipeline', PIPELINE, 'the pipeline is not involved'),
    untouched('mode.untouched.schema', 'src/schema/charge.schema.json', 'no field changes'),
    untouched('mode.untouched.generated', 'src/schema/generated/charge-fields.js', 'the generated module is not involved'),
    stated('mode.valid.cases-json', 'repositoryStructurallyValid', 'the case table still parses',
      { kind: 'parsesAsJSON', path: ROUNDING_CASES }),
    scopeFence('mode.scope', [MONEY, ROUND_STAGE, ROUNDING_CASES, MONEY_TEST, 'CHANGELOG.md', 'README.md']),
  ],
  tags: ['threading', 'configuration', 'defaults'],
});

export const multiFileEditSuite: DevelopmentSuite = makeDevelopmentSuite(
  MULTI_FILE_EDIT_SUITE_ID,
  MULTI_FILE_EDIT_SUITE_VERSION,
  'Cernum Multi-File Editing',
  'multiFileEditing',
  [addRegionSurcharge, fixNegativeRounding, honourRoundingMode],
);
