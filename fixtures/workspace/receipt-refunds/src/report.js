'use strict';

const { parseReceipt } = require('./parse.js');

/** The sum of every record, in whole cents. */
function totalCents(records) {
  return records.reduce((total, record) => total + record.amountCents, 0);
}

/** Whole cents as the string a person reads. Negative totals keep their sign. */
function formatCents(cents) {
  return `${cents < 0 ? '-' : ''}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

/** The whole report: how many entries there were, and what they come to. */
function renderReport(lines) {
  const records = parseReceipt(lines);
  return `${records.length} entries · total ${formatCents(totalCents(records))}`;
}

module.exports = { totalCents, formatCents, renderReport };
