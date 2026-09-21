'use strict';

// A plain Node script so the fixture needs no install, no package manager and no network.
// Exits 0 when everything holds, 1 otherwise, with one line per check on stdout.

const assert = require('node:assert');
const { parseRows } = require('../src/stages/parse.js');
const { coerceRows, isBlank } = require('../src/stages/coerce.js');
const { naturalKeyOf, typeNamed } = require('../src/types.js');

const coerce = (text) => coerceRows('person', parseRows(text).rows);

const checks = [
  ['every field the type declares is present, trimmed', () => {
    const [record] = coerce('id,email,name,city,age\n 1 , ada@example.com ,Ada,London,36\n');
    assert.deepStrictEqual(record.fields, { id: '1', email: 'ada@example.com', name: 'Ada', city: 'London', age: 36 });
    assert.strictEqual(record.lineNumber, 2);
    assert.strictEqual(record.type, 'person');
  }],
  ['a numeric field that carries nothing stays blank rather than becoming zero', () => {
    const [record] = coerce('id,email,name,city,age\n1,a@x.com,A,London,\n');
    assert.strictEqual(record.fields.age, '');
    assert.strictEqual(isBlank(record.fields.age), true);
  }],
  ['a column the type does not declare is ignored', () => {
    const [record] = coerce('id,email,name,nickname\n1,a@x.com,A,Ace\n');
    assert.deepStrictEqual(Object.keys(record.fields), ['id', 'email', 'name', 'city', 'age']);
  }],
  ['a natural key is compared without regard to case or space', () => {
    const person = typeNamed('person');
    assert.strictEqual(naturalKeyOf(person, { email: ' ADA@Example.com ' }), 'ada@example.com');
    assert.strictEqual(naturalKeyOf(person, { email: '' }), '');
    assert.strictEqual(naturalKeyOf(typeNamed('company'), { taxID: ' GB-1 ' }), 'gb-1');
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
