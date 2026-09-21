'use strict';

const { totalOf, entriesOf } = require('./journal.js');

/** One entry, as a line of the report. */
function renderEntry(entry) {
  return `${entry.description} ${entry.amountCents}`;
}

/**
 * The whole report a person reads: every entry, then what the journal comes to.
 *
 * Lines are joined with a newline. The last line is always the total.
 */
function renderJournal(journal) {
  const lines = entriesOf(journal).map(renderEntry);
  lines.push(`total ${totalOf(journal)}`);
  return lines.join('\n');
}

module.exports = { renderEntry, renderJournal };
