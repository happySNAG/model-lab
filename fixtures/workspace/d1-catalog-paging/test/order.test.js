'use strict';

// A plain Node script so the fixture needs no install, no package manager and no network.
// Exits 0 when everything holds, 1 otherwise, with one line per check on stdout.

const assert = require('node:assert');
const { compareProducts } = require('../src/order.js');
const { PRODUCTS, LISTING_ORDER } = require('./catalog.js');

const checks = [
  ['higher rank is listed first', () => {
    assert.ok(compareProducts({ id: 'a', rank: 90 }, { id: 'b', rank: 10 }) < 0);
    assert.ok(compareProducts({ id: 'a', rank: 10 }, { id: 'b', rank: 90 }) > 0);
  }],
  ['equal rank is listed by id', () => {
    assert.ok(compareProducts({ id: 'p-02', rank: 70 }, { id: 'p-11', rank: 70 }) < 0);
    assert.ok(compareProducts({ id: 'p-11', rank: 70 }, { id: 'p-02', rank: 70 }) > 0);
  }],
  ['the whole catalogue sorts into listing order', () => {
    assert.deepStrictEqual([...PRODUCTS].sort(compareProducts).map((product) => product.id), LISTING_ORDER);
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
