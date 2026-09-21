# d1-task-board

A deliberately small repository used by Cernum's workspace-backed benchmark cases. It is plain
CommonJS run by `node` directly — no package manager, no dependencies, no network — so an attempt
against it measures the model rather than whether an install succeeded.

## What this is

The core of a team's task board: tasks with an owner and labels, the lists the board's views are
drawn from, and the history every change is recorded in. `docs/BOARD.md` states the rules the board
keeps.

## What is here

    src/board.js     the board's operations: adding, renaming, closing, and the lists views read.
    src/indexes.js   the lookups that let a view find a person's or a label's tasks without a scan.
    src/members.js   who is on the team.
    src/history.js   the record of every change.
    src/errors.js    the errors the board throws.
    src/index.js     the public API.
    test/            the suite.

Nothing here is ever executed in place. Every attempt gets a copy; see `docs/ENGINE.md` in Cernum.
