'use strict';

// A plain Node script so the fixture needs no install, no package manager and no network.
// Exits 0 when everything holds, 1 otherwise, with one line per check on stdout.

const assert = require('node:assert');
const { createActor } = require('../src/model/actor.js');
const { createStore } = require('../src/store/index.js');
const { readDocument } = require('../src/handlers/read.js');
const { ForbiddenError } = require('../src/errors.js');

const actor = (role) => createActor({ id: `u-${role}`, role });

const checks = [
  ['every role this service has may read an ordinary document', () => {
    const store = createStore();
    for (const role of ['reader', 'writer', 'curator', 'admin']) {
      assert.strictEqual(readDocument(store, actor(role), 'd1').title, 'Onboarding');
    }
  }],
  ['a confidential document is not readable by a reader or a writer', () => {
    const store = createStore();
    assert.throws(() => readDocument(store, actor('reader'), 'd2'), ForbiddenError);
    assert.throws(() => readDocument(store, actor('writer'), 'd2'), ForbiddenError);
    assert.strictEqual(readDocument(store, actor('curator'), 'd2').title, 'Salaries');
    assert.strictEqual(readDocument(store, actor('admin'), 'd2').title, 'Salaries');
  }],
  ['an archived document is still readable', () => {
    const store = createStore();
    assert.strictEqual(readDocument(store, actor('reader'), 'd4').title, 'Retired policy');
  }],
  ['a role this service does not have may do nothing', () => {
    const store = createStore();
    assert.throws(() => readDocument(store, actor('guest'), 'd1'), ForbiddenError);
  }],
  ['a refusal says what was refused, to whom, and about what', () => {
    const store = createStore();
    try {
      readDocument(store, actor('reader'), 'd2');
      assert.fail('should have refused');
    } catch (error) {
      assert.strictEqual(error.name, 'ForbiddenError');
      assert.strictEqual(error.action, 'read');
      assert.strictEqual(error.role, 'reader');
      assert.strictEqual(error.documentID, 'd2');
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
