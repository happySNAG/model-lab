'use strict';

// A plain Node script so the fixture needs no install, no package manager and no network.
// Exits 0 when everything holds, 1 otherwise, with one line per check on stdout.

const assert = require('node:assert');
const { sortKey, sortByName } = require('../src/sortkey.js');

const checks = [
  ['a plain name files under itself', () => {
    assert.strictEqual(sortKey('Palmer'), 'palmer');
    assert.strictEqual(sortKey('lima'), 'lima');
  }],
  ['a name files under the letter a reader would look under', () => {
    assert.strictEqual(sortKey('Ørsted'), 'orsted');
    assert.strictEqual(sortKey('Łódź'), 'lodz');
    assert.strictEqual(sortKey('Ægir'), 'aegir');
  }],
  ['sorting files names where a reader would look for them', () => {
    assert.deepStrictEqual(sortByName(['Palmer', 'Ørsted']), ['Ørsted', 'Palmer']);
    assert.deepStrictEqual(
      sortByName(['Zurich', 'Łódź', 'Lima', 'Århus']),
      ['Århus', 'Lima', 'Łódź', 'Zurich'],
    );
  }],
  ['names that file alike keep the order they were given', () => {
    assert.deepStrictEqual(sortByName(['Orsted', 'Ørsted']), ['Orsted', 'Ørsted']);
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
