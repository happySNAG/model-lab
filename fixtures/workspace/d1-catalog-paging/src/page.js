'use strict';

const { all } = require('./store.js');
const { compareProducts } = require('./order.js');
const { encodeCursor, decodeCursor, InvalidCursorError } = require('./cursor.js');
const { everything } = require('./filters.js');

/**
 * One page of the listing: `{ items, next }`. docs/PAGING.md says what a cursor promises.
 */
function listPage(store, { limit = 10, after = null, filter = everything } = {}) {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError('a page holds at least one product');
  const listed = all(store).filter(filter).sort(compareProducts);
  let start = 0;
  if (after !== null) {
    const position = decodeCursor(after);
    if (!Number.isInteger(position.offset) || position.offset < 0) {
      throw new InvalidCursorError('this is not a cursor this catalogue issued');
    }
    start = position.offset;
  }
  const items = listed.slice(start, start + limit);
  const more = start + items.length < listed.length;
  return { items, next: more ? encodeCursor({ offset: start + items.length }) : null };
}

module.exports = { listPage };
