// Cernum development benchmark · Pass 3 — the multi-file-editing suite.
//
// The three tasks are graded here against reference solutions that were separately materialized and
// run: `test/engine/fixtures/ledgerlite-solutions.ts` produces repositories whose own `node --test`
// run passes. That matters because an edit task whose assertions no correct change satisfies is a
// broken task, and nothing but writing the change and grading it can tell you.
//
// Each near-miss below changes ONE thing about a correct solution and asserts that ONE metric moves.
// That is the property that makes a development score readable: a failure says which of the four
// jobs — right files, right place, tests kept, nothing else touched — was not done.

import { describe, expect, it } from 'vitest';

import {
  developmentCatalogDigest, developmentSuites, developmentTaskByID, developmentTaskCount,
  validateDevelopmentCatalog,
} from '../../src/core/development-catalog';
import {
  DevelopmentTask, developmentComparabilityKey, developmentSuiteDigest, developmentTaskDigest,
} from '../../src/core/development-benchmark';
import {
  MULTI_FILE_EDIT_SUITE_ID, multiFileEditSuite,
} from '../../src/core/development-suites/multi-file-edit';
import { gradeRepositoryEdit } from '../../src/core/development-evaluation';
import { ledgerlite } from '../../src/core/development-fixtures/ledgerlite';
import { MINIMUM_REQUIRED_FILES_FOR_MULTI_FILE_EDIT } from '../../src/core/development-scoring';
import { createIsolatedWorkspace } from '../../src/engine/isolation';
import { contract1EquivalentTask } from '../../src/engine/development-reinterpretation';
import {
  MAX_WORKSPACE_FILE_BYTES, isRefusedContent, materializeFixture, readWorkspaceSnapshot,
} from '../../src/engine/development-workspace';
import {
  Patch, REFERENCE_SOLUTIONS, apply, solveAddRegionSurcharge, solveFixNegativeRounding,
  solveHonourRoundingMode,
} from './fixtures/ledgerlite-solutions';

const SUITE_DIGEST = 'mldsu1:78f9d09d98ffe36e';
const CATALOG_DIGEST = 'mldcat1:e1b1b0c3743be9e1';
/** What `dev-cohort-2` recorded under contract 1. Contract 2 changed no edit task but its version. */
const CONTRACT_1_SUITE_DIGEST = 'mldsu1:80a769c6475321da';

const SURCHARGE = 'task.dev.multi-file-edit.add-region-surcharge';
const ROUNDING = 'task.dev.multi-file-edit.fix-negative-rounding';
const MODE = 'task.dev.multi-file-edit.honour-rounding-mode';

const identityOf = (task: DevelopmentTask) => ({
  taskDigest: developmentTaskDigest(task),
  comparabilityKey: developmentComparabilityKey(task),
});

function gradeWith(taskID: string, ...patches: Patch[]) {
  const task = developmentTaskByID(taskID)!;
  return gradeRepositoryEdit(task, ledgerlite, apply(...patches), identityOf(task));
}

type Graded = ReturnType<typeof gradeWith>;

const failedMetrics = (result: Graded): string[] =>
  result.grade.metrics.filter((metric) => metric.status === 'fail').map((metric) => metric.id).sort();

const failedAssertions = (result: Graded): string[] =>
  result.outcomes.filter((outcome) => !outcome.held).map((outcome) => outcome.id).sort();

