'use strict';

// A plain Node script so the fixture needs no install, no package manager and no network.
// Exits 0 when everything holds, 1 otherwise, with one line per check on stdout.

const assert = require('node:assert');
const { logOf, appended, shuffledForTransport } = require('../src/log.js');
const { isContiguous } = require('../src/order.js');
const { problemsWithLog } = require('../src/validate.js');

const LOG = logOf([
  { kind: 'deposit', amountCents: 100 },
  { kind: 'hold', reference: 'h1' },
  { kind: 'withdraw', amountCents: 40 },
]);

const checks = [
  ['a log numbers its events in the order they were given', () => {
    assert.deepStrictEqual(LOG.map((event) => event.sequence), [1, 2, 3]);
    assert.strictEqual(LOG[1].reference, 'h1');
  }],
  ['appending gives a new log one longer', () => {
    const longer = appended(LOG, { kind: 'deposit', amountCents: 1 });
    assert.strictEqual(longer.length, 4);
    assert.strictEqual(longer[3].sequence, 4);
    assert.strictEqual(LOG.length, 3, 'the log it was given is unchanged');
  }],
  ['a log that arrived out of a queue is still the same log', () => {
    const arriving = shuffledForTransport(LOG);
    assert.deepStrictEqual(arriving.map((event) => event.sequence), [3, 2, 1]);
    assert.strictEqual(isContiguous(arriving), true);
    assert.deepStrictEqual(problemsWithLog(arriving), []);
  }],
  ['an event this package would not accept is refused when it is built', () => {
    assert.throws(() => logOf([{ kind: 'invent' }]));
    assert.throws(() => appended(LOG, { kind: 'invent' }));
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
