# The public surface

`src/index.js` is everything a consumer may import. Reaching past it into `src/` is not supported.

## Amounts

Every amount this package hands out or takes in is a whole number of cents together with the
currency it is denominated in. There is no bare-number amount anywhere in the public surface.

## Totalling a journal

`totalOf(journal)` answers with one amount: `{ amountCents, currency }`.

* A journal whose entries are all in one currency totals to that currency.
* **A journal that mixes currencies has no total.** `totalOf` refuses it by throwing a `RangeError`
  rather than answering with a number that means nothing. Summing across currencies is not a
  rounding question; there is no exchange rate in this package and there is not going to be one.
* An **empty** journal totals to zero in the package's default currency. An empty journal is not an
  error and not a mixed one.
