# d1-query-codec

A deliberately small repository used by Cernum's workspace-backed benchmark cases. It is plain
CommonJS run by `node` directly — no package manager, no dependencies, no network — so an attempt
against it measures the model rather than whether an install succeeded.

## What this is

The URL layer of an issue tracker: building links and reading the parameters out of a request.
Every parameter the tracker has used so far has been flat — `page=2&sort=updated` — and the new
filter panel needs structured ones: `filter[status]=open&filter[labels][]=bug`. `docs/QUERY.md` is
the format.

## What is here

    src/query.js      turning parameters into a query string and back.
    src/url.js        a path and its parameters, as one URL and back.
    src/links.js      the links the tracker's pages carry: pagination, filters.
    src/router.js     matching a request path to a handler, with the parameters read.
    src/handlers.js   the handlers, which read what they need from the parameters.
    src/index.js      the public API.
    test/             the suite.

Nothing here is ever executed in place. Every attempt gets a copy; see `docs/ENGINE.md` in Cernum.
