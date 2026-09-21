'use strict';

// A plain Node script so the fixture needs no install, no package manager and no network.
// Exits 0 when everything holds, 1 otherwise, with one line per check on stdout.

const assert = require('node:assert');
const { createActor } = require('../src/model/actor.js');
const { createStore, all } = require('../src/store/index.js');
const { deleteDocument } = require('../src/handlers/delete.js');
const { ForbiddenError, ConflictError, NotFoundError } = require('../src/errors.js');

const actor = (role) => createActor({ id: `u-${role}`, role });

const checks = [
  ['a curator may remove a document', () => {
    const store = createStore();
    deleteDocument(store, actor('curator'), 'd5');
    assert.strictEqual(all(store).length, 4);
  }],
  ['a reader and a writer may not', () => {
    const store = createStore();
    assert.throws(() => deleteDocument(store, actor('reader'), 'd5'), ForbiddenError);
    assert.throws(() => deleteDocument(store, actor('writer'), 'd5'), ForbiddenError);
    assert.strictEqual(all(store).length, 5);
  }],
  ['nobody may remove an archived document', () => {
    const store = createStore();
    assert.throws(() => deleteDocument(store, actor('admin'), 'd4'), ConflictError);
  }],
  ['a document that is not there is not a permission question', () => {
    const store = createStore();
    assert.throws(() => deleteDocument(store, actor('admin'), 'nope'), NotFoundError);
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
