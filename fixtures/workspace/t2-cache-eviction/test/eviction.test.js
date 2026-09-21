'use strict';

// A plain Node script so the fixture needs no install, no package manager and no network.
// Exits 0 when everything holds, 1 otherwise, with one line per check on stdout.

const assert = require('node:assert');
const { createClock } = require('../src/clock.js');
const { createCache, set, get, has, keys } = require('../src/cache.js');

const cacheOf = (capacity) => createCache({ capacity, clock: createClock() });

const checks = [
  ['the key nobody has asked for is the one that goes', () => {
    const cache = cacheOf(3);
    set(cache, 'a', 1);
    set(cache, 'b', 2);
    set(cache, 'c', 3);
    get(cache, 'a');
    get(cache, 'c');
    set(cache, 'd', 4);
    assert.strictEqual(has(cache, 'b'), false, 'b had gone longest without a use');
    assert.deepStrictEqual(keys(cache).sort(), ['a', 'c', 'd']);
  }],
  ['reading a key makes it the most recently used one', () => {
    const cache = cacheOf(2);
    set(cache, 'a', 1);
    set(cache, 'b', 2);
    get(cache, 'a');
    set(cache, 'c', 3);
    assert.strictEqual(has(cache, 'a'), true, 'a was read, so b was the older one');
    assert.strictEqual(has(cache, 'b'), false);
  }],
  ['reading a key repeatedly keeps it alive', () => {
    const cache = cacheOf(2);
    set(cache, 'a', 1);
    set(cache, 'b', 2);
    for (let round = 0; round < 3; round += 1) {
      get(cache, 'a');
      set(cache, `filler${round}`, round);
    }
    assert.strictEqual(has(cache, 'a'), true);
  }],
  ['the key order says which key was used last', () => {
    const cache = cacheOf(3);
    set(cache, 'a', 1);
    set(cache, 'b', 2);
    set(cache, 'c', 3);
    get(cache, 'a');
    assert.deepStrictEqual(keys(cache), ['b', 'c', 'a']);
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
