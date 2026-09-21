'use strict';

// A plain Node script so the fixture needs no install, no package manager and no network.
// Exits 0 when everything holds, 1 otherwise, with one line per check on stdout.

const assert = require('node:assert');
const { validate, isValid } = require('../src/validate.js');
const { withDefaults, DEFAULT_CONFIGURATION } = require('../src/defaults.js');

const checks = [
  ['a configuration that breaks nothing validates to an empty list', () => {
    assert.deepStrictEqual(validate(DEFAULT_CONFIGURATION), []);
    assert.strictEqual(isValid(DEFAULT_CONFIGURATION), true);
  }],
  ['a configuration that breaks several rules reports each of them', () => {
    const errors = validate(withDefaults({ name: 'Bad', replicas: 0, port: 80 }));
    assert.deepStrictEqual(errors.map((error) => error.code), ['NAME_FORMAT', 'REPLICA_COUNT', 'PORT_RANGE']);
    assert.strictEqual(isValid(withDefaults({ name: 'Bad' })), false);
  }],
  ['a configuration that breaks everything reports all six rules', () => {
    const errors = validate({
      name: 'Bad', replicas: 0, port: 80, image: 'service:latest',
      env: { bad: '1' }, limits: { cpuMilli: 0, memoryMiB: 0 },
    });
    assert.deepStrictEqual(errors.map((error) => error.rule),
      ['name-format', 'replica-count', 'port-range', 'image-tag', 'env-names', 'limits-present']);
  }],
  ['a missing configuration breaks every rule it can', () => {
    const errors = validate(undefined);
    assert.deepStrictEqual(errors.map((error) => error.code),
      ['NAME_FORMAT', 'REPLICA_COUNT', 'PORT_RANGE', 'IMAGE_TAG', 'LIMITS']);
  }],
  ['every error carries the four fields docs/RULES.md names', () => {
    for (const error of validate(undefined)) {
      assert.deepStrictEqual(Object.keys(error), ['rule', 'code', 'path', 'message']);
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
