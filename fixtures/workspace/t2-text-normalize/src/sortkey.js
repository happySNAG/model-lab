'use strict';

const { foldForComparison } = require('./unicode.js');

/**
 * The key a name is filed under.
 *
 * Folded and lowercased, so a name sorts where a reader expects to find it rather than wherever its
 * code points happen to fall.
 */
function sortKey(text) {
  return foldForComparison(text);
}

/** Names in filing order. Ties keep the order they were given in. */
function sortByName(names) {
  return names
    .map((name, index) => ({ name, index, key: sortKey(name) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.index - b.index))
    .map((entry) => entry.name);
}

module.exports = { sortKey, sortByName };
