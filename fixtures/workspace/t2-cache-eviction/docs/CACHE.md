# The cache contract

## Capacity and eviction

A cache holds at most `capacity` entries. Storing a key when the cache is full evicts the **least
recently used** key first — the one that has gone longest without a use.

## What counts as a use

| call | answers with the value | counts as a use | counts in `hits`/`misses` |
|---|---|---|---|
| `get(cache, key)` | yes | **yes** | yes |
| `peek(cache, key)` | yes | **no** | no |
| `has(cache, key)` | no | no | no |
| `set(cache, key, value)` | — | yes | no |

A use makes the key the most recently used key in the cache. `peek` and `has` are inspections: they
answer the same question `get` answers and leave the cache exactly as they found it. A caller
sweeping every key to build a report must be able to do so without changing what gets evicted next.

## Expiry

An entry stored at tick *t* with a time to live of *n* ticks is live while `now - storedAt < n`, and
expired from `now - storedAt === n` onward.

Reading an expired key answers `undefined` and drops the entry. **It is not a use**: an entry on its
way out is never promoted first, whichever call found it. An expiry is counted in `expirations`, and
the read that found it is counted as a miss when it was a `get`.

## Statistics

`hits`, `misses`, `evictions` and `expirations` count what the cache has actually done. `evictions`
counts keys dropped to stay inside capacity; `expirations` counts keys dropped because their time
ran out. A key dropped for one reason is never counted under the other.
