'use strict';

// A plain Node script so the fixture needs no install, no package manager and no network.
// Exits 0 when everything holds, 1 otherwise, with one line per check on stdout.

const assert = require('node:assert');
const { pageLinks, filterLink } = require('../src/links.js');

const checks = [
  ['paging keeps the other parameters', () => {
    assert.deepStrictEqual(pageLinks('/issues', { sort: 'updated', page: '2' }, 2, 3), {
      previous: '/issues?sort=updated&page=1',
      next: '/issues?sort=updated&page=3',
    });
  }],
  ['the first and last pages have no link past them', () => {
    const links = pageLinks('/issues', {}, 1, 1);
    assert.strictEqual(links.previous, null);
    assert.strictEqual(links.next, null);
  }],
  ['a filter link carries the filter and starts from the first page', () => {
    assert.strictEqual(filterLink('/issues', { sort: 'updated', page: '4' }, { status: 'open', labels: ['bug'] }),
      '/issues?sort=updated&filter[status]=open&filter[labels][]=bug');
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
