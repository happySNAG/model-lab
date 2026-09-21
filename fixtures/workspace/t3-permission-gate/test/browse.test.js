'use strict';

// A plain Node script so the fixture needs no install, no package manager and no network.
// Exits 0 when everything holds, 1 otherwise, with one line per check on stdout.

const assert = require('node:assert');
const { createStore, all } = require('../src/store/index.js');
const { searchByTitle, sortedByTitle, titleMatches } = require('../src/search.js');
const { pageOf, describePage } = require('../src/pagination.js');
const { renderDocument, summarizeDocument } = require('../src/render.js');

const checks = [
  ['searching by title finds what it should', () => {
    const documents = all(createStore());
    assert.deepStrictEqual(searchByTitle(documents, 'release').map((d) => d.id), ['d3']);
    assert.deepStrictEqual(searchByTitle(documents, '   ').map((d) => d.id), []);
    assert.strictEqual(titleMatches(documents[0], 'ONBOARD'), true);
  }],
  ['sorting by title is stable and case-insensitive', () => {
    const documents = all(createStore());
    assert.deepStrictEqual(sortedByTitle(documents).map((d) => d.id), ['d1', 'd3', 'd4', 'd5', 'd2']);
  }],
  ['a page is a slice and a place in the list', () => {
    const documents = all(createStore());
    const page = pageOf(documents, 2, 2);
    assert.deepStrictEqual(page.items.map((d) => d.id), ['d3', 'd4']);
    assert.strictEqual(page.pageCount, 3);
    assert.strictEqual(describePage(page), 'page 2 of 3 (2 of 5)');
  }],
  ['rendering says what is true about a document', () => {
    const documents = all(createStore());
    assert.strictEqual(renderDocument(documents[1]), 'Salaries [confidential]\n\nNumbers.');
    assert.strictEqual(summarizeDocument(documents[0]), 'd1  Onboarding');
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
