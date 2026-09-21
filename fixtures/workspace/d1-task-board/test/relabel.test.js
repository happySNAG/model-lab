'use strict';

// A plain Node script so the fixture needs no install, no package manager and no network.
// Exits 0 when everything holds, 1 otherwise, with one line per check on stdout.

const assert = require('node:assert');
const board = require('../src/board.js');
const { TaskClosedError } = require('../src/errors.js');

const ids = (tasks) => tasks.map((task) => task.id);

function sample() {
  const b = board.createBoard({ members: ['ada', 'lin'] });
  board.addTask(b, { id: 't-1', title: 'Write the importer', owner: 'ada', labels: ['backend'] });
  board.addTask(b, { id: 't-2', title: 'Fix the login page', owner: 'lin', labels: ['ui', 'bug'] });
  return b;
}

const checks = [
  ['a task\'s labels are replaced, in order and without repeats', () => {
    const b = sample();
    const task = board.relabelTask(b, 't-2', ['ui', 'accessibility', 'ui']);
    assert.deepStrictEqual(task.labels, ['accessibility', 'ui']);
  }],
  ['a new label\'s list shows the task', () => {
    const b = sample();
    board.relabelTask(b, 't-1', ['backend', 'urgent']);
    assert.deepStrictEqual(ids(board.tasksLabelled(b, 'urgent')), ['t-1']);
  }],
  ['a closed task keeps its labels', () => {
    const b = sample();
    board.closeTask(b, 't-2');
    assert.throws(() => board.relabelTask(b, 't-2', ['ui']), TaskClosedError);
  }],
  ['a relabelling is recorded', () => {
    const b = sample();
    board.relabelTask(b, 't-2', ['ui']);
    assert.deepStrictEqual(board.historyOf(b).at(-1), { kind: 'relabelled', id: 't-2', from: ['bug', 'ui'], to: ['ui'] });
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
