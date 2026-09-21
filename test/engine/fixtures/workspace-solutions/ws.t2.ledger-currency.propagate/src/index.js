'use strict';

const { defaultCurrency } = require('./config.js');
const { CURRENCIES, SYMBOLS, isCurrency, formatMoney } = require('./money.js');
const { createEntry, relabelEntry } = require('./entry.js');
const { createJournal, addEntry, totalOf, entriesOf } = require('./journal.js');
const { renderEntry, renderJournal } = require('./report.js');
const { toWire, fromWire, journalToWire, journalFromWire } = require('./wire.js');

/**
 * The public API. A consumer of this package never reaches past this file into `src/`.
 *
 * `docs/API.md` states what this surface promises about amounts.
 */
module.exports = {
  CURRENCIES,
  SYMBOLS,
  isCurrency,
  formatMoney,
  defaultCurrency,
  createEntry,
  relabelEntry,
  createJournal,
  addEntry,
  totalOf,
  entriesOf,
  renderEntry,
  renderJournal,
  toWire,
  fromWire,
  journalToWire,
  journalFromWire,
};
