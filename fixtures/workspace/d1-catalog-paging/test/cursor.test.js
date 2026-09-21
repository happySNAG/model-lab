'use strict';

// A plain Node script so the fixture needs no install, no package manager and no network.
// Exits 0 when everything holds, 1 otherwise, with one line per check on stdout.

const assert = require('node:assert');
const { createStore } = require('../src/store.js');
const { listPage } = require('../src/page.js');
const { InvalidCursorError } = require('../src/cursor.js');
const { inCategory } = require('../src/filters.js');
const { PRODUCTS } = require('./catalog.js');

const checks = [
  ['a cursor is opaque text', () => {
    const { next } = listPage(createStore(PRODUCTS), { limit: 2 });
    assert.strictEqual(typeof next, 'string');
    assert.ok(!next.includes(' '));
  }],
  ['text that is not a cursor is refused', () => {
    assert.throws(() => listPage(createStore(PRODUCTS), { after: 'not-a-cursor' }), InvalidCursorError);
    assert.throws(() => listPage(createStore(PRODUCTS), { after: Buffer.from('[1,2]').toString('base64url') }), InvalidCursorError);
  }],
  ['a filtered listing pages through the filtered products', () => {
    const store = createStore(PRODUCTS);
    const first = listPage(store, { limit: 2, filter: inCategory('kitchen') });
    const second = listPage(store, { limit: 2, filter: inCategory('kitchen'), after: first.next });
    assert.deepStrictEqual([...first.items, ...second.items].map((product) => product.id), ['p-02', 'p-04', 'p-01', 'p-05']);
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
