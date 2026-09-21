'use strict';

// A plain Node script so the fixture needs no install, no package manager and no network.
// Exits 0 when everything holds, 1 otherwise, with one line per check on stdout.

const assert = require('node:assert');
const { createClock } = require('../src/clock.js');
const { createCache, set, get, statisticsOf } = require('../src/cache.js');

const checks = [
  ['a read that found something is a hit, and one that did not is a miss', () => {
    const cache = createCache({ capacity: 4, clock: createClock() });
    set(cache, 'a', 1);
    get(cache, 'a');
    get(cache, 'a');
    get(cache, 'nothing');
    const stats = statisticsOf(cache);
    assert.strictEqual(stats.hits, 2);
    assert.strictEqual(stats.misses, 1);
  }],
  ['a key dropped to stay inside capacity is counted as an eviction', () => {
    const cache = createCache({ capacity: 2, clock: createClock() });
    set(cache, 'a', 1);
    set(cache, 'b', 2);
    set(cache, 'c', 3);
    set(cache, 'd', 4);
    const stats = statisticsOf(cache);
    assert.strictEqual(stats.evictions, 2, 'two keys were dropped to make room');
    assert.strictEqual(stats.expirations, 0, 'and neither of them ran out of time');
  }],
  ['a key dropped because its time ran out is counted as an expiry, not an eviction', () => {
    const clock = createClock();
    const cache = createCache({ capacity: 4, ttlTicks: 5, clock });
    set(cache, 'a', 1);
    clock.advance(5);
    get(cache, 'a');
    const stats = statisticsOf(cache);
    assert.strictEqual(stats.expirations, 1);
    assert.strictEqual(stats.evictions, 0);
    assert.strictEqual(stats.misses, 1, 'the read that found it gone was a miss');
  }],
  ['reading the statistics cannot change them', () => {
    const cache = createCache({ capacity: 4, clock: createClock() });
    const stats = statisticsOf(cache);
    stats.hits = 99;
    assert.strictEqual(statisticsOf(cache).hits, 0);
  }],
];

let failed = 0;
for (const [name, check] of checks) {
  try {
    check();
    console.log(`ok - ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`not ok - ${name}: ${error.message}`);
  }
}
console.log(`${checks.length - failed}/${checks.length} passed`);
process.exit(failed === 0 ? 0 : 1);
