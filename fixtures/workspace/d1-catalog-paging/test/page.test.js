'use strict';

// A plain Node script so the fixture needs no install, no package manager and no network.
// Exits 0 when everything holds, 1 otherwise, with one line per check on stdout.

const assert = require('node:assert');
const { createStore, insert, remove } = require('../src/store.js');
const { listPage } = require('../src/page.js');
const { walkAll } = require('../src/walk.js');
const { PRODUCTS, LISTING_ORDER } = require('./catalog.js');

const ids = (products) => products.map((product) => product.id);

const checks = [
  ['the first page is the top of the listing', () => {
    const page = listPage(createStore(PRODUCTS), { limit: 4 });
    assert.deepStrictEqual(ids(page.items), ['p-07', 'p-02', 'p-04', 'p-11']);
    assert.strictEqual(typeof page.next, 'string');
  }],
  ['walking the listing returns every product once, in order', () => {
    assert.deepStrictEqual(ids(walkAll(createStore(PRODUCTS), { limit: 5 })), LISTING_ORDER);
    assert.deepStrictEqual(ids(walkAll(createStore(PRODUCTS), { limit: 3 })), LISTING_ORDER);
  }],
  ['the last page says there is nothing after it', () => {
    assert.strictEqual(listPage(createStore(PRODUCTS), { limit: 50 }).next, null);
  }],
  ['withdrawing a product already listed does not skip the next one', () => {
    const store = createStore(PRODUCTS);
    const walked = walkAll(store, { limit: 5, between: (page) => { if (page === 1) remove(store, 'p-02'); } });
    assert.deepStrictEqual(ids(walked), LISTING_ORDER);
  }],
  ['a product added above the place a walk has reached is not listed, and one below it is', () => {
    const store = createStore(PRODUCTS);
    const walked = walkAll(store, {
      limit: 5,
      between: (page) => {
        if (page !== 1) return;
        insert(store, { id: 'p-20', name: 'Hatchet', category: 'outdoor', rank: 95, stock: 1 });
        insert(store, { id: 'p-21', name: 'Oven mitt', category: 'kitchen', rank: 20, stock: 6 });
      },
    });
    assert.deepStrictEqual(ids(walked), [...LISTING_ORDER.slice(0, 10), 'p-21', 'p-06', 'p-08']);
  }],
  ['a page holds at least one product', () => {
    assert.throws(() => listPage(createStore(PRODUCTS), { limit: 0 }), RangeError);
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
