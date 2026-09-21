# The board's rules

- A task has an `id`, a `title`, an `owner`, a list of `labels` and a `state`, `open` or `closed`.
- **An owner is a member of the team.** Giving a task to anyone else is refused with
  `UnknownMemberError`.
- **A closed task is finished.** Its owner and labels no longer change; a change to either is
  refused with `TaskClosedError`.
- **A change that is refused changes nothing** — no field of any task, no list a view reads, and no
  history entry.
- **Every change that succeeds is recorded**: one history entry per change, saying what changed from
  what to what.
- **The lists a view reads always agree with the tasks.** `tasksFor(owner)`, `tasksLabelled(label)`
  and `openCount(owner)` answer exactly what a scan of every task would answer at that moment.
