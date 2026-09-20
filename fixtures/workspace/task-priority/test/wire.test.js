'use strict';

// A plain Node script so the fixture needs no install, no package manager and no network.
// Exits 0 when everything holds, 1 otherwise, with one line per check on stdout.

const assert = require('node:assert');
const { createTask, completeTask } = require('../src/task.js');
const { toWire, fromWire } = require('../src/wire.js');

const checks = [
  ['a record carries the priority under the documented key', () => {
    const record = toWire(createTask({ id: 'a', title: 'Ship it', priority: 'high' }));
    assert.deepStrictEqual(record, { i: 'a', t: 'Ship it', d: false, p: 'high' });
  }],
  ['a default-priority task is written out too, not left blank', () => {
    assert.strictEqual(toWire(createTask({ id: 'a', title: 'Write it down' })).p, 'normal');
  }],
  ['a round trip preserves every field', () => {
    const task = completeTask(createTask({ id: 'a', title: 'Ship it', priority: 'low' }));
    assert.deepStrictEqual(fromWire(toWire(task)), task);
  }],
  ['a record is read back with the priority it carries', () => {
    assert.strictEqual(fromWire({ i: 'a', t: 'Ship it', d: false, p: 'high' }).priority, 'high');
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
