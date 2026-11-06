'use strict';

const { readTable } = require('./table.js');
const { RosterError } = require('./errors.js');

const COLUMNS = ['handle', 'name', 'team', 'role', 'since'];

/**
 * The members in a roster: `[{ handle, name, team, role, since }]`, in the order written.
 *
 * Takes what it understands, as docs/FORMAT.md says a reader does: a column it does not know and
 * every comment are ignored.
 */
function decode(text) {
  const table = readTable(text);
  for (const column of COLUMNS) {
    if (!table.header.includes(column)) throw new RosterError(`the roster has no ${column} column`);
  }
  const members = [];
  for (const entry of table.entries) {
    if (entry.kind !== 'row') continue;
    const member = {};
    COLUMNS.forEach((column, index) => {
      member[column] = entry.cells[index];
    });
    members.push(member);
  }
  const handles = members.map((member) => member.handle);
  const repeated = handles.find((handle, index) => handles.indexOf(handle) !== index);
  if (repeated !== undefined) throw new RosterError(`two rows carry the handle ${repeated}`);
  return members;
}

module.exports = { decode, COLUMNS };
