'use strict';

// A plain Node script so the fixture needs no install, no package manager and no network.
// Exits 0 when everything holds, 1 otherwise, with one line per check on stdout.

const assert = require('node:assert');
const { importText } = require('../src/pipeline.js');
const { reportAddsUp } = require('../src/report.js');
const { PEOPLE } = require('./fixture.js');

const result = importText('person', PEOPLE);

const checks = [
  ['the importer answers with the records and the report', () => {
    assert.strictEqual(result.records.length, 2);
    assert.strictEqual(result.report.rowsRead, 6);
    assert.strictEqual(result.report.imported, 2);
  }],
  ['every row is accounted for under exactly one heading', () => {
    assert.deepStrictEqual(result.report.dropped, { invalid: 2, duplicate: 2 });
    assert.strictEqual(reportAddsUp(result.report), true);
  }],
  ['the reasons come back in the order the rows were read', () => {
    assert.deepStrictEqual(result.report.reasons, [
      'line 3: a person needs an email address',
      'line 5: the same person as line 2',
      'line 6: a person needs a name',
      'line 7: the same person as line 4',
    ]);
  }],
  ['importing nothing is not an error', () => {
    const empty = importText('person', 'id,email,name,city,age\n');
    assert.deepStrictEqual(empty.records, []);
    assert.strictEqual(empty.report.rowsRead, 0);
    assert.strictEqual(reportAddsUp(empty.report), true);
  }],
  ['importing the same text twice gives the same answer', () => {
    assert.deepStrictEqual(importText('person', PEOPLE), importText('person', PEOPLE));
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
