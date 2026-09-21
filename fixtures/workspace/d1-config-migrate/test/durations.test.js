'use strict';

// A plain Node script so the fixture needs no install, no package manager and no network.
// Exits 0 when everything holds, 1 otherwise, with one line per check on stdout.

const assert = require('node:assert');
const { parseDuration } = require('../src/durations.js');

const checks = [
  ['a whole number is already seconds', () => {
    assert.strictEqual(parseDuration(45), 45);
    assert.strictEqual(parseDuration(0), 0);
  }],
  ['seconds, minutes and hours are all durations', () => {
    assert.strictEqual(parseDuration('90s'), 90);
    assert.strictEqual(parseDuration('2m'), 120);
    assert.strictEqual(parseDuration('1h'), 3600);
  }],
  ['something that is not a duration is not read as one', () => {
    assert.strictEqual(parseDuration('fast'), undefined);
    assert.strictEqual(parseDuration(-5), undefined);
    assert.strictEqual(parseDuration(2.5), undefined);
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
