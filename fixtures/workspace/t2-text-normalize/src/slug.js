'use strict';

const { foldDiacritics } = require('./unicode.js');

/** Everything that is not a letter or a digit, once folding has done its work. */
const NOT_WORD = /[^a-zA-Z0-9]+/g;

/**
 * A URL slug.
 *
 * Folds first — `src/unicode.js` is where this package decides what a letter becomes — then
 * lowercases, then joins what is left with hyphens.
 */
function slugify(text) {
  return foldDiacritics(text)
    .replace(NOT_WORD, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

module.exports = { slugify };
