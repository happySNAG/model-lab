'use strict';

// A plain Node script so the fixture needs no install, no package manager and no network.
// Exits 0 when everything holds, 1 otherwise, with one line per check on stdout.

const assert = require('node:assert');
const board = require('../src/board.js');
const { UnknownMemberError, UnknownTaskError, TaskClosedError } = require('../src/errors.js');

const ids = (tasks) => tasks.map((task) => task.id);

function sample() {
  const b = board.createBoard({ members: ['ada', 'lin', 'sam'] });
  board.addTask(b, { id: 't-1', title: 'Write the importer', owner: 'ada', labels: ['backend'] });
  board.addTask(b, { id: 't-2', title: 'Fix the login page', owner: 'ada', labels: ['ui', 'bug'] });
  return b;
}

const checks = [
  ['a reassigned task has its new owner', () => {
    const b = sample();
    const task = board.reassignTask(b, 't-1', 'lin');
    assert.strictEqual(task.owner, 'lin');
    assert.strictEqual(board.getTask(b, 't-1').owner, 'lin');
  }],
  ['the new owner\'s list shows it', () => {
    const b = sample();
    board.reassignTask(b, 't-1', 'lin');
    assert.deepStrictEqual(ids(board.tasksFor(b, 'lin')), ['t-1']);
    assert.strictEqual(board.openCount(b, 'lin'), 1);
  }],
  ['a reassignment is recorded', () => {
    const b = sample();
    board.reassignTask(b, 't-2', 'sam');
    assert.deepStrictEqual(board.historyOf(b).at(-1), { kind: 'reassigned', id: 't-2', from: 'ada', to: 'sam' });
  }],
  ['a task cannot be given to someone outside the team', () => {
    assert.throws(() => board.reassignTask(sample(), 't-1', 'eve'), UnknownMemberError);
  }],
  ['a closed task keeps its owner', () => {
    const b = sample();
    board.closeTask(b, 't-1');
    assert.throws(() => board.reassignTask(b, 't-1', 'lin'), TaskClosedError);
  }],
  ['a task that does not exist cannot be reassigned', () => {
    assert.throws(() => board.reassignTask(sample(), 't-404', 'lin'), UnknownTaskError);
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
