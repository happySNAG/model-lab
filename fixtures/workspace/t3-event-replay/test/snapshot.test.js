'use strict';

// A plain Node script so the fixture needs no install, no package manager and no network.
// Exits 0 when everything holds, 1 otherwise, with one line per check on stdout.

const assert = require('node:assert');
const { statesEqual } = require('../src/state.js');
const { replay, replayUpTo, tailAfter } = require('../src/replay.js');
const { snapshotOf, restore } = require('../src/snapshot.js');
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
  ['a snapshot says which event it is a snapshot of', () => {
    const snapshot = snapshotOf(replayUpTo(LOG, 6));
    assert.strictEqual(snapshot.atSequence, 6);
  }],
  ['replaying the tail from a snapshot agrees with replaying everything', () => {
    const snapshot = snapshotOf(replayUpTo(LOG, 6));
    const fromSnapshot = replay(tailAfter(LOG, 6), restore(snapshot));
    assert.strictEqual(statesEqual(fromSnapshot, replay(LOG)), true,
      'that equivalence is the entire reason snapshots exist — see docs/REPLAY.md');
  }],
  ['it agrees when the log arrived out of order too', () => {
    const arriving = shuffledForTransport(LOG);
    const snapshot = snapshotOf(replayUpTo(arriving, 6));
    const fromSnapshot = replay(tailAfter(arriving, 6), restore(snapshot));
    assert.strictEqual(statesEqual(fromSnapshot, replay(arriving)), true);
  }],
  ['replaying from a snapshot does not use it up', () => {
    const head = replayUpTo(LOG, 6);
    const kept = snapshotOf(head);
    replay(tailAfter(LOG, 6), head);
    assert.strictEqual(statesEqual(head, kept.state), true,
      'the state a snapshot was taken of is still that state afterwards');
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
