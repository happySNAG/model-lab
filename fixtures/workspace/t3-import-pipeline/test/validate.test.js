'use strict';

// A plain Node script so the fixture needs no install, no package manager and no network.
// Exits 0 when everything holds, 1 otherwise, with one line per check on stdout.

const assert = require('node:assert');
const { parseRows } = require('../src/stages/parse.js');
const { coerceRows } = require('../src/stages/coerce.js');
const { validateRecords } = require('../src/stages/validate.js');
const { PEOPLE } = require('./fixture.js');

const validated = validateRecords('person', coerceRows('person', parseRows(PEOPLE).rows));

const checks = [
  ['the rows that are fit to import are kept, in the order they were read', () => {
    assert.deepStrictEqual(validated.kept.map((record) => record.lineNumber), [2, 4, 5, 7]);
  }],
  ['a row that is not fit to import is dropped', () => {
    assert.deepStrictEqual(validated.dropped.map((entry) => entry.record.lineNumber), [3, 6]);
  }],
  ['and it is dropped with a reason saying which row and what was wrong', () => {
    assert.deepStrictEqual(validated.dropped.map((entry) => entry.reason), [
      'line 3: a person needs an email address',
      'line 6: a person needs a name',
    ]);
  }],
  ['a company is judged by what identifies a company', () => {
    const text = 'id,taxID,name,country,employees\n1,,Nameless Ltd,GB,3\n2,GB-22,Real Ltd,GB,4\n';
    const result = validateRecords('company', coerceRows('company', parseRows(text).rows));
    assert.deepStrictEqual(result.kept.map((record) => record.lineNumber), [3]);
    assert.deepStrictEqual(result.dropped.map((entry) => entry.reason), ['line 2: a company needs a taxID']);
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
