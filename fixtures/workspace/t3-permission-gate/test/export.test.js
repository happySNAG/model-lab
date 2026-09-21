'use strict';

// A plain Node script so the fixture needs no install, no package manager and no network.
// Exits 0 when everything holds, 1 otherwise, with one line per check on stdout.

const assert = require('node:assert');
const { createActor } = require('../src/model/actor.js');
const { createStore } = require('../src/store/index.js');
const { exportDocument } = require('../src/handlers/export.js');
const { ForbiddenError } = require('../src/errors.js');

const actor = (role) => createActor({ id: `u-${role}`, role });

const checks = [
  ['a curator and an admin may take a document away', () => {
    const store = createStore();
    assert.strictEqual(exportDocument(store, actor('curator'), 'd1'), 'Onboarding\n\nHow we do things.');
    assert.strictEqual(exportDocument(store, actor('admin'), 'd1'), 'Onboarding\n\nHow we do things.');
  }],
  ['a reader and a writer may not', () => {
    const store = createStore();
    assert.throws(() => exportDocument(store, actor('reader'), 'd1'), ForbiddenError);
    assert.throws(() => exportDocument(store, actor('writer'), 'd1'), ForbiddenError);
  }],
  ['a confidential document is not a way around that', () => {
    const store = createStore();
    assert.throws(() => exportDocument(store, actor('reader'), 'd2'), ForbiddenError);
    assert.strictEqual(exportDocument(store, actor('admin'), 'd2'), 'Salaries [confidential]\n\nNumbers.');
  }],
  ['an archived document may still be taken away by those who may take one away', () => {
    const store = createStore();
    assert.strictEqual(exportDocument(store, actor('curator'), 'd4'), 'Retired policy [archived]\n\nOld.');
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
