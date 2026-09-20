'use strict';

// A plain Node script so the fixture needs no install, no package manager and no network.
// Exits 0 when everything holds, 1 on the first failure, with the reason on stdout.

const assert = require('node:assert');
const { sum, mean } = require('../src/stats.js');

const checks = [
  ['sum of an empty list is zero', () => assert.strictEqual(sum([]), 0)],
  ['sum adds every element', () => assert.strictEqual(sum([1, 2, 3, 4]), 10)],
  ['mean of one element is that element', () => assert.strictEqual(mean([7]), 7)],
  ['mean divides by the count', () => assert.strictEqual(mean([2, 4, 6]), 4)],
  ['mean of an empty list throws', () => assert.throws(() => mean([]))],
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
