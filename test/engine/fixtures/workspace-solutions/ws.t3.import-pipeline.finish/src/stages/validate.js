'use strict';

const { typeNamed, naturalKeyOf } = require('../types.js');
const { isBlank } = require('./coerce.js');

const NATURAL_KEY_LABEL = { person: 'an email address', company: 'a taxID' };

function validateRecords(typeName, records) {
  const type = typeNamed(typeName);
  const kept = [];
  const dropped = [];
  for (const record of records) {
    if (naturalKeyOf(type, record.fields).length === 0) {
      dropped.push({ record, reason: `line ${record.lineNumber}: a ${type.id} needs ${NATURAL_KEY_LABEL[type.id]}` });
      continue;
    }
    if (isBlank(record.fields.name)) {
      dropped.push({ record, reason: `line ${record.lineNumber}: a ${type.id} needs a name` });
      continue;
    }
    kept.push(record);
  }
  return { kept, dropped };
}

module.exports = { validateRecords };
