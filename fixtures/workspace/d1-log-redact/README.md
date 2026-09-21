# d1-log-redact

A deliberately small repository used by Cernum's workspace-backed benchmark cases. It is plain
CommonJS run by `node` directly — no package manager, no dependencies, no network — so an attempt
against it measures the model rather than whether an install succeeded.

## What this is

Every service writes its logs through this package before they leave the machine. It removes
personal data and credentials from each line and passes everything else on for the people who
debug from these logs. `docs/REDACTION.md` says exactly what is removed and what is left alone.

## What is here

    src/redact.js       one line in, one line out.
    src/fields.js       the field names whose values are personal data.
    src/formats.js      the credential formats this organisation issues.
    src/logfmt.js       reading `key=value` lines.
    src/heuristics.js   recognising values that look machine-generated.
    src/levels.js       log levels, for filtering.
    src/pipeline.js     a block of text, line by line, with an optional minimum level.
    src/index.js        the public API.
    test/               the suite.

Nothing here is ever executed in place. Every attempt gets a copy; see `docs/ENGINE.md` in Cernum.
