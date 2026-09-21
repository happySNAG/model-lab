'use strict';

// A plain Node script so the fixture needs no install, no package manager and no network.
// Exits 0 when everything holds, 1 otherwise, with one line per check on stdout.

const assert = require('node:assert');
const { redactLine } = require('../src/redact.js');
const { redactText } = require('../src/pipeline.js');

const checks = [
  ['a credential in a stack trace is masked', () => {
    assert.strictEqual(redactLine('Error: upstream refused acme_pat_Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2 (401)'),
      'Error: upstream refused [masked] (401)');
  }],
  ['plain prose is passed on', () => {
    assert.strictEqual(redactLine('worker 3 started'), 'worker 3 started');
  }],
  ['a block keeps its lines and its line endings', () => {
    const block = 'first line\nsecond line\n';
    assert.strictEqual(redactText(block), block);
  }],
  ['a minimum level drops the lines below it, and only those', () => {
    const block = ['level=debug msg=noise', 'level=error msg=boom', 'no level here'].join('\n');
    assert.strictEqual(redactText(block, { minimumLevel: 'info' }), 'level=error msg=boom\nno level here');
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
