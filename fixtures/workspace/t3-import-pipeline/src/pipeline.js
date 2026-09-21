'use strict';

const { parseRows } = require('./stages/parse.js');
const { coerceRows } = require('./stages/coerce.js');
const { validateRecords } = require('./stages/validate.js');
const { dedupeRecords } = require('./stages/dedupe.js');
const { collect } = require('./stages/collect.js');

/** The stages, in order. */
function importText(typeName, text) {
  const parsed = parseRows(text);
  const coerced = coerceRows(typeName, parsed.rows);
  const validation = validateRecords(typeName, coerced);
  const deduplication = dedupeRecords(typeName, validation.kept);
  return collect(parsed.rows.length, validation, deduplication);
}

module.exports = { importText };
