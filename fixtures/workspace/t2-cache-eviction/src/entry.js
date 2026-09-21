'use strict';

/**
 * What the cache holds for one key.
 *
 * `storedAt` is a clock tick and answers whether the entry has expired. `useSequence` is a counter
 * and answers which entry was used longest ago — a separate number, because two uses at the same
 * tick still have an order and eviction has to know it.
 */
function createEntry(key, value, storedAt, useSequence) {
  return { key, value, storedAt, useSequence };
}

module.exports = { createEntry };
