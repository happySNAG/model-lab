'use strict';

const {
  createIndexes, indexTask, unindexTask, markClosed, idsFor, idsLabelled, openCountFor,
} = require('./indexes.js');
const { createMembers, isMember } = require('./members.js');
const { createHistory, record } = require('./history.js');
const { UnknownTaskError, UnknownMemberError, TaskClosedError } = require('./errors.js');

/** A board for a team. docs/BOARD.md states the rules every operation here keeps. */
function createBoard({ members }) {
  return { tasks: new Map(), indexes: createIndexes(), members: createMembers(members), history: createHistory() };
}

function taskOf(board, id) {
  const task = board.tasks.get(id);
  if (task === undefined) throw new UnknownTaskError(id);
  return task;
}

/** A copy, so a caller holding a task cannot change the board behind its back. */
function getTask(board, id) {
  const task = taskOf(board, id);
  return { ...task, labels: [...task.labels] };
}

function addTask(board, { id, title, owner, labels = [] }) {
  if (board.tasks.has(id)) throw new Error(`task ${id} already exists`);
  if (!isMember(board.members, owner)) throw new UnknownMemberError(owner);
  const task = { id, title, owner, labels: [...new Set(labels)].sort(), state: 'open' };
  board.tasks.set(id, task);
  indexTask(board.indexes, task);
  record(board.history, { kind: 'added', id, owner });
  return getTask(board, id);
}

function renameTask(board, id, title) {
  const task = taskOf(board, id);
  const from = task.title;
  task.title = title;
  record(board.history, { kind: 'renamed', id, from, to: title });
  return getTask(board, id);
}

function closeTask(board, id) {
  const task = taskOf(board, id);
  if (task.state === 'closed') throw new TaskClosedError(id);
  markClosed(board.indexes, task);
  task.state = 'closed';
  record(board.history, { kind: 'closed', id });
  return getTask(board, id);
}

/**
 * Change an indexed field of an open task. Everything that can refuse is checked first, so a refused
 * change changes nothing; then the task is unindexed as it was and indexed as it is.
 */
function changeIndexed(board, id, change) {
  const task = taskOf(board, id);
  if (task.state === 'closed') throw new TaskClosedError(id);
  change.check?.(task);
  unindexTask(board.indexes, task);
  const entry = change.apply(task);
  indexTask(board.indexes, task);
  record(board.history, entry);
  return getTask(board, id);
}

/** Give a task to another member of the team. */
function reassignTask(board, id, owner) {
  return changeIndexed(board, id, {
    check: () => { if (!isMember(board.members, owner)) throw new UnknownMemberError(owner); },
    apply: (task) => {
      const from = task.owner;
      task.owner = owner;
      return { kind: 'reassigned', id, from, to: owner };
    },
  });
}

/** Replace a task's labels. */
function relabelTask(board, id, labels) {
  return changeIndexed(board, id, {
    apply: (task) => {
      const from = [...task.labels];
      task.labels = [...new Set(labels)].sort();
      return { kind: 'relabelled', id, from, to: [...task.labels] };
    },
  });
}

function tasksFor(board, owner) {
  return idsFor(board.indexes, owner).map((id) => getTask(board, id));
}

function tasksLabelled(board, label) {
  return idsLabelled(board.indexes, label).map((id) => getTask(board, id));
}

function openCount(board, owner) {
  return openCountFor(board.indexes, owner);
}

function historyOf(board) {
  return board.history.map((entry) => ({ ...entry }));
}

module.exports = {
  createBoard, getTask, addTask, renameTask, closeTask, reassignTask, relabelTask,
  tasksFor, tasksLabelled, openCount, historyOf,
};
