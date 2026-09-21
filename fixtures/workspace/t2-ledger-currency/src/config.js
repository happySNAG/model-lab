'use strict';

/**
 * The package's settings.
 *
 * One object, read through accessors, so a caller never holds the settings object itself and a
 * default can never be changed from outside.
 */
const SETTINGS = {
  defaultCurrency: 'USD',
  maximumEntriesPerJournal: 1000,
};

/** The currency an entry gets when the caller names none. */
function defaultCurrency() {
  return SETTINGS.defaultCurrency;
}

function maximumEntriesPerJournal() {
  return SETTINGS.maximumEntriesPerJournal;
}

module.exports = { defaultCurrency, maximumEntriesPerJournal };
