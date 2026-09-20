'use strict';

// A plain Node script so the fixture needs no install, no package manager and no network.
// Exits 0 when everything holds, 1 otherwise, with one line per check on stdout.

const assert = require('node:assert');
const { totalCents, formatCents, renderReport } = require('../src/report.js');

const PURCHASES_ONLY = ['Coffee: $4.25', 'Book: $12.50', 'Lamp: $26.00'];
const WITH_A_REFUND = ['Coffee: $4.25', 'Book: $12.50', 'Refund: -$5.00', 'Lamp: $26.00'];

const checks = [
  ['a receipt of purchases totals correctly', () => {
    assert.strictEqual(renderReport(PURCHASES_ONLY), '3 entries · total $42.75');
  }],
  ['a receipt containing a refund totals correctly', () => {
    assert.strictEqual(renderReport(WITH_A_REFUND), '4 entries · total $37.75');
  }],
  ['a receipt that is nothing but a refund totals correctly', () => {
    assert.strictEqual(renderReport(['Return: -$3.00']), '1 entries · total -$3.00');
  }],
  ['totals and formatting are unchanged for values handed in directly', () => {
    assert.strictEqual(totalCents([{ name: 'a', amountCents: 425 }, { name: 'b', amountCents: -500 }]), -75);
    assert.strictEqual(formatCents(-75), '-$0.75');
    assert.strictEqual(formatCents(4275), '$42.75');
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
