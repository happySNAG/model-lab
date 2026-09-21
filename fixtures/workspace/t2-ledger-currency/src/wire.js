'use strict';

const { createEntry } = require('./entry.js');

/**
 * The storage adapter.
 *
 * `docs/FORMAT.md` is the contract for these keys: they are short, they are fixed, and a record
 * written by an older build must keep loading.
 */
function toWire(entry) {
  return { i: entry.id, d: entry.description, a: entry.amountCents };
}

/**
 * Read a record back.
 *
 * Goes through `createEntry` rather than building an object literal, so the core model stays the
 * one place an entry's shape is decided.
 */
function fromWire(record) {
  return createEntry({ id: record.i, description: record.d, amountCents: record.a });
}

/** A whole journal, as it is written and read. */
function journalToWire(journal) {
  return { l: journal.label, e: journal.entries.map(toWire) };
}

function journalFromWire(record) {
  return { label: record.l, entries: (record.e || []).map(fromWire) };
}

module.exports = { toWire, fromWire, journalToWire, journalFromWire };
