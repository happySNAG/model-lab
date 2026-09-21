'use strict';

// A plain Node script so the fixture needs no install, no package manager and no network.
// Exits 0 when everything holds, 1 otherwise, with one line per check on stdout.
//
// `docs/ARCHITECTURE.md` names the module these checks require and the two things it exports.

const assert = require('node:assert');

const IDS = ['name-format', 'replica-count', 'port-range', 'image-tag', 'env-names', 'limits-present'];

const checks = [
  ['the registry exists where the architecture says it does', () => {
    const registry = require('../src/rules/index.js');
    assert.strictEqual(Array.isArray(registry.RULES), true);
    assert.strictEqual(typeof registry.listRules, 'function');
  }],
  ['the registry holds the six rules in the order docs/RULES.md lists them', () => {
    const { RULES, listRules } = require('../src/rules/index.js');
    assert.deepStrictEqual(listRules(), IDS);
    assert.deepStrictEqual(RULES.map((rule) => rule.id), IDS);
  }],
  ['every rule says what it is and what it is about', () => {
    const { RULES } = require('../src/rules/index.js');
    for (const rule of RULES) {
      assert.strictEqual(typeof rule.id, 'string', 'a rule has an id');
      assert.strictEqual(typeof rule.code, 'string', `${rule.id} says which code its errors carry`);
      assert.strictEqual(typeof rule.appliesTo, 'string', `${rule.id} says which field it is about`);
      assert.strictEqual(typeof rule.check, 'function', `${rule.id} can be asked`);
    }
  }],
  ['a rule answers with a list of errors and nothing else', () => {
    const { RULES } = require('../src/rules/index.js');
    const valid = require('../src/defaults.js').DEFAULT_CONFIGURATION;
    for (const rule of RULES) {
      assert.deepStrictEqual(rule.check(valid), [], `${rule.id} is satisfied by the default configuration`);
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
