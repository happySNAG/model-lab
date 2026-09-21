'use strict';

// A plain Node script so the fixture needs no install, no package manager and no network.
// Exits 0 when everything holds, 1 otherwise, with one line per check on stdout.

const assert = require('node:assert');
const { encodeQuery, decodeQuery } = require('../src/query.js');

const checks = [
  ['flat parameters are written and read as they always were', () => {
    assert.strictEqual(encodeQuery({ page: '2', sort: 'updated' }), 'page=2&sort=updated');
    assert.deepStrictEqual(decodeQuery('page=2&sort=updated'), { page: '2', sort: 'updated' });
    assert.deepStrictEqual(decodeQuery('?q=two+words&flag'), { q: 'two words', flag: '' });
  }],
  ['a nested object is written with brackets', () => {
    assert.strictEqual(encodeQuery({ filter: { status: 'open', assignee: 'ada' } }),
      'filter[status]=open&filter[assignee]=ada');
  }],
  ['an array is written with empty brackets, one pair per element', () => {
    assert.strictEqual(encodeQuery({ filter: { labels: ['bug', 'ui'] } }),
      'filter[labels][]=bug&filter[labels][]=ui');
  }],
  ['keys and values are encoded on their own', () => {
    assert.strictEqual(encodeQuery({ filter: { 'milestone name': 'Q3 & Q4' } }),
      'filter[milestone%20name]=Q3%20%26%20Q4');
  }],
  ['brackets are read back into the same structure', () => {
    assert.deepStrictEqual(decodeQuery('page=3&filter[status]=open&filter[labels][]=bug&filter[labels][]=ui'),
      { page: '3', filter: { status: 'open', labels: ['bug', 'ui'] } });
  }],
  ['what is written reads back the same', () => {
    const parameters = { q: 'crash on save', filter: { status: 'closed', labels: ['p1'], author: { team: 'core' } } };
    assert.deepStrictEqual(decodeQuery(encodeQuery(parameters)), parameters);
  }],
  ['empty arrays and objects write nothing', () => {
    assert.strictEqual(encodeQuery({ page: '1', filter: { labels: [] }, extra: {} }), 'page=1');
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
