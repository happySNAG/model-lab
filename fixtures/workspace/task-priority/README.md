# task-priority

A deliberately tiny repository used by Cernum's workspace-backed benchmark cases. It is plain
CommonJS run by `node` directly — no package manager, no dependencies, no network — so an attempt
against it measures the model rather than whether an install succeeded.

## What is here

    src/task.js     the core model. `createTask` validates and builds a task; `completeTask` returns
                    a completed copy. Nothing else constructs a task.
    src/wire.js     the storage adapter. `toWire` renders a task as the short-keyed record written to
                    disk; `fromWire` reads one back. `docs/FORMAT.md` is the contract for those keys.
    src/index.js    the public API. Everything a consumer of this package is allowed to import.
    test/           the suite. Three files, one per layer.

## The rule this repository is built around

A task field is not one change. It belongs to the core model, it has to survive a round trip through
the wire format, and it has to be reachable from the public API — and `docs/FORMAT.md` says what a
reader of an OLD record must still get, which is a separate question from what a new record carries.

Nothing here is ever executed in place. Every attempt gets a copy; see `docs/ENGINE.md` in Cernum.
