'use strict';

const { typeNamed, naturalKeyOf } = require('../types.js');
const { isBlank } = require('./coerce.js');

function dedupeRecords(typeName, records) {
  const type = typeNamed(typeName);
  const byKey = new Map();
  const kept = [];
  const dropped = [];
  for (const record of records) {
    const key = naturalKeyOf(type, record.fields);
    const already = byKey.get(key);
    if (already === undefined) {
      const survivor = { lineNumber: record.lineNumber, type: record.type, fields: { ...record.fields } };
      byKey.set(key, survivor);
      kept.push(survivor);
      continue;
    }
    for (const field of type.fields) {
      if (!isBlank(record.fields[field])) already.fields[field] = record.fields[field];
    }
    dropped.push({ record, reason: `line ${record.lineNumber}: the same ${type.id} as line ${already.lineNumber}` });
  }
  return { kept, dropped };
}

module.exports = { dedupeRecords };
