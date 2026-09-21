'use strict';

// A plain Node script so the fixture needs no install, no package manager and no network.
// Exits 0 when everything holds, 1 otherwise, with one line per check on stdout.

const assert = require('node:assert');
const { createActor } = require('../src/model/actor.js');
const { createStore, fetch } = require('../src/store/index.js');
const { updateDocument } = require('../src/handlers/update.js');
const { ForbiddenError, ConflictError } = require('../src/errors.js');

const actor = (role) => createActor({ id: `u-${role}`, role });

const checks = [
  ['a writer may change an unlocked document', () => {
    const store = createStore();
    updateDocument(store, actor('writer'), 'd1', { title: 'Onboarding v2' });
    assert.strictEqual(fetch(store, 'd1').title, 'Onboarding v2');
  }],
  ['a reader may not change anything', () => {
    const store = createStore();
    assert.throws(() => updateDocument(store, actor('reader'), 'd1', { title: 'x' }), ForbiddenError);
  }],
  ['a writer may not change a locked document, and a curator may', () => {
    const store = createStore();
    assert.throws(() => updateDocument(store, actor('writer'), 'd3', { title: 'x' }), ForbiddenError);
    updateDocument(store, actor('curator'), 'd3', { title: 'Release checklist v2' });
    assert.strictEqual(fetch(store, 'd3').title, 'Release checklist v2');
  }],
  ['nobody may change an archived document', () => {
    const store = createStore();
    assert.throws(() => updateDocument(store, actor('curator'), 'd4', { title: 'x' }), ConflictError);
    assert.throws(() => updateDocument(store, actor('admin'), 'd4', { title: 'x' }), ConflictError);
  }],
  ['a caller who may not update is refused before the document is looked at', () => {
    const store = createStore();
    assert.throws(() => updateDocument(store, actor('reader'), 'd4', { title: 'x' }), ForbiddenError);
  }],
  ['only the title and the body may be changed', () => {
    const store = createStore();
    updateDocument(store, actor('admin'), 'd1', { title: 'Renamed', confidential: true, id: 'other' });
    const document = fetch(store, 'd1');
    assert.strictEqual(document.title, 'Renamed');
    assert.strictEqual(document.confidential, false);
    assert.strictEqual(document.id, 'd1');
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
