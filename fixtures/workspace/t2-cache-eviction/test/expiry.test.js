'use strict';

// A plain Node script so the fixture needs no install, no package manager and no network.
// Exits 0 when everything holds, 1 otherwise, with one line per check on stdout.

const assert = require('node:assert');
const { createClock } = require('../src/clock.js');
const { createCache, set, get, has, size } = require('../src/cache.js');

const checks = [
  ['an entry is live right up to the tick its time runs out', () => {
    const clock = createClock();
    const cache = createCache({ capacity: 4, ttlTicks: 10, clock });
    set(cache, 'a', 1);
    clock.advance(9);
    assert.strictEqual(get(cache, 'a'), 1);
  }],
  ['an entry whose time has run out reads as undefined', () => {
    const clock = createClock();
    const cache = createCache({ capacity: 4, ttlTicks: 10, clock });
    set(cache, 'a', 1);
    clock.advance(10);
    assert.strictEqual(get(cache, 'a'), undefined);
    assert.strictEqual(has(cache, 'a'), false);
  }],
  ['an expired entry is dropped rather than left sitting there', () => {
    const clock = createClock();
    const cache = createCache({ capacity: 4, ttlTicks: 10, clock });
    set(cache, 'a', 1);
    clock.advance(10);
    get(cache, 'a');
    assert.strictEqual(size(cache), 0);
  }],
  ['storing a key again restarts its time', () => {
    const clock = createClock();
    const cache = createCache({ capacity: 4, ttlTicks: 10, clock });
    set(cache, 'a', 1);
    clock.advance(9);
    set(cache, 'a', 2);
    clock.advance(9);
    assert.strictEqual(get(cache, 'a'), 2);
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
