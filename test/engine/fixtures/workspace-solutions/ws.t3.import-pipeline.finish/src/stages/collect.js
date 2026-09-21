'use strict';

function collect(rowsRead, validation, deduplication) {
  const reasons = [...validation.dropped, ...deduplication.dropped]
    .sort((a, b) => a.record.lineNumber - b.record.lineNumber)
    .map((entry) => entry.reason);
  return {
    records: deduplication.kept,
    report: {
      rowsRead,
      imported: deduplication.kept.length,
      dropped: { invalid: validation.dropped.length, duplicate: deduplication.dropped.length },
      reasons,
    },
  };
}

module.exports = { collect };
