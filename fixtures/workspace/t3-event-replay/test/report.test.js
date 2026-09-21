'use strict';

// A plain Node script so the fixture needs no install, no package manager and no network.
// Exits 0 when everything holds, 1 otherwise, with one line per check on stdout.

const assert = require('node:assert');
const { formatCents, renderState } = require('../src/report.js');
const { countByKind, describeLog } = require('../src/summary.js');
const { problemsWith, problemsWithLog } = require('../src/validate.js');
const { logOf } = require('../src/log.js');

const LOG = logOf([
  { kind: 'deposit', amountCents: 10000 }, { kind: 'hold', reference: 'h1' },
  { kind: 'release', reference: 'h1' }, { kind: 'withdraw', amountCents: 500 },
]);

const checks = [
  ['money is written the way a person reads it', () => {
    assert.strictEqual(formatCents(10125), '$101.25');
    assert.strictEqual(formatCents(-75), '-$0.75');
  }],
  ['a state is written as a sentence', () => {
    assert.strictEqual(renderState({ balanceCents: 10125, holds: ['h3'], lastSequence: 12 }),
      'balance $101.25 · holds h3 · through event 12');
    assert.strictEqual(renderState({ balanceCents: 0, holds: [], lastSequence: 0 }),
      'balance $0.00 · no holds · through event 0');
  }],
  ['a log is counted by kind', () => {
    assert.deepStrictEqual(countByKind(LOG), { deposit: 1, withdraw: 1, hold: 1, release: 1 });
    assert.strictEqual(describeLog(LOG), '1 deposit, 1 withdraw, 1 hold, 1 release');
    assert.strictEqual(describeLog([]), 'nothing happened');
  }],
  ['a malformed event says what is wrong with it', () => {
    assert.deepStrictEqual(problemsWith({ kind: 'deposit', sequence: 1, amountCents: 0, reference: '' }),
      ['a deposit needs a positive amount']);
    assert.deepStrictEqual(problemsWithLog(LOG), []);
  }],
];

let failed = 0;
for (const [name, check] of checks) {
  try {
    check();
    console.log(`ok - ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`not ok - ${name}: ${error.message}`);
  }
}
console.log(`${checks.length - failed}/${checks.length} passed`);
process.exit(failed === 0 ? 0 : 1);
