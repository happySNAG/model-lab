'use strict';

// A plain Node script so the fixture needs no install, no package manager and no network.
// Exits 0 when everything holds, 1 otherwise, with one line per check on stdout.

const assert = require('node:assert');
const { createEntry } = require('../src/entry.js');
const { createJournal, addEntry, totalOf, entriesOf } = require('../src/journal.js');

function journalOf(...entries) {
  const journal = createJournal('test');
  for (const entry of entries) addEntry(journal, entry);
  return journal;
}

const checks = [
  ['a total is an amount and a currency, not a bare number', () => {
    const journal = journalOf(
      createEntry({ id: 'a', description: 'Coffee', amountCents: 425, currency: 'USD' }),
      createEntry({ id: 'b', description: 'Book', amountCents: 1250, currency: 'USD' }),
    );
    assert.deepStrictEqual(totalOf(journal), { amountCents: 1675, currency: 'USD' });
  }],
  ['a total in another currency stays in that currency', () => {
    const journal = journalOf(
      createEntry({ id: 'a', description: 'Tea', amountCents: 300, currency: 'GBP' }),
      createEntry({ id: 'b', description: 'Refund', amountCents: -100, currency: 'GBP' }),
    );
    assert.deepStrictEqual(totalOf(journal), { amountCents: 200, currency: 'GBP' });
  }],
  ['entries come back in the order they were added', () => {
    const journal = journalOf(
      createEntry({ id: 'a', description: 'First', amountCents: 1 }),
      createEntry({ id: 'b', description: 'Second', amountCents: 2 }),
    );
    assert.deepStrictEqual(entriesOf(journal).map((entry) => entry.id), ['a', 'b']);
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
