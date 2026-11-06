# The roster format

A roster is a text file of comma-separated lines. The first line is the header and names the
columns; every line after it is either a row, with one cell per column, or a comment.

## Lines

- A **row** has exactly as many cells as the header has columns, separated by commas. A cell may be
  empty. A cell never contains a comma or a line break, and nothing is quoted.
- A **comment** starts with `#` and runs to the end of the line. Comments may appear anywhere after
  the header.

## The columns this package understands

| column   | value                                                  |
|----------|--------------------------------------------------------|
| `handle` | lowercase letters, digits and hyphens; unique          |
| `name`   | the member's name                                      |
| `team`   | the team the member is on                              |
| `role`   | one of the roles in `docs/ROLES.md`                    |
| `since`  | `YYYY-MM-DD`, the day the member joined; may be empty  |

Columns may come in any order. Rosters are also written by other tools and by newer releases of
this one, and they may carry columns that are not in this table, in any position.

## Reading a roster

A reader finds each column it understands by its name in the header, wherever it is, and ignores a
column it does not know and every comment.

## Editing a roster

A tool that rewrites a roster changes the cells it was asked to change and **copies everything else
exactly**: every comment where it was, every column in the order it was found — including columns
this package does not understand, with each row's cells under them as they were — and every row in
the order it was found. Moving a member to another team does not require understanding the other
columns of their row, and a column another tool added belongs to that tool: reading may ignore it;
rewriting the file must not lose it.

- **transfer** sets the `team` cell of the member's row.
- **promote** sets the `role` cell of the member's row.
- **addMember** appends one row after the last line of the file, with the member's values under the
  columns this package understands and an empty cell under every other column.
- **retire** removes the member's row and nothing else.
