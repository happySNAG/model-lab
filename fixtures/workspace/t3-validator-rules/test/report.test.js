'use strict';

// A plain Node script so the fixture needs no install, no package manager and no network.
// Exits 0 when everything holds, 1 otherwise, with one line per check on stdout.

const assert = require('node:assert');
const { validate } = require('../src/validate.js');
const { renderError, renderErrors, countByCode } = require('../src/report.js');
const { labelFor, FIELDS } = require('../src/schema.js');
const { withDefaults, DEFAULT_CONFIGURATION } = require('../src/defaults.js');

const checks = [
  ['an error is written as a line a person reads', () => {
    const [error] = validate(withDefaults({ port: 80 }));
    assert.strictEqual(renderError(error),
      'PORT_RANGE  listening port (port): port must be a whole number from 1024 to 65535');
  }],
  ['an error about one of several items keeps the item in its path', () => {
    const [error] = validate(withDefaults({ env: { myVar: '1' } }));
    assert.strictEqual(renderError(error),
      'ENV_NAME  environment (env.myVar): environment variable names must be upper-case letters, '
      + 'digits and underscores');
  }],
  ['nothing wrong is said as a sentence', () => {
    assert.strictEqual(renderErrors(validate(DEFAULT_CONFIGURATION)), 'the configuration is valid');
  }],
  ['errors are counted by code', () => {
    const errors = validate(withDefaults({ env: { a: '1', b: '2' }, port: 80 }));
    assert.deepStrictEqual(countByCode(errors), { PORT_RANGE: 1, ENV_NAME: 2 });
  }],
  ['every field has a label', () => {
    for (const field of FIELDS) assert.strictEqual(labelFor(field.path), field.label);
    assert.strictEqual(labelFor('nothing'), 'nothing');
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
