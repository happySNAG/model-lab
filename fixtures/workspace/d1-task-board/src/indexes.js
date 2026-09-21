'use strict';

/**
 * The lookups a view reads instead of scanning every task.
 *
 *   byOwner    owner → the ids of every task they own, open or closed
 *   byLabel    label → the ids of every task carrying it
 *   openOwned  owner → the ids of their open tasks
 *
 * `indexTask` adds a task's entries and never removes any; `unindexTask` removes exactly the
 * entries `indexTask` would add for the same task. So an entry is only ever as current as the last
 * time something indexed the task it describes.
 */
function createIndexes() {
  return { byOwner: new Map(), byLabel: new Map(), openOwned: new Map() };
}

function add(map, key, id) {
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(id);
}

function drop(map, key, id) {
  const ids = map.get(key);
  if (ids === undefined) return;
  ids.delete(id);
  if (ids.size === 0) map.delete(key);
}

function indexTask(indexes, task) {
  add(indexes.byOwner, task.owner, task.id);
  for (const label of task.labels) add(indexes.byLabel, label, task.id);
  if (task.state === 'open') add(indexes.openOwned, task.owner, task.id);
}

function unindexTask(indexes, task) {
  drop(indexes.byOwner, task.owner, task.id);
  for (const label of task.labels) drop(indexes.byLabel, label, task.id);
  if (task.state === 'open') drop(indexes.openOwned, task.owner, task.id);
}

/** A task that has just been closed stops counting as open. Nothing else about it moves. */
function markClosed(indexes, task) {
  drop(indexes.openOwned, task.owner, task.id);
}

function idsFor(indexes, owner) {
  return [...(indexes.byOwner.get(owner) ?? [])].sort();
}

function idsLabelled(indexes, label) {
  return [...(indexes.byLabel.get(label) ?? [])].sort();
}

function openCountFor(indexes, owner) {
  return indexes.openOwned.get(owner)?.size ?? 0;
}

module.exports = { createIndexes, indexTask, unindexTask, markClosed, idsFor, idsLabelled, openCountFor };
