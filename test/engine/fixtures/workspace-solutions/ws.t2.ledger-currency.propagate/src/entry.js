'use strict';

const { isCurrency } = require('./money.js');
const { defaultCurrency } = require('./config.js');

/**
 * The core model.
 *
 * THE ONLY CONSTRUCTOR. Nothing else in this package builds an entry object literal, so a field
 * added here is a field every entry has — including the ones `fromWire` reads back off disk.
 */
function createEntry(fields) {
  if (typeof fields.id !== 'string' || fields.id.length === 0) {
    throw new TypeError('an entry needs a non-empty id');
  }
  if (!Number.isInteger(fields.amountCents)) {
    throw new TypeError('an entry amount is a whole number of cents');
  }
  const currency = fields.currency === undefined ? defaultCurrency() : fields.currency;
  if (!isCurrency(currency)) throw new RangeError(`unknown currency: ${currency}`);
  return {
    id: fields.id,
    description: typeof fields.description === 'string' ? fields.description : '',
    amountCents: fields.amountCents,
    currency,
  };
}

/** A copy with a different description. Entries are values here; nothing is mutated in place. */
function relabelEntry(entry, description) {
  return { ...entry, description };
}

module.exports = { createEntry, relabelEntry };
