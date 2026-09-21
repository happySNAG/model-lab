# t3-permission-gate

A deliberately small repository used by Cernum's workspace-backed benchmark cases. It is plain
CommonJS run by `node` directly — no package manager, no dependencies, no network — so an attempt
against it measures the model rather than whether an install succeeded.

## What is here

    src/model/       what a document is, and what an actor is.
    src/store/       where documents live. An in-memory store, seeded from a fixed list.
    src/handlers/    one file per thing a caller can ask this service to do.
    src/search.js    finding documents by title.
    src/pagination.js   slicing a result list into pages.
    src/render.js    a document as text.
    src/errors.js    the errors this service throws.
    src/index.js     the public API.
    test/            the suite.

## What this service is

A document service. A caller arrives as an **actor** — an id and a role — and asks for something to
be done to a **document**. Some of those things some actors may not do.

`docs/ARCHITECTURE.md` describes where that decision is supposed to be made, and `docs/AUTHZ.md` is
the decision itself, written out in full. The code in `src/handlers/` does not currently match
either document, which is the thing to know before changing any of it.

Nothing here is ever executed in place. Every attempt gets a copy; see `docs/ENGINE.md` in Cernum.
