'use strict';

// A plain Node script so the fixture needs no install, no package manager and no network.
// Exits 0 when everything holds, 1 otherwise, with one line per check on stdout.

const assert = require('node:assert');
const { createEntry, relabelEntry } = require('../src/entry.js');
const { defaultCurrency } = require('../src/config.js');

const checks = [
  ['an entry with no currency named gets the package default', () => {
    assert.strictEqual(createEntry({ id: 'a', description: 'Coffee', amountCents: 425 }).currency, defaultCurrency());
  }],
  ['an entry keeps the currency it was given', () => {
    assert.strictEqual(createEntry({ id: 'a', description: 'Book', amountCents: 1250, currency: 'EUR' }).currency, 'EUR');
    assert.strictEqual(createEntry({ id: 'b', description: 'Tea', amountCents: 300, currency: 'GBP' }).currency, 'GBP');
  }],
  ['a currency this package does not know is refused', () => {
    assert.throws(() => createEntry({ id: 'a', description: 'Coffee', amountCents: 425, currency: 'JPY' }));
    assert.throws(() => createEntry({ id: 'a', description: 'Coffee', amountCents: 425, currency: 'usd' }));
  }],
  ['relabelling an entry keeps its currency', () => {
    const entry = relabelEntry(createEntry({ id: 'a', description: 'Book', amountCents: 1250, currency: 'EUR' }), 'Novel');
    assert.strictEqual(entry.description, 'Novel');
    assert.strictEqual(entry.currency, 'EUR');
  }],
  ['an entry still needs an id and a whole number of cents', () => {
    assert.throws(() => createEntry({ description: 'no id', amountCents: 1 }));
    assert.throws(() => createEntry({ id: 'a', description: 'fractional', amountCents: 4.25 }));
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
