'use strict';

const { writeTable } = require('./table.js');
const { COLUMNS } = require('./decode.js');

/** A new roster holding these members, one row each: `{ handle, name, team, role, since? }`. */
function encode(members) {
  const ordered = [...members].sort((a, b) => (a.handle < b.handle ? -1 : a.handle > b.handle ? 1 : 0));
  return writeTable({
    header: [...COLUMNS],
    entries: ordered.map((member) => ({ kind: 'row', cells: COLUMNS.map((column) => member[column] ?? '') })),
  });
}

module.exports = { encode };
