# Roles

A member of a team holds one role. The roster carries it in the `role` column, and `promote`
changes it.

| role         | meaning                                                      |
|--------------|--------------------------------------------------------------|
| `member`     | on the team. The role a new member has when none is given.   |
| `maintainer` | on the team, and answerable for part of what the team owns.  |
| `lead`       | on the team, and answerable for the team.                    |

A role that is not in this table is refused when a caller asks for it.
