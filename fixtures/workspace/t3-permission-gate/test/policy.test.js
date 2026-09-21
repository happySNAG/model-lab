'use strict';

// A plain Node script so the fixture needs no install, no package manager and no network.
// Exits 0 when everything holds, 1 otherwise, with one line per check on stdout.
//
// `docs/ARCHITECTURE.md` names the module these checks require and the two things it exports.

const assert = require('node:assert');
const { createActor } = require('../src/model/actor.js');
const { createStore, fetch } = require('../src/store/index.js');
const { ForbiddenError, UnknownActionError } = require('../src/errors.js');

const actor = (role) => createActor({ id: `u-${role}`, role });

const checks = [
  ['the boundary is where the architecture says it is', () => {
    const policy = require('../src/authz/policy.js');
    assert.strictEqual(typeof policy.authorize, 'function');
    assert.deepStrictEqual(policy.ACTIONS, ['read', 'update', 'delete', 'export', 'archive']);
  }],
  ['a decision is an answer or an exception, never a value to inspect', () => {
    const { authorize } = require('../src/authz/policy.js');
    const store = createStore();
    assert.strictEqual(authorize(actor('admin'), 'delete', fetch(store, 'd1')), undefined);
    assert.throws(() => authorize(actor('reader'), 'delete', fetch(store, 'd1')), ForbiddenError);
  }],
  ['an action this service does not have is not guessed at', () => {
    const { authorize } = require('../src/authz/policy.js');
    const store = createStore();
    assert.throws(() => authorize(actor('admin'), 'publish', fetch(store, 'd1')), UnknownActionError);
    assert.throws(() => authorize(actor('reader'), 'publish', fetch(store, 'd1')), UnknownActionError);
  }],
  ['confidentiality narrows and never widens', () => {
    const { authorize } = require('../src/authz/policy.js');
    const store = createStore();
    assert.throws(() => authorize(actor('writer'), 'read', fetch(store, 'd2')), ForbiddenError);
    assert.strictEqual(authorize(actor('writer'), 'read', fetch(store, 'd1')), undefined);
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
