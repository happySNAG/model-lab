'use strict';

// A plain Node script so the fixture needs no install, no package manager and no network.
// Exits 0 when everything holds, 1 otherwise, with one line per check on stdout.

const assert = require('node:assert');
const { buildURL, parseURL } = require('../src/url.js');
const { route } = require('../src/router.js');

const checks = [
  ['a URL without parameters has no question mark', () => {
    assert.strictEqual(buildURL('/issues'), '/issues');
  }],
  ['a URL comes apart into its path and parameters, fragment ignored', () => {
    assert.deepStrictEqual(parseURL('/issues?page=2#top'), { path: '/issues', parameters: { page: '2' } });
  }],
  ['an issue page reads its tab', () => {
    assert.deepStrictEqual(route('/issues/42?tab=files'), { id: '42', tab: 'files' });
  }],
  ['the listing reads its filter', () => {
    assert.deepStrictEqual(route('/issues?filter[status]=open&filter[labels][]=bug&filter[labels][]=ui'),
      { page: 1, status: 'open', labels: ['bug', 'ui'], assignee: null });
  }],
  ['an unknown path matches nothing', () => {
    assert.strictEqual(route('/nowhere'), null);
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
