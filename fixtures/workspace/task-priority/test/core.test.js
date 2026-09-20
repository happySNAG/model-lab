'use strict';

// A plain Node script so the fixture needs no install, no package manager and no network.
// Exits 0 when everything holds, 1 otherwise, with one line per check on stdout.

const assert = require('node:assert');
const { PRIORITIES, DEFAULT_PRIORITY, createTask, completeTask } = require('../src/task.js');

const checks = [
  ['the priority list is low, normal, high', () => {
    assert.deepStrictEqual(PRIORITIES, ['low', 'normal', 'high']);
    assert.strictEqual(DEFAULT_PRIORITY, 'normal');
  }],
  ['a task with no priority named gets the default', () => {
    assert.strictEqual(createTask({ id: 'a', title: 'Write it down' }).priority, 'normal');
  }],
  ['a task keeps the priority it was given', () => {
    assert.strictEqual(createTask({ id: 'a', title: 'Ship it', priority: 'high' }).priority, 'high');
    assert.strictEqual(createTask({ id: 'b', title: 'Some day', priority: 'low' }).priority, 'low');
  }],
  ['a priority outside the list is refused', () => {
    assert.throws(() => createTask({ id: 'a', title: 'Ship it', priority: 'urgent' }));
  }],
  ['completing a task keeps its priority', () => {
    const done = completeTask(createTask({ id: 'a', title: 'Ship it', priority: 'high' }));
    assert.strictEqual(done.done, true);
    assert.strictEqual(done.priority, 'high');
  }],
  ['a task still needs an id', () => {
    assert.throws(() => createTask({ title: 'no id' }));
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
