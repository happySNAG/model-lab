'use strict';

// A plain Node script so the fixture needs no install, no package manager and no network.
// Exits 0 when everything holds, 1 otherwise, with one line per check on stdout.

const assert = require('node:assert');
const { importText } = require('../src/pipeline.js');
const { renderReport, reportAddsUp } = require('../src/report.js');
const { PEOPLE } = require('./fixture.js');

const checks = [
  ['the report reads as a person would say it', () => {
    assert.strictEqual(renderReport(importText('person', PEOPLE).report), [
      '6 rows read',
      '2 imported',
      '2 dropped as invalid',
      '2 dropped as duplicates',
      '  line 3: a person needs an email address',
      '  line 5: the same person as line 2',
      '  line 6: a person needs a name',
      '  line 7: the same person as line 4',
    ].join('\n'));
  }],
  ['a clean import has nothing to explain', () => {
    const clean = importText('person', 'id,email,name,city,age\n1,a@x.com,A,London,1\n');
    assert.strictEqual(renderReport(clean.report), '1 rows read\n1 imported\n0 dropped as invalid\n0 dropped as duplicates');
  }],
  ['a report that does not account for every row says so', () => {
    assert.strictEqual(reportAddsUp({ rowsRead: 5, imported: 2, dropped: { invalid: 1, duplicate: 1 }, reasons: [] }), false);
  }],
];

let failed = 0;
for (const [name, check] of checks) {
  try {
    check();
    console.log(`ok - ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`not ok - ${name}: ${error.message}`);
  }
}
console.log(`${checks.length - failed}/${checks.length} passed`);
process.exit(failed === 0 ? 0 : 1);
