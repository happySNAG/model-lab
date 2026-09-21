'use strict';

// A plain Node script so the fixture needs no install, no package manager and no network.
// Exits 0 when everything holds, 1 otherwise, with one line per check on stdout.
//
// These checks hand `overlap.js` its windows DIRECTLY, as minute marks, rather than building them
// through `createInterval`. What they establish is what this module does with the numbers it is
// given — which is a different question from what the numbers are.

const assert = require('node:assert');
const { intervalsOverlap, overlapMinutes } = require('../src/overlap.js');

const window = (startMinute, endMinute) => ({ startMinute, endMinute });

const checks = [
  ['windows that merely touch do not overlap', () => {
    assert.strictEqual(intervalsOverlap(window(540, 600), window(600, 660)), false);
    assert.strictEqual(intervalsOverlap(window(600, 660), window(540, 600)), false);
    assert.strictEqual(overlapMinutes(window(540, 600), window(600, 660)), 0);
  }],
  ['windows that share one minute overlap', () => {
    assert.strictEqual(intervalsOverlap(window(540, 600), window(599, 660)), true);
    assert.strictEqual(overlapMinutes(window(540, 600), window(599, 660)), 1);
  }],
  ['a window inside another overlaps it', () => {
    assert.strictEqual(intervalsOverlap(window(540, 660), window(570, 600)), true);
    assert.strictEqual(overlapMinutes(window(540, 660), window(570, 600)), 30);
  }],
  ['windows nowhere near each other do not overlap', () => {
    assert.strictEqual(intervalsOverlap(window(540, 600), window(900, 960)), false);
    assert.strictEqual(overlapMinutes(window(540, 600), window(900, 960)), 0);
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
