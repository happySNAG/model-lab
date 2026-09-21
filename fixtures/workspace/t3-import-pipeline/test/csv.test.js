'use strict';

// A plain Node script so the fixture needs no install, no package manager and no network.
// Exits 0 when everything holds, 1 otherwise, with one line per check on stdout.

const assert = require('node:assert');
const { parseCSV, parseLine } = require('../src/csv.js');
const { parseRows } = require('../src/stages/parse.js');

const checks = [
  ['plain cells split on commas', () => {
    assert.deepStrictEqual(parseLine('a,b,c'), ['a', 'b', 'c']);
    assert.deepStrictEqual(parseLine('a,,c'), ['a', '', 'c']);
  }],
  ['quoted cells may hold commas and quotes', () => {
    assert.deepStrictEqual(parseLine('"a,b",c'), ['a,b', 'c']);
    assert.deepStrictEqual(parseLine('"say ""hi""",c'), ['say "hi"', 'c']);
  }],
  ['blank lines and carriage returns are not rows', () => {
    assert.deepStrictEqual(parseCSV('a,b\r\n\r\nc,d\n'), [['a', 'b'], ['c', 'd']]);
  }],
  ['the first row is the header, and every row knows its line', () => {
    const parsed = parseRows('id,email\n1,a@x.com\n2,b@x.com\n');
    assert.deepStrictEqual(parsed.header, ['id', 'email']);
    assert.deepStrictEqual(parsed.rows.map((row) => row.lineNumber), [2, 3]);
    assert.deepStrictEqual(parsed.rows[0].cells, { id: '1', email: 'a@x.com' });
  }],
  ['nothing at all is no header and no rows', () => {
    assert.deepStrictEqual(parseRows(''), { header: [], rows: [] });
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
