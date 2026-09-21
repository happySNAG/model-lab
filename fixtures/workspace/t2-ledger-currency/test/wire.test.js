'use strict';

// A plain Node script so the fixture needs no install, no package manager and no network.
// Exits 0 when everything holds, 1 otherwise, with one line per check on stdout.

const assert = require('node:assert');
const { createEntry } = require('../src/entry.js');
const { createJournal, addEntry } = require('../src/journal.js');
const { toWire, fromWire, journalToWire, journalFromWire } = require('../src/wire.js');

const checks = [
  ['a record carries the currency under the key the format names', () => {
    const record = toWire(createEntry({ id: 'a', description: 'Book', amountCents: 1250, currency: 'EUR' }));
    assert.deepStrictEqual(record, { i: 'a', d: 'Book', a: 1250, c: 'EUR' });
  }],
  ['a record reads back as the entry it was written from', () => {
    const entry = createEntry({ id: 'a', description: 'Tea', amountCents: 300, currency: 'GBP' });
    assert.deepStrictEqual(fromWire(toWire(entry)), entry);
  }],
  ['a whole journal round trips', () => {
    const journal = createJournal('march');
    addEntry(journal, createEntry({ id: 'a', description: 'Coffee', amountCents: 425, currency: 'USD' }));
    addEntry(journal, createEntry({ id: 'b', description: 'Book', amountCents: 1250, currency: 'USD' }));
    const read = journalFromWire(journalToWire(journal));
    assert.strictEqual(read.label, 'march');
    assert.deepStrictEqual(read.entries.map((entry) => entry.currency), ['USD', 'USD']);
    assert.deepStrictEqual(read.entries, journal.entries);
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
