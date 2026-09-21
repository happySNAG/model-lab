'use strict';

const { typeNamed } = require('../types.js');

/**
 * One record per thing, out of however many rows mentioned it.
 *
 * `docs/PIPELINE.md` says what decides that two rows are the same thing, what the surviving record
 * carries, and where it comes in the output.
 */
function dedupeRecords(typeName, records) {
  typeNamed(typeName);
  const seen = new Set();
  const kept = [];
  const dropped = [];
  for (const record of records) {
    const key = String(record.fields.id);
    if (seen.has(key)) {
      dropped.push(record);
      continue;
    }
    seen.add(key);
    kept.push(record);
  }
  return { kept, dropped };
}

module.exports = { dedupeRecords };
