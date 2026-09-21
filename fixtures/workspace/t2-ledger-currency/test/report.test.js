'use strict';

// A plain Node script so the fixture needs no install, no package manager and no network.
// Exits 0 when everything holds, 1 otherwise, with one line per check on stdout.

const assert = require('node:assert');
const { createEntry } = require('../src/entry.js');
const { createJournal, addEntry } = require('../src/journal.js');
const { renderEntry, renderJournal } = require('../src/report.js');

const checks = [
  ['an entry line is written the way a person reads money', () => {
    assert.strictEqual(renderEntry(createEntry({ id: 'a', description: 'Coffee', amountCents: 425, currency: 'USD' })),
      'Coffee $4.25');
    assert.strictEqual(renderEntry(createEntry({ id: 'b', description: 'Refund', amountCents: -500, currency: 'USD' })),
      'Refund -$5.00');
  }],
  ['an entry in another currency uses that currency', () => {
    assert.strictEqual(renderEntry(createEntry({ id: 'a', description: 'Book', amountCents: 1250, currency: 'EUR' })),
      'Book €12.50');
    assert.strictEqual(renderEntry(createEntry({ id: 'b', description: 'Tea', amountCents: 300, currency: 'GBP' })),
      'Tea £3.00');
  }],
  ['the report ends with the total, written the same way', () => {
    const journal = createJournal('march');
    addEntry(journal, createEntry({ id: 'a', description: 'Book', amountCents: 1250, currency: 'EUR' }));
    addEntry(journal, createEntry({ id: 'b', description: 'Refund', amountCents: -250, currency: 'EUR' }));
    assert.strictEqual(renderJournal(journal), 'Book €12.50\nRefund -€2.50\ntotal €10.00');
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
