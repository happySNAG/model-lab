'use strict';

const { createClock } = require('./clock.js');
const { createCache, set, get, peek, has, size, keys, remove, statisticsOf } = require('./cache.js');
const { leastRecentlyUsed, evictToCapacity } = require('./eviction.js');

/** The public API. A consumer of this package never reaches past this file into `src/`. */
module.exports = {
  createClock,
  createCache,
  set,
  get,
  peek,
  has,
  size,
  keys,
  remove,
  statisticsOf,
  leastRecentlyUsed,
  evictToCapacity,
};
