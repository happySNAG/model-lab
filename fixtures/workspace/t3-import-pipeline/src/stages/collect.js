'use strict';

/**
 * The records and the report, together.
 *
 * `docs/PIPELINE.md` says what the report carries and what has to add up.
 */
function collect(rowsRead, validation, deduplication) {
  return {
    records: deduplication.kept,
    report: {
      rowsRead,
      imported: deduplication.kept.length,
      dropped: {
        invalid: validation.dropped.length,
        duplicate: deduplication.dropped.length,
      },
      reasons: [],
    },
  };
}

module.exports = { collect };
