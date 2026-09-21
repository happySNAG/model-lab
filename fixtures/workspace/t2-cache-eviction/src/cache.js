'use strict';

const { createClock } = require('./clock.js');
const { createEntry } = require('./entry.js');
const { evictToCapacity } = require('./eviction.js');
const { createStats, recordHit, recordMiss, recordExpiration, snapshotOf } = require('./stats.js');

/**
 * A cache with a capacity and a time to live.
 *
 * `README.md` and `docs/CACHE.md` are the contract: which calls count as a use, and what happens to
 * an entry whose time has run out.
 */
function createCache(options) {
  const settings = options === undefined ? {} : options;
  const capacity = settings.capacity === undefined ? 8 : settings.capacity;
  if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError(`not a capacity: ${capacity}`);
  const ttlTicks = settings.ttlTicks === undefined ? Number.POSITIVE_INFINITY : settings.ttlTicks;
  return {
    capacity,
    ttlTicks,
    clock: settings.clock === undefined ? createClock() : settings.clock,
    entries: new Map(),
    stats: createStats(),
    useSequence: 0,
  };
}

/** Whether this entry's time has run out. */
function isExpired(cache, entry) {
  return cache.clock.now() - entry.storedAt >= cache.ttlTicks;
}

/** Make this entry the most recently used one. */
function touch(cache, entry) {
  cache.useSequence += 1;
  entry.useSequence = cache.useSequence;
}

/**
 * The live entry under `key`, or `undefined`.
 *
 * SHARED BY EVERY READING CALL, so that expiry is judged one way rather than three. An entry found
 * to have expired is dropped here and counted as an expiry.
 */
function read(cache, key) {
  const entry = cache.entries.get(key);
  if (entry === undefined) return undefined;
  if (isExpired(cache, entry)) {
    cache.entries.delete(key);
    recordExpiration(cache.stats);
    return undefined;
  }
  return entry;
}

/** Store a value. Storing is a use, and it may evict the key nobody has asked for. */
function set(cache, key, value) {
  cache.useSequence += 1;
  cache.entries.set(key, createEntry(key, value, cache.clock.now(), cache.useSequence));
  const evicted = evictToCapacity(cache.entries, cache.capacity);
  return evicted;
}

/** The value under `key`, or `undefined`. A `get` is a use — see `README.md`. */
function get(cache, key) {
  const entry = read(cache, key);
  if (entry === undefined) {
    recordMiss(cache.stats);
    return undefined;
  }
  recordHit(cache.stats);
  return entry.value;
}

/** The value under `key`, or `undefined`, without disturbing the cache. A `peek` is not a use. */
function peek(cache, key) {
  const entry = read(cache, key);
  return entry === undefined ? undefined : entry.value;
}

/** Whether a live entry is under `key`. Not a use, and not counted. */
function has(cache, key) {
  return read(cache, key) !== undefined;
}

/** How many live entries the cache holds. */
function size(cache) {
  return cache.entries.size;
}

/** Every live key, most recently used last. */
function keys(cache) {
  return [...cache.entries.values()]
    .sort((a, b) => a.useSequence - b.useSequence)
    .map((entry) => entry.key);
}

function remove(cache, key) {
  return cache.entries.delete(key);
}

function statisticsOf(cache) {
  return snapshotOf(cache.stats);
}

module.exports = {
  createCache, isExpired, touch, read, set, get, peek, has, size, keys, remove, statisticsOf,
};
