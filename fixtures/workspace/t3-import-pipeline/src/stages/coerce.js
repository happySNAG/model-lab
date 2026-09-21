'use strict';

const { typeNamed } = require('../types.js');

/**
 * Rows as typed records.
 *
 * Strings are trimmed. The type's numeric fields become whole numbers when they carry a number and
 * are left as the empty string when they carry nothing. A column the type does not declare is
 * ignored — `docs/PIPELINE.md` says an unknown column is not an error.
 */
function coerceRows(typeName, rows) {
  const type = typeNamed(typeName);
  return rows.map((row) => {
    const record = { lineNumber: row.lineNumber, type: type.id, fields: {} };
    for (const field of type.fields) {
      const raw = row.cells[field] === undefined ? '' : String(row.cells[field]).trim();
      if (type.numericFields.includes(field)) {
        record.fields[field] = raw.length === 0 || !/^-?[0-9]+$/.test(raw) ? '' : Number.parseInt(raw, 10);
      } else {
        record.fields[field] = raw;
      }
    }
    return record;
  });
}

/** Whether a field carries anything at all. A blank cell is not a value. */
function isBlank(value) {
  return value === '' || value === undefined || value === null;
}

module.exports = { coerceRows, isBlank };
