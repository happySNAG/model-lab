# receipt-refunds

A deliberately tiny repository used by Cernum's workspace-backed benchmark cases. It is plain
CommonJS run by `node` directly — no package manager, no dependencies, no network — so an attempt
against it measures the model rather than whether an install succeeded.

## What is here

    src/parse.js    reads one line of a receipt file into a record. The only place a line of text
                    becomes a number.
    src/report.js   sums records and renders the report a person reads. It does arithmetic on
                    records; it never looks at the original text.
    test/           the suite.

## The receipt format

One entry per line, `name: $amount`. An amount may be negative, which is how a refund is written:

    Coffee: $4.25
    Book: $12.50
    Refund: -$5.00

Amounts are held as whole cents everywhere inside this package. Nothing downstream of `parse.js`
re-reads the original text, so whatever the parser makes of a line is what the rest of the package
believes about it.

Nothing here is ever executed in place. Every attempt gets a copy; see `docs/ENGINE.md` in Cernum.
