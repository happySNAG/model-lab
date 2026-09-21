# t2-ledger-currency

A deliberately small repository used by Cernum's workspace-backed benchmark cases. It is plain
CommonJS run by `node` directly — no package manager, no dependencies, no network — so an attempt
against it measures the model rather than whether an install succeeded.

## What is here

    src/money.js      the money primitive. Which currencies exist, what they are written as, and how
                      a number of cents becomes the string a person reads. Complete; nothing above
                      it uses it yet.
    src/config.js     the package's settings, including the currency a caller gets when it names none.
    src/entry.js      the core model. `createEntry` validates and builds one line of a journal.
    src/journal.js    a collection of entries, and the arithmetic over them.
    src/wire.js       the storage adapter. `docs/FORMAT.md` is the contract for its keys.
    src/report.js     the rendering a person reads.
    src/index.js      the public API. Everything a consumer of this package may import.
    test/             the suite. One file per layer.

## The rule this repository is built around

Money is a number **and** a currency, and the two are never separated. A journal that mixes
currencies has no total, and saying so is part of the contract rather than an error case nobody
thought about — see `docs/API.md`. A record written before this package knew about currencies is
still a valid record; `docs/FORMAT.md` says what reading one must give you.

Nothing here is ever executed in place. Every attempt gets a copy; see `docs/ENGINE.md` in Cernum.
