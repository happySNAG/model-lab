'use strict';

// A plain Node script so the fixture needs no install, no package manager and no network.
// Exits 0 when everything holds, 1 otherwise, with one line per check on stdout.

const assert = require('node:assert');
const { upgrade } = require('../src/upgrade.js');

const checks = [
  ['the result is a version 2 configuration', () => {
    assert.strictEqual(upgrade({ name: 'svc' }).config.version, 2);
  }],
  ['name and region come across unchanged', () => {
    const { config } = upgrade({ name: 'svc', region: 'eu-west' });
    assert.strictEqual(config.name, 'svc');
    assert.strictEqual(config.region, 'eu-west');
  }],
  ['a timeout becomes a whole number of seconds', () => {
    assert.strictEqual(upgrade({ name: 'svc', timeout: 30 }).config.timeoutSeconds, 30);
    assert.strictEqual(upgrade({ name: 'svc', timeout: '2m' }).config.timeoutSeconds, 120);
  }],
  ['colour is spelled as a word', () => {
    assert.strictEqual(upgrade({ name: 'svc', color: true }).config.color, 'always');
    assert.strictEqual(upgrade({ name: 'svc', color: false }).config.color, 'never');
    assert.strictEqual(upgrade({ name: 'svc', color: 'auto' }).config.color, 'auto');
  }],
  ['the blue-green strategy is renamed and the others are not', () => {
    const renamed = upgrade({ name: 'svc', deploy: { strategy: 'blue-green', maxSurge: 2 } }).config.deploy;
    assert.strictEqual(renamed.strategy, 'blueGreen');
    assert.strictEqual(renamed.maxSurge, 2);
    assert.strictEqual(upgrade({ name: 'svc', deploy: { strategy: 'recreate' } }).config.deploy.strategy, 'recreate');
  }],
  ['a slack channel becomes a notification channel', () => {
    const { config } = upgrade({ name: 'svc', notify: { slack: '#deploys' } });
    assert.deepStrictEqual(config.notify.channels, [{ kind: 'slack', target: '#deploys' }]);
  }],
  ['a well-formed file produces no warnings', () => {
    const { warnings } = upgrade({ name: 'svc', timeout: '90s', color: false, deploy: { strategy: 'rolling' } });
    assert.deepStrictEqual(warnings, []);
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
