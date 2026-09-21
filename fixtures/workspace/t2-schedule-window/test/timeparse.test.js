'use strict';

// A plain Node script so the fixture needs no install, no package manager and no network.
// Exits 0 when everything holds, 1 otherwise, with one line per check on stdout.

const assert = require('node:assert');
const { parseClock, formatClock } = require('../src/timeparse.js');

const checks = [
  ['clock text reads as minutes since midnight', () => {
    assert.strictEqual(parseClock('00:00'), 0);
    assert.strictEqual(parseClock('09:00'), 540);
    assert.strictEqual(parseClock('09:59'), 599);
    assert.strictEqual(parseClock('23:59'), 1439);
  }],
  ['minutes since midnight write back as clock text', () => {
    assert.strictEqual(formatClock(0), '00:00');
    assert.strictEqual(formatClock(540), '09:00');
    assert.strictEqual(formatClock(1439), '23:59');
  }],
  ['anything that is not a clock time is refused', () => {
    assert.throws(() => parseClock('9:00'));
    assert.throws(() => parseClock('24:01'));
    assert.throws(() => parseClock('09:60'));
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
