'use strict';

const { createEntry } = require('./entry.js');
const { defaultCurrency } = require('./config.js');

/**
 * The storage adapter.
 *
 * `docs/FORMAT.md` is the contract for these keys: they are short, they are fixed, and a record
 * written by an older build must keep loading.
 */
function toWire(entry) {
  return { i: entry.id, d: entry.description, a: entry.amountCents, c: entry.currency };
}

/**
 * Read a record back.
 *
 * Goes through `createEntry` rather than building an object literal, so the core model stays the
 * one place an entry's shape is decided.
 */
function fromWire(record) {
  return createEntry({
    id: record.i,
    description: record.d,
    amountCents: record.a,
    currency: record.c === undefined ? defaultCurrency() : record.c,
  });
}

/** A whole journal, as it is written and read. */
function journalToWire(journal) {
  return { l: journal.label, e: journal.entries.map(toWire) };
}

function journalFromWire(record) {
  return { label: record.l, entries: (record.e || []).map(fromWire) };
}

module.exports = { toWire, fromWire, journalToWire, journalFromWire };
