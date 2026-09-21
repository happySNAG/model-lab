'use strict';

// A plain Node script so the fixture needs no install, no package manager and no network.
// Exits 0 when everything holds, 1 otherwise, with one line per check on stdout.

const assert = require('node:assert');
const { describeRules } = require('../src/explain.js');

const checks = [
  ['every rule is described, in the order the rules run', () => {
    assert.deepStrictEqual(describeRules(), [
      'name-format  service name (name)  NAME_FORMAT',
      'replica-count  replica count (replicas)  REPLICA_COUNT',
      'port-range  listening port (port)  PORT_RANGE',
      'image-tag  container image (image)  IMAGE_TAG',
      'env-names  environment (env)  ENV_NAME',
      'limits-present  resource limits (limits)  LIMITS',
    ]);
  }],
  ['the description and the registry cannot disagree about what runs', () => {
    const { listRules } = require('../src/rules/index.js');
    assert.deepStrictEqual(describeRules().map((line) => line.split('  ')[0]), listRules(),
      'both are the same list, read from the one place docs/ARCHITECTURE.md puts it');
  }],
  ['every described rule says which field it is about and which code it carries', () => {
    const { RULES } = require('../src/rules/index.js');
    const { labelFor } = require('../src/schema.js');
    assert.deepStrictEqual(describeRules().map((line) => line.split('  ').slice(1)),
      RULES.map((rule) => [`${labelFor(rule.appliesTo)} (${rule.appliesTo})`, rule.code]));
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
