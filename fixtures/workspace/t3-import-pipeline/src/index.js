'use strict';

const { parseCSV, parseLine } = require('./csv.js');
const { TYPES, typeNamed, naturalKeyOf } = require('./types.js');
const { parseRows } = require('./stages/parse.js');
const { coerceRows, isBlank } = require('./stages/coerce.js');
const { validateRecords } = require('./stages/validate.js');
const { dedupeRecords } = require('./stages/dedupe.js');
const { collect } = require('./stages/collect.js');
const { importText } = require('./pipeline.js');
const { renderReport, reportAddsUp } = require('./report.js');

/** The public API. A consumer of this package never reaches past this file into `src/`. */
module.exports = {
  parseCSV, parseLine,
  TYPES, typeNamed, naturalKeyOf,
  parseRows, coerceRows, isBlank,
  validateRecords, dedupeRecords, collect,
  importText,
  renderReport, reportAddsUp,
};
