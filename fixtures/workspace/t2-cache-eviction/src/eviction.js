'use strict';

/**
 * Which key goes when the cache is full.
 *
 * Least recently used: the entry whose last use is furthest back. `useSequence` is the ordering,
 * not the clock — see `src/entry.js`.
 */
function leastRecentlyUsed(entries) {
  let oldest;
  for (const entry of entries.values()) {
    if (oldest === undefined || entry.useSequence < oldest.useSequence) oldest = entry;
  }
  return oldest;
}

/**
 * Drop keys until the map holds no more than `capacity` of them.
 *
 * Returns the keys it dropped, in the order it dropped them, so the caller can count them.
 */
function evictToCapacity(entries, capacity) {
  const evicted = [];
  while (entries.size > capacity) {
    const oldest = leastRecentlyUsed(entries);
    if (oldest === undefined) break;
    entries.delete(oldest.key);
    evicted.push(oldest.key);
  }
  return evicted;
}

module.exports = { leastRecentlyUsed, evictToCapacity };
