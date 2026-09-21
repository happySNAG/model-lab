'use strict';

/**
 * The listing order: negative when `a` is listed before `b`. See docs/PAGING.md.
 */
function compareProducts(a, b) {
  return b.rank - a.rank;
}

module.exports = { compareProducts };
