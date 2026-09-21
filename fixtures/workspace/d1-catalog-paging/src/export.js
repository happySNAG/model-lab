'use strict';

const { walkAll } = require('./walk.js');

const COLUMNS = ['id', 'name', 'category', 'rank', 'stock'];

function field(value) {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** The whole listing as CSV, header first, in listing order. */
function exportCSV(store, options = {}) {
  const rows = walkAll(store, { limit: 50, ...options });
  return [COLUMNS.join(','), ...rows.map((row) => COLUMNS.map((column) => field(row[column])).join(','))].join('\n');
}

module.exports = { exportCSV, COLUMNS };
