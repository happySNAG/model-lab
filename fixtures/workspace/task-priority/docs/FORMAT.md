# The wire format

A task is stored as a JSON object with short, fixed keys. The keys are part of the format and are
never renamed: files written by an older build must keep loading.

    i   string   the task id
    t   string   the title
    d   boolean  whether the task is done
    p   string   the priority: "low", "normal" or "high"

## Reading an old record

`p` was added after the first records were written, so a record that carries no `p` is a valid
record and not a corrupt one. `fromWire` must read it as the default priority — the same value
`createTask` uses when a caller names none — rather than leaving the field missing or undefined.

Every key a record does carry is read as written; `fromWire` never guesses a value that is present.
