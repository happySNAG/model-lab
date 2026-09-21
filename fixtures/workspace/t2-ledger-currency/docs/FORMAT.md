# The wire format

An entry is stored as a JSON object with short, fixed keys. The keys are part of the format and are
never renamed: files written by an older build must keep loading.

    i   string   the entry id
    d   string   the description
    a   number   the amount, in whole cents, signed
    c   string   the currency code

## Reading an old record

`c` was added after the first records were written, so a record that carries no `c` is a valid
record and not a corrupt one. `fromWire` must read it as the package's default currency — the same
value `createEntry` uses when a caller names none — rather than leaving the field missing or
undefined. Writing that entry back out produces a record that does carry `c`.

Every key a record does carry is read as written; `fromWire` never guesses a value that is present.
