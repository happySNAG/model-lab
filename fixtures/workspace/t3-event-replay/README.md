# t3-event-replay

A deliberately small repository used by Cernum's workspace-backed benchmark cases. It is plain
CommonJS run by `node` directly — no package manager, no dependencies, no network — so an attempt
against it measures the model rather than whether an install succeeded.

There is **no wall clock and no randomness anywhere in this package**. An event carries the sequence
number it was given; nothing here generates one.

## What is here

    src/event.js      what an event is, and the kinds there are.
    src/validate.js   whether an event is well formed.
    src/state.js      what an account looks like at a moment.
    src/apply.js      one event applied to one state.
    src/order.js      events in the order they happened.
    src/replay.js     a log applied to a state.
    src/snapshot.js   a state, kept so a later replay need not start from nothing.
    src/log.js        building and appending to a log.
    src/report.js     a state as a person reads it.
    src/summary.js    counting a log by kind.
    src/index.js      the public API.
    test/             the suite.

## What is wrong with it

Four of the six suites fail. The report they produce is not one problem seen five ways: replaying a
log gives the wrong balance, replaying the tail of a log from a snapshot does not agree with
replaying the whole of it from nothing, and a snapshot does not stay the way it was made.

`docs/REPLAY.md` states what replay promises. Everything that is failing is failing against
something in it.

Nothing here is ever executed in place. Every attempt gets a copy; see `docs/ENGINE.md` in Cernum.
