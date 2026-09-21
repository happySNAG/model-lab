'use strict';

const { listPage } = require('./page.js');

/**
 * Every product in the listing, one page at a time. `between(pageNumber)` runs after each page is
 * fetched and before the next one is, which is where a caller's own work — and the rest of the
 * world's changes to the catalogue — happen.
 */
function walkAll(store, { limit = 10, filter, between } = {}) {
  const seen = [];
  let after = null;
  let pageNumber = 0;
  for (;;) {
    const page = listPage(store, { limit, after, filter });
    seen.push(...page.items);
    pageNumber += 1;
    if (page.next === null) return seen;
    if (between !== undefined) between(pageNumber);
    after = page.next;
  }
}

module.exports = { walkAll };
