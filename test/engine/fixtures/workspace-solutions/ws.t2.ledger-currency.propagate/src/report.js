'use strict';

const { formatMoney } = require('./money.js');
const { totalOf, entriesOf } = require('./journal.js');

/** One entry, as a line of the report. */
function renderEntry(entry) {
  return `${entry.description} ${formatMoney(entry.amountCents, entry.currency)}`;
}

/**
 * The whole report a person reads: every entry, then what the journal comes to.
 *
 * Lines are joined with a newline. The last line is always the total.
 */
function renderJournal(journal) {
  const lines = entriesOf(journal).map(renderEntry);
  const total = totalOf(journal);
  lines.push(`total ${formatMoney(total.amountCents, total.currency)}`);
  return lines.join('\n');
}

module.exports = { renderEntry, renderJournal };
