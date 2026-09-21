'use strict';

// A plain Node script so the fixture needs no install, no package manager and no network.
// Exits 0 when everything holds, 1 otherwise, with one line per check on stdout.

const assert = require('node:assert');
const { createStore } = require('../src/store.js');
const { exportCSV } = require('../src/export.js');
const { PRODUCTS, LISTING_ORDER } = require('./catalog.js');

const checks = [
  ['the export has a header and one row per product, in listing order', () => {
    const lines = exportCSV(createStore(PRODUCTS)).split('\n');
    assert.strictEqual(lines[0], 'id,name,category,rank,stock');
    assert.deepStrictEqual(lines.slice(1).map((line) => line.split(',')[0]), LISTING_ORDER);
  }],
  ['a field with a comma in it is quoted', () => {
    const csv = exportCSV(createStore([{ id: 'p-99', name: 'Pots, pans', category: 'kitchen', rank: 1, stock: 1 }]));
    assert.strictEqual(csv.split('\n')[1], 'p-99,"Pots, pans",kitchen,1,1');
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