describe('the multi-file-editing suite', () => {
  it('registers three edit tasks beside the understanding suite, and seals to pinned digests', () => {
    expect(() => validateDevelopmentCatalog()).not.toThrow();
    expect(developmentSuites.map((suite) => suite.id)).toContain(MULTI_FILE_EDIT_SUITE_ID);
    expect(multiFileEditSuite.tasks).toHaveLength(3);
    expect(developmentTaskCount()).toBe(10);
    expect(developmentSuiteDigest(multiFileEditSuite)).toBe(SUITE_DIGEST);
    expect(developmentCatalogDigest()).toBe(CATALOG_DIGEST);
    expect(developmentSuiteDigest({ ...multiFileEditSuite, tasks: multiFileEditSuite.tasks.map(contract1EquivalentTask) }))
      .toBe(CONTRACT_1_SUITE_DIGEST);
  });

  it('makes every task genuinely multi-file, and tells the candidate what is out of bounds', () => {
    for (const task of multiFileEditSuite.tasks) {
      expect(task.kind, task.id).toBe('repositoryEdit');
      expect(task.requiredPaths.length, task.id).toBeGreaterThanOrEqual(MINIMUM_REQUIRED_FILES_FOR_MULTI_FILE_EDIT);
      expect(task.prompt.user, task.id).toMatch(/Do not change|Leave the schema/);
      expect(task.prompt.system).toContain('do not edit a file the repository marks as generated');
      expect(task.assertions.some((assertion) => assertion.visibility === 'heldOut'), task.id).toBe(true);
      expect(task.assertions.some((assertion) => assertion.shortcutProbe === true), task.id).toBe(true);
    }
  });

  it('gives every required path its own presence assertion, so an omission cannot be averaged away', () => {
    for (const task of multiFileEditSuite.tasks) {
      const presenceChecks = task.assertions.filter((assertion) => assertion.metric === 'requiredFilesPresent');
      const covered = presenceChecks.map((assertion) =>
        'path' in assertion.predicate ? assertion.predicate.path : '').sort();
      expect(covered, task.id).toEqual([...task.requiredPaths].sort());
    }
  });

  it('spreads its assertions across the metrics the brief named', () => {
    for (const task of multiFileEditSuite.tasks) {
      const metrics = new Set(task.assertions.map((assertion) => assertion.metric));
      for (const required of [
        'requiredFilesPresent', 'correctFilesEdited', 'implementationCorrectness',
        'testsAddedOrUpdated', 'existingTestsPreserved', 'unrelatedFilesUntouched',
        'repositoryStructurallyValid', 'churnRestraint',
      ]) expect([...metrics], `${task.id} / ${required}`).toContain(required);
    }
  });
});

describe('a reference solution', () => {
  it('holds every assertion on every task', () => {
    for (const task of multiFileEditSuite.tasks) {
      const result = gradeWith(task.id, REFERENCE_SOLUTIONS[task.id]);
      expect(failedAssertions(result), task.id).toEqual([]);
      expect(result.grade.structuralCredit, task.id).toBe('full');
      expect(result.grade.shortcutSuspected, task.id).toBe(false);
      expect(result.grade.heldOutPassRateMilli, task.id).toEqual({ measured: 1_000 });
    }
  });

  it('still cannot earn full credit, because no test was run', () => {
    const result = gradeWith(ROUNDING, solveFixNegativeRounding);
    expect(result.grade.executedCredit).toBe('notMeasured');
    expect(result.grade.credit).toBe('partial');
    expect(result.grade.creditReason).toContain('newTestsPass');
    expect(result.grade.creditReason).toContain('existingTestsPass');
    expect(result.grade.creditReason).toContain('buildSucceeds');
  });

  it('records the baseline and result snapshots it was graded over', () => {
    const result = gradeWith(SURCHARGE, solveAddRegionSurcharge);
    expect(result.baselineSnapshotDigest).toBe('mldsnap1:aa43e94dc603411');
    expect(result.resultSnapshotDigest).not.toBe(result.baselineSnapshotDigest);
    expect(result.comparabilityKey.startsWith('mldk1:')).toBe(true);
    expect(result.answer).toBeUndefined();
  });
});

