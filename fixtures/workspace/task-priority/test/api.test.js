'use strict';

// A plain Node script so the fixture needs no install, no package manager and no network.
// Exits 0 when everything holds, 1 otherwise, with one line per check on stdout.

const assert = require('node:assert');
const api = require('../src/index.js');

const checks = [
  ['the public API renders the priority in parentheses before the title', () => {
    assert.strictEqual(api.describeTask(api.createTask({ id: 'a', title: 'Ship it', priority: 'high' })),
      '[ ] (high) Ship it');
  }],
  ['a completed task renders the same way', () => {
    assert.strictEqual(api.describeTask(api.completeTask(api.createTask({ id: 'a', title: 'Write it down' }))),
      '[x] (normal) Write it down');
  }],
  ['a task read back off the wire renders identically to the one written', () => {
    const task = api.createTask({ id: 'a', title: 'Some day', priority: 'low' });
    assert.strictEqual(api.describeTask(api.fromWire(api.toWire(task))), api.describeTask(task));
    assert.strictEqual(api.describeTask(task), '[ ] (low) Some day');
  }],
  ['the priority vocabulary is part of the public API', () => {
    assert.deepStrictEqual(api.PRIORITIES, ['low', 'normal', 'high']);
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
