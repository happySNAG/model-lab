# t2-cache-eviction

A deliberately small repository used by Cernum's workspace-backed benchmark cases. It is plain
CommonJS run by `node` directly — no package manager, no dependencies, no network — so an attempt
against it measures the model rather than whether an install succeeded.

There is **no wall clock anywhere in this package**. Time is a counter the caller advances, so the
same sequence of calls always gives the same answer.

## What is here

    src/clock.js      a logical clock. The caller advances it; nothing here reads the machine's.
    src/entry.js      what the cache holds for one key.
    src/eviction.js   which key goes when the cache is full.
    src/cache.js      the cache itself.
    src/stats.js      what the cache has been doing.
    src/index.js      the public API.
    test/             the suite.

## The rules this cache promises

**A `get` is a use.** Reading a key makes it the most recently used key in the cache, so the key
that gets evicted next is the one nobody has asked for.

**A `peek` is not a use.** `peek` answers with the same value `get` would answer with, and changes
nothing: not the eviction order, not which key is next to go. It exists precisely so that a caller
can look at the cache without disturbing it — an inspector, a debug dump, a metrics sweep — and a
`peek` that quietly reordered the cache would be worse than no `peek` at all.

**An expired entry is gone, not stale.** Reading a key whose time has run out answers `undefined`,
drops the entry, and is not a use of it. An expired entry is never promoted on its way out.

See `docs/CACHE.md` for the whole contract.

Nothing here is ever executed in place. Every attempt gets a copy; see `docs/ENGINE.md` in Cernum.
