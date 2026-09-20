# broken-sum

A deliberately tiny repository used by Cernum's workspace-backed benchmark cases.

`src/stats.js` exports `sum` and `mean`. `mean` is wrong: it divides by `values.length + 1`, and it
returns `0` for an empty list instead of refusing one. `test/stats.test.js` fails because of it.

It is plain CommonJS run by `node` directly — no package manager, no dependencies, no network — so
an attempt against it measures the model rather than whether an install succeeded.

Nothing here is ever executed in place. Every attempt gets a copy; see `docs/ENGINE.md`.
