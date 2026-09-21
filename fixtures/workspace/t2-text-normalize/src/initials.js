'use strict';

const { foldDiacritics } = require('./unicode.js');

/**
 * A person's initials.
 *
 * One letter per name part, folded, uppercased, in order. `Ada Lovelace` gives `AL`.
 */
function initialsOf(fullName) {
  return foldDiacritics(fullName)
    .split(/\s+/)
    .filter((part) => part.length > 0)
    .map((part) => part[0].toUpperCase())
    .join('');
}

module.exports = { initialsOf };
