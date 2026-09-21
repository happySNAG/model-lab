'use strict';

// A plain Node script so the fixture needs no install, no package manager and no network.
// Exits 0 when everything holds, 1 otherwise, with one line per check on stdout.

const assert = require('node:assert');
const { redactLine } = require('../src/redact.js');

const checks = [
  ['a personal-data field is masked in place', () => {
    assert.strictEqual(redactLine('level=info user=ada email=ada@example.test plan=pro'),
      'level=info user=ada email=[masked] plan=pro');
  }],
  ['a quoted personal-data value is masked, quotes and all', () => {
    assert.strictEqual(redactLine('level=info user=ada card_number="4111 1111 1111 1111" plan=pro'),
      'level=info user=ada card_number="[masked]" plan=pro');
  }],
  ['a credential in a quoted message is masked', () => {
    assert.strictEqual(redactLine('level=warn msg="key acme_sk_0123456789abcdef0123456789abcdef rejected"'),
      'level=warn msg="key [masked] rejected"');
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
