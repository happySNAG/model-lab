'use strict';

/** What the cache has been doing. Every number starts at zero and only ever goes up. */
function createStats() {
  return { hits: 0, misses: 0, evictions: 0, expirations: 0 };
}

function recordHit(stats) {
  stats.hits += 1;
}

function recordMiss(stats) {
  stats.misses += 1;
}

function recordEvictions(stats, count) {
  stats.evictions += count;
}

function recordExpiration(stats) {
  stats.expirations += 1;
}

/** A copy, so a caller reading the statistics cannot write to them. */
function snapshotOf(stats) {
  return { ...stats };
}

module.exports = { createStats, recordHit, recordMiss, recordEvictions, recordExpiration, snapshotOf };
