'use strict';

// A plain Node script so the fixture needs no install, no package manager and no network.
// Exits 0 when everything holds, 1 otherwise, with one line per check on stdout.

const assert = require('node:assert');
const { redactLine } = require('../src/redact.js');

const TOKEN = 'acme_pat_Q7c2Lm9Xw4Rt8Ns1Vb6Kd3Hy';

const checks = [
  ['a personal-data field is masked', () => {
    const line = JSON.stringify({ level: 'info', event: 'login', email: 'ada@example.test' });
    assert.deepStrictEqual(JSON.parse(redactLine(line)), { level: 'info', event: 'login', email: '[masked]' });
  }],
  ['a personal-data field is masked however deep it is', () => {
    const line = JSON.stringify({ level: 'info', event: 'signup', user: { id: 7, email: 'ada@example.test' } });
    assert.deepStrictEqual(JSON.parse(redactLine(line)).user, { id: 7, email: '[masked]' });
  }],
  ['a credential in a message is masked', () => {
    const line = JSON.stringify({ level: 'warn', msg: `retrying with ${TOKEN} after a timeout` });
    assert.strictEqual(JSON.parse(redactLine(line)).msg, 'retrying with [masked] after a timeout');
  }],
  ['a non-string personal-data value is masked as a string', () => {
    const line = JSON.stringify({ level: 'info', phone: 5550100 });
    assert.strictEqual(JSON.parse(redactLine(line)).phone, '[masked]');
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