describe('a one-file patch cannot score', () => {
  it('fails the required-files gate even when the one file it wrote is perfect', () => {
    const onlyTheHelper: Patch = (files) => {
      const whole = apply(solveFixNegativeRounding);
      files.set('src/util/money.js', whole.get('src/util/money.js')!);
    };
    const result = gradeWith(ROUNDING, onlyTheHelper);

    // The fix itself is right, so `correctFilesEdited` holds. What fails is everything that had to
    // move with it — which is the whole of what this dimension measures.
    expect(result.grade.metrics.find((metric) => metric.id === 'correctFilesEdited')!.status).toBe('pass');
    expect(failedMetrics(result)).toEqual(['implementationCorrectness', 'requiredFilesPresent', 'testsAddedOrUpdated']);
    expect(failedAssertions(result)).toContain('rounding.required.cases');
    expect(failedAssertions(result)).toContain('rounding.required.changelog');
    expect(result.grade.structuralCredit).toBe('partial');
    expect(result.grade.credit).toBe('partial');
  });

  it('fails the gate on the surcharge task too, with only the new stage written', () => {
    const onlyTheStage: Patch = (files) => {
      const whole = apply(solveAddRegionSurcharge);
      files.set('src/core/stages/surcharge.js', whole.get('src/core/stages/surcharge.js')!);
    };
    const result = gradeWith(SURCHARGE, onlyTheStage);
    expect(failedMetrics(result)).toContain('requiredFilesPresent');
    expect(failedAssertions(result)).toContain('surcharge.required.pipeline');
    expect(failedAssertions(result)).toContain('surcharge.required.rates');
    expect(failedAssertions(result)).toContain('surcharge.required.test');
  });
});

