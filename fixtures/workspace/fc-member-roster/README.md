# fc-member-roster

A deliberately small repository used by Cernum's workspace-backed benchmark cases. It is plain
CommonJS run by `node` directly — no package manager, no dependencies, no network — so an attempt
against it measures the model rather than whether an install succeeded.

## What this is

A **roster** is the file a team keeps its members in: a header naming the columns, then one row per
member, with comments between. `docs/FORMAT.md` is the format, including what a tool that rewrites
a roster may and may not do to it, and `docs/ROLES.md` lists the roles a member can hold.

## What is here

    src/table.js     reading and writing the table: the header, the rows and the comments.
    src/roles.js     the roles, and the one a new member gets.
    src/decode.js    a roster, read into a list of members.
    src/encode.js    a list of members, written out as a new roster.
    src/edit.js      changing an existing roster: who is on which team, in which role, and who has left.
    src/query.js     who is on a team, for people and for tests.
    src/errors.js    the one error this package throws.
    src/index.js     the public API.
    examples/        a roster written by another tool.
    test/            the suite.

Nothing here is ever executed in place. Every attempt gets a copy; see `docs/ENGINE.md` in Cernum.
