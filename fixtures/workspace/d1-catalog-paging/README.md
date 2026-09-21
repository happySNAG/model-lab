# d1-catalog-paging

A deliberately small repository used by Cernum's workspace-backed benchmark cases. It is plain
CommonJS run by `node` directly — no package manager, no dependencies, no network — so an attempt
against it measures the model rather than whether an install succeeded.

## What this is

The product listing behind a shop's catalogue pages and its nightly export. Products are listed a
page at a time; each page hands back a cursor, and the next request passes it to get the page after.
The catalogue changes while people page through it — products are added and withdrawn all day — and
`docs/PAGING.md` says what a caller can rely on while that happens.

## What is here

    src/store.js     the products, in memory.
    src/order.js     the order products are listed in.
    src/cursor.js    turning a position in the listing into the opaque text a caller holds.
    src/page.js      one page of the listing.
    src/filters.js   the filters a listing can be narrowed by.
    src/walk.js      every page, one after another.
    src/export.js    the nightly CSV export, which walks the whole listing.
    src/index.js     the public API.
    test/            the suite.

Nothing here is ever executed in place. Every attempt gets a copy; see `docs/ENGINE.md` in Cernum.
