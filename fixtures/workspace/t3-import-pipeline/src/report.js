'use strict';

/** The import report a person reads. */
function renderReport(report) {
  const lines = [
    `${report.rowsRead} rows read`,
    `${report.imported} imported`,
    `${report.dropped.invalid} dropped as invalid`,
    `${report.dropped.duplicate} dropped as duplicates`,
  ];
  for (const reason of report.reasons) lines.push(`  ${reason}`);
  return lines.join('\n');
}

/** Whether the report accounts for every row it read. */
function reportAddsUp(report) {
  return report.rowsRead === report.imported + report.dropped.invalid + report.dropped.duplicate;
}

module.exports = { renderReport, reportAddsUp };
