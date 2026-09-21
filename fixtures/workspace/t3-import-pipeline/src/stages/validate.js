'use strict';

const { typeNamed, naturalKeyOf } = require('../types.js');
const { isBlank } = require('./coerce.js');

/**
 * The records that are fit to import, and the ones that are not.
 *
 * `docs/PIPELINE.md` says what makes a record fit, and what a dropped row is supposed to come with.
 */
function validateRecords(typeName, records) {
  const type = typeNamed(typeName);
  const kept = [];
  const dropped = [];
  for (const record of records) {
    if (naturalKeyOf(type, record.fields).length === 0 || isBlank(record.fields.name)) {
      dropped.push(record);
      continue;
    }
    kept.push(record);
  }
  return { kept, dropped };
}

module.exports = { validateRecords };
