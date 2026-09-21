# t3-import-pipeline

A deliberately small repository used by Cernum's workspace-backed benchmark cases. It is plain
CommonJS run by `node` directly — no package manager, no dependencies, no network — so an attempt
against it measures the model rather than whether an install succeeded.

There is no wall clock and no randomness anywhere in this package: the same text imported twice
gives the same records and the same report.

## What is here

    src/csv.js           text to rows. Quoting, escaping, blank lines.
    src/types.js         the record types this importer knows, and what identifies a record of each.
    src/stages/parse.js      rows with a header applied.
    src/stages/coerce.js     rows as typed records.
    src/stages/validate.js   records that are fit to import, and the ones that are not.
    src/stages/dedupe.js     one record per thing, out of however many rows mentioned it.
    src/stages/collect.js    the records and the report, together.
    src/pipeline.js      the stages, in order.
    src/report.js        the import report a person reads.
    src/index.js         the public API.
    test/               the suite.

## What is wrong with it

Four of the six suites fail. The importer drops rows without saying why, and it decides that two
rows are the same thing by looking at a column called `id` rather than at what actually identifies a
record of that type.

`docs/PIPELINE.md` is the contract: what identifies a record, what happens when several rows are the
same record, and what the report says.

Nothing here is ever executed in place. Every attempt gets a copy; see `docs/ENGINE.md` in Cernum.
