'use strict';

// A plain Node script so the fixture needs no install, no package manager and no network.
// Exits 0 when everything holds, 1 otherwise, with one line per check on stdout.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig } = require('../src/load.js');

const example = (name) => fs.readFileSync(path.join(__dirname, '..', 'examples', name), 'utf8');

const checks = [
  ['a basic version 1 file loads as version 2', () => {
    const { config } = loadConfig(example('v1-basic.json'));
    assert.strictEqual(config.version, 2);
    assert.strictEqual(config.name, 'billing-api');
    assert.strictEqual(config.timeoutSeconds, 90);
    assert.strictEqual(config.color, 'always');
    assert.strictEqual(config.deploy.strategy, 'rolling');
  }],
  ['a file that announces its deploys loads with its channel and its strategy', () => {
    const { config } = loadConfig(example('v1-announced.json'));
    assert.strictEqual(config.timeoutSeconds, 120);
    assert.strictEqual(config.color, 'auto');
    assert.strictEqual(config.deploy.strategy, 'blueGreen');
    assert.deepStrictEqual(config.notify.channels, [{ kind: 'slack', target: '#search-deploys' }]);
  }],
  ['a version 2 file is used as it is', () => {
    const text = JSON.stringify({ version: 2, name: 'svc', timeoutSeconds: 5 });
    assert.deepStrictEqual(loadConfig(text), { config: { version: 2, name: 'svc', timeoutSeconds: 5 }, warnings: [] });
  }],
  ['a file that is not JSON is refused with a reason', () => {
    assert.throws(() => loadConfig('{ name: svc'), /not valid JSON/);
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
