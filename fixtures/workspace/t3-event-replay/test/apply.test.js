'use strict';

// A plain Node script so the fixture needs no install, no package manager and no network.
// Exits 0 when everything holds, 1 otherwise, with one line per check on stdout.

const assert = require('node:assert');
const { createEvent } = require('../src/event.js');
const { createState, cloneState, statesEqual } = require('../src/state.js');
const { applyEvent } = require('../src/apply.js');

const event = (fields) => createEvent(fields);

const checks = [
  ['applying an event answers with the state that results', () => {
    const after = applyEvent(createState(), event({ kind: 'deposit', amountCents: 500, sequence: 1 }));
    assert.strictEqual(after.balanceCents, 500);
    assert.strictEqual(after.lastSequence, 1);
  }],
  ['the state that was handed in is not the state that comes back', () => {
    const before = createState();
    const after = applyEvent(before, event({ kind: 'deposit', amountCents: 500, sequence: 1 }));
    assert.notStrictEqual(after, before, 'applying an event answers with a new state');
    assert.strictEqual(before.balanceCents, 0, 'and leaves the one it was given alone');
    assert.strictEqual(before.lastSequence, 0);
  }],
  ['a hold does not reach into the state it was given', () => {
    const before = createState();
    const holds = before.holds;
    const after = applyEvent(before, event({ kind: 'hold', reference: 'h1', sequence: 1 }));
    assert.deepStrictEqual(after.holds, ['h1']);
    assert.deepStrictEqual(before.holds, [], 'the original still has no holds');
    assert.deepStrictEqual(holds, [], 'and the array it was holding was not written to');
  }],
  ['a release does not reach into the state it was given', () => {
    const held = applyEvent(createState(), event({ kind: 'hold', reference: 'h1', sequence: 1 }));
    const kept = cloneState(held);
    const after = applyEvent(held, event({ kind: 'release', reference: 'h1', sequence: 2 }));
    assert.deepStrictEqual(after.holds, []);
    assert.strictEqual(statesEqual(held, kept), true, 'the state handed in is unchanged');
  }],
  ['applying the same event to the same state twice gives the same answer', () => {
    const before = applyEvent(createState(), event({ kind: 'deposit', amountCents: 500, sequence: 1 }));
    const once = applyEvent(before, event({ kind: 'deposit', amountCents: 100, sequence: 2 }));
    const twice = applyEvent(before, event({ kind: 'deposit', amountCents: 100, sequence: 2 }));
    assert.strictEqual(statesEqual(once, twice), true);
  }],
  ['an event kind this package does not know is refused', () => {
    assert.throws(() => applyEvent(createState(), { kind: 'invent', sequence: 1 }));
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
