'use strict';

const { RosterError } = require('./errors.js');

/**
 * A roster text as a table: `{ header, entries }`, the header as its column names and every line
 * after it as `{ kind: 'row', cells }` or `{ kind: 'comment', text }`, in the order written.
 *
 * Nothing is interpreted beyond the commas, so what is read can be written back as it was.
 */
function readTable(text) {
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  if (lines.length === 0 || lines[0] === '' || lines[0].startsWith('#')) {
    throw new RosterError('a roster starts with its header');
  }
  const header = lines[0].split(',');
  const entries = [];
  for (const [index, line] of lines.slice(1).entries()) {
    if (line.startsWith('#')) {
      entries.push({ kind: 'comment', text: line });
      continue;
    }
    const cells = line.split(',');
    if (cells.length !== header.length) {
      throw new RosterError(`line ${index + 2} has ${cells.length} cell(s) under a header of ${header.length} column(s)`);
    }
    entries.push({ kind: 'row', cells });
  }
  return { header, entries };
}

/** The text for a table: the header, then one line per entry, ending with a line break. */
function writeTable(table) {
  const lines = [table.header.join(',')];
  for (const entry of table.entries) lines.push(entry.kind === 'comment' ? entry.text : entry.cells.join(','));
  return `${lines.join('\n')}\n`;
}

module.exports = { readTable, writeTable };
