// Test material · reference solutions to the multi-file-editing tasks.
//
// These are not shipped and are not an answer key a candidate could reach. They exist so the suite
// can be proven SOLVABLE — a task whose assertions no correct change satisfies is a broken task, and
// the only way to know is to write the change and grade it — and so each deliberate near-miss can be
// aimed at exactly one metric.
//
// Each solution is expressed as a patch over the sealed baseline snapshot rather than as a whole
// repository, so a change to the fixture shows up here as a failing anchor rather than as a silently
// diverging copy.

import { RepoSnapshot, snapshotOf } from '../../../src/core/development-fixture';
import { ledgerlite } from '../../../src/core/development-fixtures/ledgerlite';

export type Patch = (files: Map<string, string>) => void;

export function apply(...patches: Patch[]): Map<string, string> {
  const files = new Map(snapshotOf(ledgerlite));
  for (const patch of patches) patch(files);
  return files;
}

export const baseline: RepoSnapshot = snapshotOf(ledgerlite);

function edit(files: Map<string, string>, path: string, change: (text: string) => string): void {
  const before = files.get(path);
  if (before === undefined) throw new Error(`the fixture no longer contains ${path}; a reference solution is anchored to it`);
  const after = change(before);
  if (after === before) throw new Error(`the reference solution's edit to ${path} changed nothing; its anchor has drifted`);
  files.set(path, after);
}

// MARK: - 1 · add-region-surcharge

const SURCHARGE_STAGE_SOURCE = `// Stage 2b - apply the region's fixed surcharge, where one is configured.
'use strict';

const rates = require('../../config/rates.json');

function applySurcharge(charge) {
  const table = rates.surchargeMinorUnits || {};
  const surcharge = table[charge.region];
  if (surcharge === undefined) return charge;
  return Object.assign({}, charge, { amount: charge.amount + surcharge / Math.pow(10, rates.minorUnits) });
}

module.exports = { applySurcharge };
`;

export const solveAddRegionSurcharge: Patch = (files) => {
  edit(files, 'src/config/rates.json', (text) => {
    const document = JSON.parse(text) as Record<string, unknown> & { taxRatesMilli: Record<string, number> };
    document.taxRatesMilli = { ...document.taxRatesMilli, 'eu-north': 250 };
    (document as Record<string, unknown>).surchargeMinorUnits = { 'eu-north': 150 };
    return JSON.stringify(document, null, 2) + '\n';
  });
  files.set('src/core/stages/surcharge.js', SURCHARGE_STAGE_SOURCE);
  edit(files, 'src/core/charge-pipeline.js', (text) => text
    .replace(
      "const { roundTotal } = require('./stages/round');",
      "const { applySurcharge } = require('./stages/surcharge');\nconst { roundTotal } = require('./stages/round');",
    )
    .replace(
      "const STAGES = ['validate', 'tax', 'round'];",
      "const STAGES = ['validate', 'tax', 'surcharge', 'round'];",
    )
    .replace(
      '  const taxed = applyTax(request);\n  return roundTotal(taxed);',
      '  const taxed = applyTax(request);\n  const surcharged = applySurcharge(taxed);\n  return roundTotal(surcharged);',
    ));
  edit(files, 'test/charges.test.js', (text) => text + `
test('adds the configured surcharge for the new region', function () {
  const charge = createCharge({ amount: 100, region: 'eu-north' });
  assert.strictEqual(charge.total, 12650);
});
`);
};

// MARK: - 2 · fix-negative-rounding

export const solveFixNegativeRounding: Patch = (files) => {
  edit(files, 'src/util/money.js', (text) => text
    .replace('// Half-up rounding for amounts.', '// Half-away-from-zero rounding, for amounts of either sign.')
    .replace(
      'function roundHalfUp(value) {\n  return Math.round(value);\n}',
      'function roundHalfUp(value) {\n  return value < 0 ? -Math.round(-value) : Math.round(value);\n}',
    ));
  edit(files, 'test/cases/rounding.cases.json', (text) => {
    const document = JSON.parse(text) as { cases: unknown[] };
    document.cases.push({ name: 'negative exact half rounds away from zero', amount: -10.125, minorUnits: 2, expectedMinorUnits: -1013 });
    return JSON.stringify(document, null, 2) + '\n';
  });
  edit(files, 'CHANGELOG.md', (text) => text.replace(
    '# Changelog\n',
    '# Changelog\n\n## 0.4.2\n- Rounded negative amounts away from zero, as positive amounts already were.\n',
  ));
};

