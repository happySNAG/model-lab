'use strict';

// A plain Node script so the fixture needs no install, no package manager and no network.
// Exits 0 when everything holds, 1 otherwise, with one line per check on stdout.

const assert = require('node:assert');
const { createState, cloneState, statesEqual } = require('../src/state.js');
const { replay } = require('../src/replay.js');
const { logOf, shuffledForTransport } = require('../src/log.js');

const LOG = logOf([
  { kind: 'deposit', amountCents: 10000 }, { kind: 'hold', reference: 'h1' },
  { kind: 'deposit', amountCents: 2500 }, { kind: 'withdraw', amountCents: 500 },
  { kind: 'hold', reference: 'h2' }, { kind: 'release', reference: 'h1' },
  { kind: 'deposit', amountCents: 100 }, { kind: 'withdraw', amountCents: 2000 },
  { kind: 'hold', reference: 'h3' }, { kind: 'release', reference: 'h2' },
  { kind: 'deposit', amountCents: 50 }, { kind: 'withdraw', amountCents: 25 },
]);

const checks = [
  ['replaying a log in order gives the state it describes', () => {
    const state = replay(LOG);
    assert.strictEqual(state.balanceCents, 10125);
    assert.deepStrictEqual(state.holds, ['h3']);
    assert.strictEqual(state.lastSequence, 12);
  }],
  ['replaying the same log out of order gives the same state', () => {
    const state = replay(shuffledForTransport(LOG));
    assert.strictEqual(state.balanceCents, 10125);
    assert.deepStrictEqual(state.holds, ['h3'], 'holds and releases only make sense in order');
    assert.strictEqual(state.lastSequence, 12);
  }],
  ['replaying a log does not change the state it started from', () => {
    const opening = createState();
    opening.balanceCents = 5000;
    const kept = cloneState(opening);
    replay(LOG, opening);
    assert.strictEqual(statesEqual(opening, kept), true, 'replay is pure — see docs/REPLAY.md');
  }],
  ['replaying the same log from the same state twice gives the same answer', () => {
    const opening = createState();
    opening.balanceCents = 5000;
    const once = replay(LOG, opening);
    const twice = replay(LOG, opening);
    assert.strictEqual(statesEqual(once, twice), true);
    assert.strictEqual(once.balanceCents, 15125);
  }],
  ['replaying nothing gives the state it started from', () => {
    const state = replay([]);
    assert.strictEqual(statesEqual(state, createState()), true);
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
