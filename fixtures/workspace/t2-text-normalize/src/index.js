'use strict';

const { LETTER_FOLDS, foldDiacritics, foldForComparison } = require('./unicode.js');
const { slugify } = require('./slug.js');
const { matches, filterMatching } = require('./search.js');
const { sortKey, sortByName } = require('./sortkey.js');
const { initialsOf } = require('./initials.js');
const { wrap, wrapped } = require('./wrap.js');
const { escapeHTML } = require('./escape.js');

/** The public API. A consumer of this package never reaches past this file into `src/`. */
module.exports = {
  LETTER_FOLDS,
  foldDiacritics,
  foldForComparison,
  slugify,
  matches,
  filterMatching,
  sortKey,
  sortByName,
  initialsOf,
  wrap,
  wrapped,
  escapeHTML,
};
