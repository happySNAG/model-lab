'use strict';

const { PRIORITIES, DEFAULT_PRIORITY, createTask, completeTask } = require('./task.js');
const { toWire, fromWire } = require('./wire.js');

/**
 * One task, as a person reads it.
 *
 * The public rendering. A consumer of this package never reaches past it into `src/task.js`.
 */
function describeTask(task) {
  return `${task.done ? '[x]' : '[ ]'} ${task.title}`;
}

module.exports = { PRIORITIES, DEFAULT_PRIORITY, createTask, completeTask, describeTask, toWire, fromWire };
