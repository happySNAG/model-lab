'use strict';

const { all } = require('./store.js');
const { compareProducts } = require('./order.js');
const { encodeCursor, decodeCursor } = require('./cursor.js');
const { everything } = require('./filters.js');

/**
 * One page of the listing: `{ items, next }`. docs/PAGING.md says what a cursor promises.
 *
 * A cursor is the sort key of the last product on the previous page, and the page after it is the
 * products that sort after that key — whether or not that product is still in the catalogue.
 */
function listPage(store, { limit = 10, after = null, filter = everything } = {}) {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError('a page holds at least one product');
  let listed = all(store).filter(filter).sort(compareProducts);
  if (after !== null) {
    const place = decodeCursor(after);
    listed = listed.filter((product) => compareProducts(product, place) > 0);
  }
  const items = listed.slice(0, limit);
  const more = listed.length > items.length;
  return { items, next: more ? encodeCursor(items[items.length - 1]) : null };
}

module.exports = { listPage };
