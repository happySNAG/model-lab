'use strict';

// A plain Node script so the fixture needs no install, no package manager and no network.
// Exits 0 when everything holds, 1 otherwise, with one line per check on stdout.

const assert = require('node:assert');
const { createClock } = require('../src/clock.js');
const { createCache, set, get, peek, has, size, remove } = require('../src/cache.js');

const cacheOf = (capacity) => createCache({ capacity, clock: createClock() });

const checks = [
  ['a stored value reads back', () => {
    const cache = cacheOf(4);
    set(cache, 'a', 1);
    assert.strictEqual(get(cache, 'a'), 1);
    assert.strictEqual(peek(cache, 'a'), 1);
    assert.strictEqual(has(cache, 'a'), true);
  }],
  ['a key that was never stored reads as undefined', () => {
    const cache = cacheOf(4);
    assert.strictEqual(get(cache, 'missing'), undefined);
    assert.strictEqual(peek(cache, 'missing'), undefined);
    assert.strictEqual(has(cache, 'missing'), false);
  }],
  ['storing a key again replaces its value', () => {
    const cache = cacheOf(4);
    set(cache, 'a', 1);
    set(cache, 'a', 2);
    assert.strictEqual(get(cache, 'a'), 2);
    assert.strictEqual(size(cache), 1);
  }],
  ['removing a key removes it', () => {
    const cache = cacheOf(4);
    set(cache, 'a', 1);
    assert.strictEqual(remove(cache, 'a'), true);
    assert.strictEqual(size(cache), 0);
    assert.strictEqual(get(cache, 'a'), undefined);
  }],
  ['a cache never holds more than its capacity', () => {
    const cache = cacheOf(2);
    set(cache, 'a', 1);
    set(cache, 'b', 2);
    set(cache, 'c', 3);
    assert.strictEqual(size(cache), 2);
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
