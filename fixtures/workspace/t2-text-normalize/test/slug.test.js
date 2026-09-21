'use strict';

// A plain Node script so the fixture needs no install, no package manager and no network.
// Exits 0 when everything holds, 1 otherwise, with one line per check on stdout.

const assert = require('node:assert');
const { slugify } = require('../src/slug.js');

const checks = [
  ['plain ASCII slugs as it always did', () => {
    assert.strictEqual(slugify('Hello World'), 'hello-world');
    assert.strictEqual(slugify('  Trailing punctuation!!  '), 'trailing-punctuation');
    assert.strictEqual(slugify('Room 101'), 'room-101');
  }],
  ['a name written with marks keeps its letters', () => {
    assert.strictEqual(slugify('Café Münster'), 'cafe-munster');
    assert.strictEqual(slugify('Ångström'), 'angstrom');
    assert.strictEqual(slugify('Niño'), 'nino');
  }],
  ['a name written with letters that carry no mark keeps its letters too', () => {
    assert.strictEqual(slugify('Ørsted Lab'), 'orsted-lab');
    assert.strictEqual(slugify('Łódź'), 'lodz');
    assert.strictEqual(slugify('Straße 12'), 'strasse-12');
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