describe('each near-miss fails the metric it should', () => {
  it('wires the stage in and forgets the constant that declares the stage order', () => {
    const forgetsTheConstant: Patch = (files) => {
      solveAddRegionSurcharge(files);
      files.set('src/core/charge-pipeline.js', files.get('src/core/charge-pipeline.js')!
        .replace("const STAGES = ['validate', 'tax', 'surcharge', 'round'];", "const STAGES = ['validate', 'tax', 'round'];"));
    };
    const result = gradeWith(SURCHARGE, forgetsTheConstant);
    expect(failedMetrics(result)).toEqual(['implementationCorrectness']);
    expect(failedAssertions(result)).toEqual(['surcharge.correct.stages-constant']);
    // Everything else is right: the files moved, the tests were added, nothing strayed.
    expect(result.grade.metrics.find((metric) => metric.id === 'requiredFilesPresent')!.status).toBe('pass');
    expect(result.grade.metrics.find((metric) => metric.id === 'churnRestraint')!.status).toBe('pass');
  });

  it('adds the surcharge to the rounded total instead of to the amount that gets rounded', () => {
    const afterRounding: Patch = (files) => {
      solveAddRegionSurcharge(files);
      files.set('src/core/stages/surcharge.js', `'use strict';

const rates = require('../../config/rates.json');

function applySurcharge(charge) {
  const table = rates.surchargeMinorUnits || {};
  const surcharge = table[charge.region];
  if (surcharge === undefined) return charge;
  return Object.assign({}, charge, { total: charge.total + surcharge });
}

module.exports = { applySurcharge };
`);
      files.set('src/core/charge-pipeline.js', files.get('src/core/charge-pipeline.js')!
        .replace(
          '  const surcharged = applySurcharge(taxed);\n  return roundTotal(surcharged);',
          '  return applySurcharge(roundTotal(taxed));',
        ));
    };
    const result = gradeWith(SURCHARGE, afterRounding);
    expect(failedAssertions(result)).toEqual(['surcharge.correct.applies-to-amount']);
    expect(failedMetrics(result)).toEqual(['implementationCorrectness']);
  });

  it('deletes an existing test to make the change simpler', () => {
    const deletesATest: Patch = (files) => {
      solveAddRegionSurcharge(files);
      // A second new test is added at the same time, so the test COUNT is not what fails here:
      // what fails is that an existing case was removed, and the metrics must say so separately.
      files.set('test/charges.test.js', files.get('test/charges.test.js')!
        .replace(/test\('refuses a region with no configured rate'[\s\S]*?\n\}\);\n/, '') + `
test('applies no surcharge where none is configured', function () {
  const charge = createCharge({ amount: 100, region: 'apac' });
  assert.strictEqual(charge.total, 11000);
});
`);
    };
    const result = gradeWith(SURCHARGE, deletesATest);
    expect(failedMetrics(result)).toEqual(['existingTestsPreserved']);
    expect(failedAssertions(result)).toEqual(['surcharge.preserved.unknown-region-test']);
    expect(result.grade.metrics.find((metric) => metric.id === 'testsAddedOrUpdated')!.status).toBe('pass');
  });

  it('hand-edits the generated module along the way', () => {
    const editsTheGenerated: Patch = (files) => {
      solveAddRegionSurcharge(files);
      files.set('src/schema/generated/charge-fields.js',
        files.get('src/schema/generated/charge-fields.js')! + '\n// touched by hand\n');
    };
    const result = gradeWith(SURCHARGE, editsTheGenerated);
    expect(failedMetrics(result)).toEqual(['churnRestraint', 'unrelatedFilesUntouched']);
    expect(failedAssertions(result)).toEqual(['surcharge.scope', 'surcharge.untouched.generated']);
    expect(result.grade.structuralCredit).toBe('partial');
  });

  it('leaves a stray file behind, which costs churn and nothing gating', () => {
    const strayFile: Patch = (files) => {
      solveAddRegionSurcharge(files);
      files.set('NOTES.md', 'scratch notes I meant to delete\n');
    };
    const result = gradeWith(SURCHARGE, strayFile);
    expect(failedMetrics(result)).toEqual(['churnRestraint']);
    // churnRestraint is measured and reported, and does not withhold the gate on its own.
    expect(result.grade.structuralCredit).toBe('full');
    expect(result.grade.credit).toBe('partial');
  });

  it('hard-codes the region inside the new stage instead of reading the table', () => {
    const hardCoded: Patch = (files) => {
      solveAddRegionSurcharge(files);
      files.set('src/core/stages/surcharge.js', `'use strict';

function applySurcharge(charge) {
  if (charge.region === 'eu-north') {
    return Object.assign({}, charge, { amount: charge.amount + 1.5 });
  }
  return charge;
}

module.exports = { applySurcharge };
`);
    };
    const result = gradeWith(SURCHARGE, hardCoded);
    expect(result.grade.shortcutSuspected).toBe(true);
    expect(result.grade.shortcutReasons.join(' ')).toContain('surcharge.shortcut.no-hardcoded-region');
    expect(failedMetrics(result)).toContain('implementationCorrectness');
  });

  it('special-cases the failing value inside the rounding helper', () => {
    const magicValue: Patch = (files) => {
      solveFixNegativeRounding(files);
      files.set('src/util/money.js', files.get('src/util/money.js')!
        .replace(
          'function roundHalfUp(value) {',
          'function roundHalfUp(value) {\n  if (value === -1012.5) return -1013; // amount -10.125',
        ));
    };
    const result = gradeWith(ROUNDING, magicValue);
    expect(result.grade.shortcutSuspected).toBe(true);
    expect(result.grade.shortcutReasons.join(' ')).toContain('rounding.shortcut.no-magic-value');
  });

  it('deletes the function the bug report named rather than fixing it', () => {
    const deletesTheHelper: Patch = (files) => {
      solveFixNegativeRounding(files);
      files.set('src/util/money.js', `'use strict';

function toMinorUnits(amount, minorUnits) {
  const factor = Math.pow(10, minorUnits);
  const scaled = amount * factor;
  return scaled < 0 ? -Math.round(-scaled) : Math.round(scaled);
}

module.exports = { toMinorUnits };
`);
    };
    const result = gradeWith(ROUNDING, deletesTheHelper);
    expect(result.grade.shortcutSuspected).toBe(true);
    expect(failedAssertions(result)).toContain('rounding.shortcut.helper-not-emptied');
  });

  it('covers a negative amount with a positive expectation', () => {
    const wrongExpectation: Patch = (files) => {
      solveFixNegativeRounding(files);
      files.set('test/cases/rounding.cases.json', files.get('test/cases/rounding.cases.json')!
        .replace('"expectedMinorUnits": -1013', '"expectedMinorUnits": 1013'));
    };
    const result = gradeWith(ROUNDING, wrongExpectation);
    expect(failedAssertions(result)).toEqual(['rounding.correct.negative-expectation']);
    expect(failedMetrics(result)).toEqual(['implementationCorrectness']);
  });

  it('records the change in prose instead of the changelog format the file uses', () => {
    const wrongFormat: Patch = (files) => {
      solveFixNegativeRounding(files);
      files.set('CHANGELOG.md', 'Fixed the refund rounding bug.\n');
    };
    const result = gradeWith(ROUNDING, wrongFormat);
    expect(failedAssertions(result)).toEqual(['rounding.correct.changelog-format']);
    expect(failedMetrics(result)).toEqual(['implementationCorrectness']);
  });

  it('adds a second configuration key instead of reading the one that is already there', () => {
    const duplicatesConfig: Patch = (files) => {
      solveHonourRoundingMode(files);
      const document = JSON.parse(files.get('src/config/rates.json')!) as Record<string, unknown>;
      document.roundingStrategy = 'halfEven';
      files.set('src/config/rates.json', JSON.stringify(document, null, 2) + '\n');
      files.set('src/core/stages/round.js', files.get('src/core/stages/round.js')!
        .replace('rates.roundingMode', 'rates.roundingStrategy'));
    };
    const result = gradeWith(MODE, duplicatesConfig);
    expect(result.grade.shortcutSuspected).toBe(true);
    expect(failedMetrics(result)).toEqual(['churnRestraint', 'correctFilesEdited', 'implementationCorrectness', 'unrelatedFilesUntouched']);
    expect(failedAssertions(result)).toContain('mode.shortcut.config-not-duplicated');
    expect(failedAssertions(result)).toContain('mode.place.stage-reads-config');
  });

  it('changes the helper signature and forgets to thread the mode through the test module', () => {
    const forgetsTheTest: Patch = (files) => {
      solveHonourRoundingMode(files);
      files.set('test/money.test.js', apply().get('test/money.test.js')!);
    };
    const result = gradeWith(MODE, forgetsTheTest);
    expect(failedMetrics(result)).toEqual(['implementationCorrectness', 'requiredFilesPresent']);
    expect(failedAssertions(result)).toEqual(['mode.correct.test-threads-mode', 'mode.required.test']);
  });

  it('breaks a data file it edited', () => {
    const brokenJSON: Patch = (files) => {
      solveFixNegativeRounding(files);
      files.set('test/cases/rounding.cases.json', '{ "cases": [ this is not json ');
    };
    const result = gradeWith(ROUNDING, brokenJSON);
    expect(failedMetrics(result)).toContain('repositoryStructurallyValid');
    expect(failedAssertions(result)).toContain('rounding.valid.cases-json');
    expect(failedAssertions(result)).toContain('rounding.valid.cases-array');
  });

  it('does nothing at all', () => {
    const result = gradeWith(SURCHARGE);
    expect(result.grade.structuralCredit).toBe('partial');
    expect(result.grade.credit).toBe('partial');
    expect(failedMetrics(result)).toEqual([
      'correctFilesEdited', 'implementationCorrectness', 'requiredFilesPresent', 'testsAddedOrUpdated',
    ]);
    // Nothing was broken either, and the benchmark says so rather than reporting one flat failure.
    expect(result.grade.metrics.find((metric) => metric.id === 'unrelatedFilesUntouched')!.status).toBe('pass');
    expect(result.grade.metrics.find((metric) => metric.id === 'existingTestsPreserved')!.status).toBe('pass');
  });

  it('deletes the repository', () => {
    const scorchedEarth: Patch = (files) => {
      for (const key of [...files.keys()]) files.delete(key);
    };
    const result = gradeWith(SURCHARGE, scorchedEarth);
    expect(result.grade.structuralCredit).toBe('none');
    expect(result.grade.credit).toBe('none');
    expect(result.grade.metrics.filter((metric) => metric.status === 'pass')).toHaveLength(0);
  });
});

