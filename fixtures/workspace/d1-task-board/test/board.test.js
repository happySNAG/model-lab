'use strict';

// A plain Node script so the fixture needs no install, no package manager and no network.
// Exits 0 when everything holds, 1 otherwise, with one line per check on stdout.

const assert = require('node:assert');
const board = require('../src/board.js');
const { UnknownMemberError, TaskClosedError } = require('../src/errors.js');

const ids = (tasks) => tasks.map((task) => task.id);

function sample() {
  const b = board.createBoard({ members: ['ada', 'lin', 'sam'] });
  board.addTask(b, { id: 't-1', title: 'Write the importer', owner: 'ada', labels: ['backend'] });
  board.addTask(b, { id: 't-2', title: 'Fix the login page', owner: 'ada', labels: ['ui', 'bug'] });
  board.addTask(b, { id: 't-3', title: 'Plan the release', owner: 'lin', labels: [] });
  return b;
}

const checks = [
  ['a task is added open, with its labels in order', () => {
    const task = board.getTask(sample(), 't-2');
    assert.deepStrictEqual(task, { id: 't-2', title: 'Fix the login page', owner: 'ada', labels: ['bug', 'ui'], state: 'open' });
  }],
  ['a view finds a person\'s tasks and a label\'s tasks', () => {
    const b = sample();
    assert.deepStrictEqual(ids(board.tasksFor(b, 'ada')), ['t-1', 't-2']);
    assert.deepStrictEqual(ids(board.tasksLabelled(b, 'ui')), ['t-2']);
    assert.strictEqual(board.openCount(b, 'ada'), 2);
  }],
  ['closing a task stops it counting as open, and it stays on its owner\'s list', () => {
    const b = sample();
    board.closeTask(b, 't-1');
    assert.strictEqual(board.openCount(b, 'ada'), 1);
    assert.deepStrictEqual(ids(board.tasksFor(b, 'ada')), ['t-1', 't-2']);
    assert.throws(() => board.closeTask(b, 't-1'), TaskClosedError);
  }],
  ['renaming is recorded', () => {
    const b = sample();
    board.renameTask(b, 't-3', 'Plan the 2.0 release');
    assert.deepStrictEqual(board.historyOf(b).at(-1), { kind: 'renamed', id: 't-3', from: 'Plan the release', to: 'Plan the 2.0 release' });
  }],
  ['a task cannot be given to someone outside the team', () => {
    assert.throws(() => board.addTask(sample(), { id: 't-9', title: 'x', owner: 'eve' }), UnknownMemberError);
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
