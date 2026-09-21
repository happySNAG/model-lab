'use strict';

const { parseCSV } = require('../csv.js');

/**
 * Rows with the header applied.
 *
 * The first row is the header. Every row after it becomes an object keyed by the header's names,
 * carrying the line number it came from so a later stage can say where something went wrong.
 */
function parseRows(text) {
  const rows = parseCSV(text);
  if (rows.length === 0) return { header: [], rows: [] };
  const header = rows[0].map((name) => name.trim());
  return {
    header,
    rows: rows.slice(1).map((cells, index) => {
      const row = { lineNumber: index + 2, cells: {} };
      header.forEach((name, column) => {
        row.cells[name] = cells[column] === undefined ? '' : cells[column];
      });
      return row;
    }),
  };
}

module.exports = { parseRows };
