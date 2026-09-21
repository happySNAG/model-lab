'use strict';

// A plain Node script so the fixture needs no install, no package manager and no network.
// Exits 0 when everything holds, 1 otherwise, with one line per check on stdout.

const assert = require('node:assert');
const { parseRows } = require('../src/stages/parse.js');
const { coerceRows } = require('../src/stages/coerce.js');
const { validateRecords } = require('../src/stages/validate.js');
const { dedupeRecords } = require('../src/stages/dedupe.js');
const { PEOPLE } = require('./fixture.js');

const deduped = dedupeRecords('person',
  validateRecords('person', coerceRows('person', parseRows(PEOPLE).rows)).kept);

const checks = [
  ['two rows about the same thing become one record', () => {
    assert.strictEqual(deduped.kept.length, 2);
    assert.deepStrictEqual(deduped.dropped.map((entry) => entry.record.lineNumber), [5, 7]);
  }],
  ['what makes them the same thing is the natural key, not the id column', () => {
    assert.deepStrictEqual(deduped.kept.map((record) => record.fields.email.toLowerCase()),
      ['ada@example.com', 'grace@example.com']);
  }],
  ['the surviving record keeps the place of the row that first mentioned it', () => {
    assert.deepStrictEqual(deduped.kept.map((record) => record.lineNumber), [2, 4]);
  }],
  ['a later row wins, field by field', () => {
    assert.strictEqual(deduped.kept[0].fields.name, 'Ada L.');
    assert.strictEqual(deduped.kept[0].fields.city, 'Cambridge');
    assert.strictEqual(deduped.kept[0].fields.age, 37);
    assert.strictEqual(deduped.kept[1].fields.city, 'Arlington');
  }],
  ['a dropped duplicate says which record it was folded into', () => {
    assert.deepStrictEqual(deduped.dropped.map((entry) => entry.reason), [
      'line 5: the same person as line 2',
      'line 7: the same person as line 4',
    ]);
  }],
  ['rows with different natural keys are different things whatever their ids say', () => {
    const text = 'id,email,name,city,age\n7,a@x.com,A,London,1\n7,b@x.com,B,Paris,2\n';
    const result = dedupeRecords('person', coerceRows('person', parseRows(text).rows));
    assert.strictEqual(result.kept.length, 2);
    assert.strictEqual(result.dropped.length, 0);
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