describe('the disposable workspace', () => {
  it('materializes a fixture and reads back exactly what was placed', () => {
    const workspace = createIsolatedWorkspace('cernum-development-test-');
    try {
      materializeFixture(workspace, ledgerlite);
      const reading = readWorkspaceSnapshot(workspace);
      expect(reading.bounded).toBe(false);
      expect(reading.warnings).toEqual([]);
      expect(reading.fileCount).toBe(ledgerlite.files.length);
      for (const file of ledgerlite.files) {
        expect(reading.snapshot.get(file.path), file.path).toBe(file.contents);
      }
    } finally {
      workspace.dispose();
    }
  });

  it('grades an edit made through the real filesystem exactly as it grades one made in memory', () => {
    const workspace = createIsolatedWorkspace('cernum-development-test-');
    try {
      materializeFixture(workspace, ledgerlite);
      for (const [path, contents] of apply(solveFixNegativeRounding)) workspace.placeFixture(path, contents);
      const reading = readWorkspaceSnapshot(workspace);
      const task = developmentTaskByID(ROUNDING)!;
      const fromDisk = gradeRepositoryEdit(task, ledgerlite, reading.snapshot, identityOf(task));
      const inMemory = gradeWith(ROUNDING, solveFixNegativeRounding);
      expect(fromDisk.resultSnapshotDigest).toBe(inMemory.resultSnapshotDigest);
      expect(failedAssertions(fromDisk)).toEqual([]);
    } finally {
      workspace.dispose();
    }
  });

  it('refuses an oversized file by name, rather than dropping it or reading it', () => {
    const workspace = createIsolatedWorkspace('cernum-development-test-');
    try {
      materializeFixture(workspace, ledgerlite);
      workspace.placeFixture('build/enormous.log', 'x'.repeat(MAX_WORKSPACE_FILE_BYTES + 1));
      const reading = readWorkspaceSnapshot(workspace);
      expect(reading.bounded).toBe(true);
      expect(reading.warnings.join(' ')).toContain('build/enormous.log');
      expect(isRefusedContent(reading.snapshot.get('build/enormous.log')!)).toBe(true);
      // The rest of the repository is still readable and still grades normally.
      expect(reading.snapshot.get('src/util/money.js')).toBe(
        ledgerlite.files.find((file) => file.path === 'src/util/money.js')!.contents);
    } finally {
      workspace.dispose();
    }
  });

  it('counts a file an attempt wrote outside the task as churn, read back from disk', () => {
    const workspace = createIsolatedWorkspace('cernum-development-test-');
    try {
      materializeFixture(workspace, ledgerlite);
      for (const [path, contents] of apply(solveFixNegativeRounding)) workspace.placeFixture(path, contents);
      workspace.placeFixture('build/output.txt', 'leftover\n');
      const task = developmentTaskByID(ROUNDING)!;
      const result = gradeRepositoryEdit(task, ledgerlite, readWorkspaceSnapshot(workspace).snapshot, identityOf(task));
      expect(failedMetrics(result)).toEqual(['churnRestraint']);
      expect(result.outcomes.find((outcome) => outcome.id === 'rounding.scope')!.detail).toContain('build/output.txt');
    } finally {
      workspace.dispose();
    }
  });
});
