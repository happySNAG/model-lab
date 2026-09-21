'use strict';

// A plain Node script so the fixture needs no install, no package manager and no network.
// Exits 0 when everything holds, 1 otherwise, with one line per check on stdout.

const assert = require('node:assert');
const { wrap, wrapped } = require('../src/wrap.js');
const { escapeHTML } = require('../src/escape.js');

const checks = [
  ['a paragraph wraps between words', () => {
    assert.deepStrictEqual(wrap('the quick brown fox jumps', 10), ['the quick', 'brown fox', 'jumps']);
    assert.deepStrictEqual(wrap('   ', 10), []);
  }],
  ['a wrapped paragraph joins with newlines', () => {
    assert.strictEqual(wrapped('the quick brown fox jumps', 10), 'the quick\nbrown fox\njumps');
  }],
  ['a column width has to be one', () => {
    assert.throws(() => wrap('anything', 0));
  }],
  ['text embedded in HTML is escaped', () => {
    assert.strictEqual(escapeHTML('<a href="x">A & B</a>'), '&lt;a href=&quot;x&quot;&gt;A &amp; B&lt;/a&gt;');
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