// MARK: - 3 · honour-rounding-mode

const MONEY_WITH_MODES = `// Money arithmetic.
//
// Amounts arrive as decimal major units and leave as integer minor units.
'use strict';

// Half-up rounding for amounts.
function roundHalfUp(value) {
  return Math.round(value);
}

// Half-to-even: an exact half goes to whichever neighbour is even.
function roundHalfEven(value) {
  const lower = Math.floor(value);
  const remainder = value - lower;
  if (remainder > 0.5) return lower + 1;
  if (remainder < 0.5) return lower;
  return lower % 2 === 0 ? lower : lower + 1;
}

function toMinorUnits(amount, minorUnits, mode) {
  const factor = Math.pow(10, minorUnits);
  const scaled = amount * factor;
  return mode === 'halfEven' ? roundHalfEven(scaled) : roundHalfUp(scaled);
}

module.exports = { roundHalfUp, roundHalfEven, toMinorUnits };
`;

export const solveHonourRoundingMode: Patch = (files) => {
  files.set('src/util/money.js', MONEY_WITH_MODES);
  edit(files, 'src/core/stages/round.js', (text) => text.replace(
    'toMinorUnits(charge.amount, rates.minorUnits)',
    'toMinorUnits(charge.amount, rates.minorUnits, rates.roundingMode)',
  ));
  edit(files, 'test/cases/rounding.cases.json', (text) => {
    const document = JSON.parse(text) as { cases: unknown[] };
    document.cases.push({ name: 'exact half rounds to even', amount: 10.125, minorUnits: 2, mode: 'halfEven', expectedMinorUnits: 1012 });
    return JSON.stringify(document, null, 2) + '\n';
  });
  edit(files, 'test/money.test.js', (text) => text.replace(
    'toMinorUnits(entry.amount, entry.minorUnits)',
    'toMinorUnits(entry.amount, entry.minorUnits, entry.mode)',
  ));
};

export const REFERENCE_SOLUTIONS: Record<string, Patch> = {
  'task.dev.multi-file-edit.add-region-surcharge': solveAddRegionSurcharge,
  'task.dev.multi-file-edit.fix-negative-rounding': solveFixNegativeRounding,
  'task.dev.multi-file-edit.honour-rounding-mode': solveHonourRoundingMode,
};

// MARK: - Correct answers to the repository-understanding questions
//
// The fixture's own ground truth, written out once so every test grades against the same answers.

export const CORRECT_ANSWERS: Record<string, unknown> = {
  'task.dev.repo-understanding.locate-implementation': {
    file: 'src/core/charge-pipeline.js',
    symbol: 'runChargePipeline',
  },
  'task.dev.repo-understanding.trace-flow': {
    files: [
      'src/index.js',
      'src/api/charges.js',
      'src/core/charge-pipeline.js',
      'src/core/stages/validate.js',
      'src/core/stages/tax.js',
      'src/core/stages/round.js',
      'src/util/money.js',
    ],
  },
  'task.dev.repo-understanding.impact-set': {
    mustChange: ['src/core/charge-pipeline.js', 'src/config/rates.json'],
    mustNotEditByHand: ['src/schema/generated/charge-fields.js'],
  },
  'task.dev.repo-understanding.source-of-truth': {
    sourceOfTruth: 'src/schema/charge.schema.json',
    derived: 'src/schema/generated/charge-fields.js',
    generator: 'tools/generate-charge-fields.js',
  },
  'task.dev.repo-understanding.relevant-tests': {
    caseFile: 'test/cases/rounding.cases.json',
    testModule: 'test/money.test.js',
    otherTestsAffected: [],
  },
  'task.dev.repo-understanding.explain-bug': {
    file: 'src/util/money.js',
    symbol: 'roundHalfUp',
    cause: 'roundHalfUp delegates to Math.round, which rounds a half away from zero for positive amounts but toward zero for negative ones, so a negative half lands one minor unit high.',
    evidence: ['src/util/money.js', 'src/core/stages/round.js', 'test/cases/rounding.cases.json'],
  },
  'task.dev.repo-understanding.absent-feature': {
    present: false,
    files: [],
  },
};
