'use strict';

// A plain Node script so the fixture needs no install, no package manager and no network.
// Exits 0 when everything holds, 1 otherwise, with one line per check on stdout.

const assert = require('node:assert');
const api = require('../src/index.js');

const checks = [
  ['the public surface hands out the currencies it accepts', () => {
    assert.deepStrictEqual(api.CURRENCIES, ['USD', 'EUR', 'GBP']);
  }],
  ['the public surface hands out the money formatter', () => {
    assert.strictEqual(typeof api.formatMoney, 'function');
    assert.strictEqual(api.formatMoney(425, 'USD'), '$4.25');
  }],
  ['everything a consumer had before is still there', () => {
    for (const name of ['createEntry', 'createJournal', 'addEntry', 'totalOf', 'entriesOf',
      'renderEntry', 'renderJournal', 'toWire', 'fromWire', 'defaultCurrency']) {
      assert.strictEqual(typeof api[name], 'function', `${name} is missing from the public surface`);
    }
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
