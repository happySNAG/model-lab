'use strict';

// A plain Node script so the fixture needs no install, no package manager and no network.
// Exits 0 when everything holds, 1 otherwise, with one line per check on stdout.
//
// One check per rule in docs/RULES.md, each against a configuration that breaks that rule and
// nothing else. These say what this package promises a caller, and none of it is changing.

const assert = require('node:assert');
const { validate } = require('../src/validate.js');
const { withDefaults } = require('../src/defaults.js');

const breaking = (changes) => withDefaults(changes);
const only = (changes) => validate(breaking(changes));

const checks = [
  ['name-format', () => {
    assert.deepStrictEqual(only({ name: 'Bad Name' }), [{
      rule: 'name-format', code: 'NAME_FORMAT', path: 'name',
      message: 'name must be 1-40 characters of lowercase letters, digits and hyphens',
    }]);
    assert.deepStrictEqual(only({ name: '9lives' }).map((e) => e.code), ['NAME_FORMAT']);
    assert.deepStrictEqual(only({ name: 'a-b-c9' }), []);
  }],
  ['replica-count', () => {
    assert.deepStrictEqual(only({ replicas: 0 }), [{
      rule: 'replica-count', code: 'REPLICA_COUNT', path: 'replicas',
      message: 'replicas must be a whole number from 1 to 20',
    }]);
    assert.deepStrictEqual(only({ replicas: 21 }).map((e) => e.code), ['REPLICA_COUNT']);
    assert.deepStrictEqual(only({ replicas: 2.5 }).map((e) => e.code), ['REPLICA_COUNT']);
    assert.deepStrictEqual(only({ replicas: 20 }), []);
  }],
  ['port-range', () => {
    assert.deepStrictEqual(only({ port: 80 }), [{
      rule: 'port-range', code: 'PORT_RANGE', path: 'port',
      message: 'port must be a whole number from 1024 to 65535',
    }]);
    assert.deepStrictEqual(only({ port: 65536 }).map((e) => e.code), ['PORT_RANGE']);
    assert.deepStrictEqual(only({ port: 1024 }), []);
  }],
  ['image-tag', () => {
    assert.deepStrictEqual(only({ image: 'registry.example/service' }), [{
      rule: 'image-tag', code: 'IMAGE_TAG', path: 'image',
      message: 'image must name an explicit tag other than latest',
    }]);
    assert.deepStrictEqual(only({ image: 'registry.example/service:latest' }).map((e) => e.code), ['IMAGE_TAG']);
    assert.deepStrictEqual(only({ image: 'registry.example:5000/service' }).map((e) => e.code), ['IMAGE_TAG']);
    assert.deepStrictEqual(only({ image: 'registry.example:5000/service:2.0' }), []);
  }],
  ['env-names', () => {
    assert.deepStrictEqual(only({ env: { myVar: '1' } }), [{
      rule: 'env-names', code: 'ENV_NAME', path: 'env.myVar',
      message: 'environment variable names must be upper-case letters, digits and underscores',
    }]);
    assert.deepStrictEqual(only({ env: { A: '1', b: '2', C_1: '3', 'd-e': '4' } }).map((e) => e.path),
      ['env.b', 'env.d-e']);
    assert.deepStrictEqual(only({ env: { OK_1: 'x' } }), []);
  }],
  ['limits-present', () => {
    assert.deepStrictEqual(only({ limits: { cpuMilli: 250, memoryMiB: 32 } }), [{
      rule: 'limits-present', code: 'LIMITS', path: 'limits',
      message: 'cpu and memory limits are required, and memory must be at least 64 MiB',
    }]);
    assert.deepStrictEqual(only({ limits: { cpuMilli: 0, memoryMiB: 128 } }).map((e) => e.code), ['LIMITS']);
    assert.deepStrictEqual(only({ limits: { cpuMilli: 250, memoryMiB: 64 } }), []);
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
