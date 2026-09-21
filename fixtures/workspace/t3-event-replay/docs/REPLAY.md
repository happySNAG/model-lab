# Replay

## The log

A log is a list of events. Each event carries a **sequence number**: a whole number saying where it
belongs in the order things happened. Sequence numbers start at 1 and go up by one, and a log may
arrive in any order — out of a queue, out of two files, out of a page of results.

`inOrder(events)` answers with the events sorted by sequence number, ascending. It **answers with a
new list and leaves the one it was given exactly as it found it**; a caller holding a log must be
able to ask for it in order without losing the order it had.

## Applying an event

`applyEvent(state, event)` answers with **the state that results**.

**It is pure.** The state it was handed is never changed — not its balance, not its holds, not its
last sequence number. Applying an event to a state you are holding gives you a second state; it does
not turn the first one into the second.

This is the property the rest of the package is built on. `replay` does not defend against a
`applyEvent` that breaks it, and it is not supposed to have to.

## Replay

`replay(events, from)` applies a log, in order, to a starting state.

    replay(events)                   from nothing
    replay(events, snapshot)         from a state something else already worked out

**Replay is pure too**, and for the same reason: the starting state is not changed, so the same
replay run twice gives the same answer, and a snapshot handed to a replay is still the same snapshot
afterwards.

## Snapshots

A snapshot is a state kept so that a later replay need not start from nothing.

**Replaying the tail of a log from a snapshot of its head gives the same state as replaying the whole
log from nothing.** That equivalence is the entire reason snapshots exist, and a package where it
does not hold has snapshots that are worse than useless — they are a faster way to get a different
answer.
