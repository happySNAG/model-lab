'use strict';

/**
 * The record types this importer knows.
 *
 * `fields` are the columns a record of this type has. `naturalKey` is what says which real thing a
 * record is about — see `docs/PIPELINE.md`, which is emphatic that this is not the `id` column.
 */
const TYPES = {
  person: {
    id: 'person',
    fields: ['id', 'email', 'name', 'city', 'age'],
    numericFields: ['age'],
    naturalKeyField: 'email',
  },
  company: {
    id: 'company',
    fields: ['id', 'taxID', 'name', 'country', 'employees'],
    numericFields: ['employees'],
    naturalKeyField: 'taxID',
  },
};

function typeNamed(name) {
  const found = TYPES[name];
  if (found === undefined) throw new RangeError(`no such record type: ${name}`);
  return found;
}

/**
 * What says which real thing this record is about, in the form two records are compared by.
 *
 * Blank when the record carries nothing under the type's natural key field.
 */
function naturalKeyOf(type, record) {
  const value = record[type.naturalKeyField];
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

module.exports = { TYPES, typeNamed, naturalKeyOf };
