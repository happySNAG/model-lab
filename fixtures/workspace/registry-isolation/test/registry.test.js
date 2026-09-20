'use strict';

// A plain Node script so the fixture needs no install, no package manager and no network.
// Exits 0 when everything holds, 1 otherwise, with one line per check on stdout.

const assert = require('node:assert');
const { DEFAULT_OPTIONS, createRegistry, register, namesOf } = require('../src/registry.js');

const checks = [
  ['a registry records what is put in it', () => {
    const registry = createRegistry();
    register(registry, 'alpha');
    register(registry, 'beta');
    assert.deepStrictEqual(namesOf(registry), ['alpha', 'beta']);
  }],
  ['two registries created with no options are independent', () => {
    const first = createRegistry();
    register(first, 'alpha');
    const second = createRegistry();
    assert.deepStrictEqual(namesOf(second), []);
    assert.deepStrictEqual(namesOf(first), ['alpha']);
  }],
  ['registering never writes into DEFAULT_OPTIONS', () => {
    register(createRegistry(), 'alpha');
    assert.deepStrictEqual(DEFAULT_OPTIONS.entries, []);
  }],
  ['a registry keeps the label it was given', () => {
    assert.strictEqual(createRegistry({ label: 'plugins', entries: [] }).label, 'plugins');
    assert.strictEqual(createRegistry().label, 'registry');
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
