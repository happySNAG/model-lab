'use strict';

/**
 * The money primitive.
 *
 * COMPLETE, AND USED BY NOTHING ABOVE IT YET. Every currency this package knows, what each one is
 * written as, and how a signed number of whole cents becomes the string a person reads.
 */

/** Every currency code this package accepts. Nothing outside this list is a currency here. */
const CURRENCIES = ['USD', 'EUR', 'GBP'];

/** What each currency is written as. */
const SYMBOLS = { USD: '$', EUR: '€', GBP: '£' };

function isCurrency(code) {
  return typeof code === 'string' && CURRENCIES.includes(code);
}

/**
 * A signed number of whole cents, as a person reads it.
 *
 * The sign goes outside the symbol — `-$4.25`, never `$-4.25` — because that is how a statement is
 * printed everywhere this package's output is read.
 */
function formatMoney(amountCents, currency) {
  if (!Number.isInteger(amountCents)) {
    throw new TypeError(`an amount is a whole number of cents, not ${amountCents}`);
  }
  if (!isCurrency(currency)) throw new RangeError(`unknown currency: ${currency}`);
  const sign = amountCents < 0 ? '-' : '';
  return `${sign}${SYMBOLS[currency]}${(Math.abs(amountCents) / 100).toFixed(2)}`;
}

module.exports = { CURRENCIES, SYMBOLS, isCurrency, formatMoney };
