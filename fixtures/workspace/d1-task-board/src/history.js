'use strict';

/** The record of every change, oldest first. Entries are never edited or removed. */
function createHistory() {
  return [];
}

function record(history, entry) {
  history.push({ ...entry });
}

function entriesFor(history, id) {
  return history.filter((entry) => entry.id === id).map((entry) => ({ ...entry }));
}

module.exports = { createHistory, record, entriesFor };
