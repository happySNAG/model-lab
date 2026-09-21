'use strict';

const { foldForComparison } = require('./unicode.js');

/**
 * Whether a query matches a piece of text.
 *
 * Both sides are folded, so a query typed without accents finds a name written with them and the
 * other way round.
 */
function matches(haystack, needle) {
  const query = foldForComparison(needle).trim();
  if (query.length === 0) return false;
  return foldForComparison(haystack).includes(query);
}

/** Every candidate the query matches, in the order they were given. */
function filterMatching(candidates, needle) {
  return candidates.filter((candidate) => matches(candidate, needle));
}

module.exports = { matches, filterMatching };
