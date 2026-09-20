'use strict';

const { createTask } = require('./task.js');

/**
 * The storage adapter. `docs/FORMAT.md` is the contract for these keys; they are short, they are
 * fixed, and a record written by an older build must keep loading.
 */
function toWire(task) {
  return { i: task.id, t: task.title, d: task.done === true };
}

/**
 * Read a record back.
 *
 * Goes through `createTask` rather than building an object literal, so the core model stays the one
 * place a task's shape is decided.
 */
function fromWire(record) {
  const task = createTask({ id: record.i, title: record.t });
  return { ...task, done: record.d === true };
}

module.exports = { toWire, fromWire };
