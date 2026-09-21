# The import pipeline

    csv text -> parse -> coerce -> validate -> dedupe -> collect -> { records, report }

Each stage takes what the one before it produced. No stage reaches back past the one before it, and
no stage reads the original text again.

## What identifies a record

**Not the `id` column.** An `id` in an import file is whatever the system that exported it happened
to call the row, and two exports of the same thing routinely carry different ones.

Each record type declares its **natural key** — the thing about the record that says which real
thing it is — in `src/types.js`:

    person    the email address, compared without regard to case or surrounding space
    company   the tax id, compared without regard to case or surrounding space

Two rows with the same natural key are two rows about the same thing, whatever their `id` columns
say. Two rows with different natural keys are different things, even if their `id` columns match.

## When several rows are the same record

They become **one** record.

**Later rows win, field by field.** A field the later row gives a value for replaces what the
earlier row said. **A field the later row leaves blank does not**: a blank cell in a later row means
the exporter had nothing to say about that field, not that the field should be emptied. Import files
are assembled from partial exports, and a later partial row must never erase what an earlier
complete row knew.

**The surviving record keeps the place of the first row that mentioned it.** A thing first seen on
line 2 is the second record out of the importer even if it was mentioned again on line 90; the order
of the output is the order the things were first met, not the order they were last touched.

## What the report says

    rowsRead      how many data rows were read, not counting the header
    imported      how many records came out
    dropped       { invalid, duplicate }
    reasons       one sentence per dropped row, in the order the rows were read

`dropped.invalid` counts rows that were not fit to import. `dropped.duplicate` counts rows that were
folded into a record that another row had already started. A row is counted under one heading only,
and `rowsRead` equals `imported + dropped.invalid + dropped.duplicate`.

A row that is not fit to import is dropped **with a reason**: a sentence naming the row's line
number and what was wrong with it. A pipeline that drops rows silently is the thing this document
exists to stop. The sentences, exactly:

    line 7: a person needs an email address
    line 7: a person needs a name
    line 7: the same person as line 2

The first two name the type and the field. The third names the line the surviving record was first
met on. `reasons` carries them in line-number order, whichever stage produced them, and a stage
hands its dropped rows on as `{ record, reason }` rather than as bare records.

## What makes a record fit to import

* it has a natural key, and the natural key is not blank;
* a `person` has a `name`;
* a `company` has a `name`;
* every field the type declares is one this importer knows — an unknown column is not an error, it
  is ignored.
