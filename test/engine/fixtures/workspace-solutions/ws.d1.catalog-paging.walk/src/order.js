'use strict';

/**
 * The listing order: negative when `a` is listed before `b`. See docs/PAGING.md.
 *
 * Total: rank, highest first, then id. It is also the order a cursor resumes in, so it is compared
 * against a cursor's position as well as against products.
 */
function compareProducts(a, b) {
  if (a.rank !== b.rank) return b.rank - a.rank;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

module.exports = { compareProducts };
