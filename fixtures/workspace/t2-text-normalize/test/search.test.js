'use strict';

// A plain Node script so the fixture needs no install, no package manager and no network.
// Exits 0 when everything holds, 1 otherwise, with one line per check on stdout.

const assert = require('node:assert');
const { matches, filterMatching } = require('../src/search.js');

const checks = [
  ['a plain query finds plain text', () => {
    assert.strictEqual(matches('Hello World', 'world'), true);
    assert.strictEqual(matches('Hello World', 'globe'), false);
    assert.strictEqual(matches('Hello World', '   '), false);
  }],
  ['a query typed without marks finds a name written with them', () => {
    assert.strictEqual(matches('Café Münster', 'munster'), true);
    assert.strictEqual(matches('Niño', 'nino'), true);
  }],
  ['a query typed in ASCII finds a name written with letters that carry no mark', () => {
    assert.strictEqual(matches('Straße 12', 'strasse'), true);
    assert.strictEqual(matches('Ørsted Lab', 'orsted'), true);
    assert.strictEqual(matches('Łukasz', 'lukasz'), true);
  }],
  ['filtering keeps the order it was given', () => {
    assert.deepStrictEqual(
      filterMatching(['Ørsted Lab', 'Hello World', 'Orsted Annexe'], 'orsted'),
      ['Ørsted Lab', 'Orsted Annexe'],
    );
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
