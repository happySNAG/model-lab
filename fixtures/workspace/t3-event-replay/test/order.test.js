'use strict';

// A plain Node script so the fixture needs no install, no package manager and no network.
// Exits 0 when everything holds, 1 otherwise, with one line per check on stdout.

const assert = require('node:assert');
const { createEvent } = require('../src/event.js');
const { inOrder, isContiguous } = require('../src/order.js');
const { logOf, shuffledForTransport } = require('../src/log.js');

const LOG = logOf([
  { kind: 'deposit', amountCents: 10000 }, { kind: 'hold', reference: 'h1' },
  { kind: 'deposit', amountCents: 2500 }, { kind: 'withdraw', amountCents: 500 },
  { kind: 'hold', reference: 'h2' }, { kind: 'release', reference: 'h1' },
  { kind: 'deposit', amountCents: 100 }, { kind: 'withdraw', amountCents: 2000 },
  { kind: 'hold', reference: 'h3' }, { kind: 'release', reference: 'h2' },
  { kind: 'deposit', amountCents: 50 }, { kind: 'withdraw', amountCents: 25 },
]);

const sequences = (events) => events.map((event) => event.sequence);

const checks = [
  ['a log that arrives backwards comes back in order', () => {
    assert.deepStrictEqual(sequences(inOrder(shuffledForTransport(LOG))),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  }],
  ['a log that arrives out of two files comes back in order', () => {
    const odds = LOG.filter((event) => event.sequence % 2 === 1);
    const evens = LOG.filter((event) => event.sequence % 2 === 0);
    assert.deepStrictEqual(sequences(inOrder([...odds, ...evens])),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  }],
  ['a log of ten or more does not sort by the shape of the number', () => {
    const log = logOf(Array.from({ length: 12 }, () => ({ kind: 'deposit', amountCents: 1 })));
    assert.deepStrictEqual(sequences(inOrder(shuffledForTransport(log))),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  }],
  ['a log that is already in order stays in it', () => {
    assert.deepStrictEqual(sequences(inOrder(LOG)), sequences(LOG));
  }],
  ['a log with every sequence number once is contiguous', () => {
    assert.strictEqual(isContiguous(LOG), true);
    assert.strictEqual(isContiguous([createEvent({ kind: 'deposit', amountCents: 1, sequence: 2 })]), false);
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
