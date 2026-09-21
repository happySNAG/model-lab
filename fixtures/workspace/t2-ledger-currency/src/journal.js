'use strict';

const { maximumEntriesPerJournal } = require('./config.js');

/** A journal is a label and the entries under it, in the order they were added. */
function createJournal(label) {
  return { label: typeof label === 'string' ? label : 'journal', entries: [] };
}

/** Add an entry. Journals are mutable containers; this is the only thing that writes to one. */
function addEntry(journal, entry) {
  if (journal.entries.length >= maximumEntriesPerJournal()) {
    throw new RangeError(`a journal holds at most ${maximumEntriesPerJournal()} entries`);
  }
  journal.entries.push(entry);
  return journal;
}

/**
 * What the journal comes to.
 *
 * `docs/API.md` is the contract for this function: what it answers with, and the one case it
 * refuses rather than answering.
 */
function totalOf(journal) {
  return journal.entries.reduce((total, entry) => total + entry.amountCents, 0);
}

/** Every entry, in the order it was added. */
function entriesOf(journal) {
  return [...journal.entries];
}

module.exports = { createJournal, addEntry, totalOf, entriesOf };
