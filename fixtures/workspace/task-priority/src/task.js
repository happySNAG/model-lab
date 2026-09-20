'use strict';

/** Every priority a task may carry, weakest first. The only values `createTask` accepts. */
const PRIORITIES = ['low', 'normal', 'high'];

/** The priority a task gets when the caller names none. */
const DEFAULT_PRIORITY = 'normal';

/**
 * Build a task.
 *
 * The ONLY constructor. Nothing else in this package builds a task object literal, so a field added
 * here is a field every task has — including the ones `fromWire` reads back off disk.
 */
function createTask(fields) {
  if (typeof fields.id !== 'string' || fields.id.length === 0) {
    throw new TypeError('a task needs a non-empty id');
  }
  return {
    id: fields.id,
    title: typeof fields.title === 'string' ? fields.title : '',
    done: false,
  };
}

/** A completed copy. Tasks are values here; nothing is mutated in place. */
function completeTask(task) {
  return { ...task, done: true };
}

module.exports = { PRIORITIES, DEFAULT_PRIORITY, createTask, completeTask };
