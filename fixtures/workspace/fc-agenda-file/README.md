# fc-agenda-file

A deliberately small repository used by Cernum's workspace-backed benchmark cases. It is plain
CommonJS run by `node` directly — no package manager, no dependencies, no network — so an attempt
against it measures the model rather than whether an install succeeded.

## What this is

An **agenda** is the file a scheduling tool keeps a team's meetings in: properties, one per line,
grouped into components. `docs/FORMAT.md` is the format, including what a tool that rewrites an
agenda may and may not do to it.

## What is here

    src/lines.js       one property line: its name, its parameters and its value.
    src/components.js  reading and writing the component tree: BEGIN, END and the lines between.
    src/time.js        the timestamps an agenda carries, and arithmetic on them.
    src/decode.js      an agenda, read into a model: its name and its events.
    src/encode.js      a model, written out as a new agenda.
    src/edit.js        changing an existing agenda: when an event is, what it is called, whether it is on.
    src/query.js       what is on a given day, for people and for tests.
    src/errors.js      the one error this package throws.
    src/index.js       the public API.
    examples/          an agenda written by another tool.
    test/              the suite.

Nothing here is ever executed in place. Every attempt gets a copy; see `docs/ENGINE.md` in Cernum.
