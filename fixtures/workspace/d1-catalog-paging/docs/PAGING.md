# Paging through the catalogue

## The order

Products are listed by `rank`, highest first. Products with the same rank are listed by `id`,
alphabetically. No two products share an id, so this order puts every product in exactly one place
— it is total, and a listing that is fetched twice without changes comes back the same both times.

## Pages and cursors

`listPage(store, { limit, after, filter })` returns up to `limit` products and a `next` cursor, or
`next: null` on the last page. A cursor is opaque to callers: they pass back exactly what they were
given.

A cursor stands for the **last product on the page it came from** — where that product sits in the
order — and the next page is the products that come after that place. It is not a count of products
already seen: the number of products before any given place changes whenever a product is added or
withdrawn, and a count would go stale with it.

## What a caller can rely on while the catalogue changes

A walk is a sequence of pages, each fetched with the cursor from the one before, with the catalogue
free to change between any two requests. For every walk:

- Every product that is in the catalogue for the whole walk is returned **exactly once**, and the
  products come back in the order above.
- That holds when products are withdrawn between pages — **including the product a cursor stands
  for**. A cursor keeps its meaning after the product it came from is gone.
- A product added during a walk is returned at most once. It is returned if it belongs after the
  place the walk has reached, and not if it belongs before it.

A cursor is used with the same filter it was issued under.
