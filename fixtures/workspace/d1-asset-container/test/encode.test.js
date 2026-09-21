'use strict';

// A plain Node script so the fixture needs no install, no package manager and no network.
// Exits 0 when everything holds, 1 otherwise, with one line per check on stdout.

const assert = require('node:assert');
const { encode } = require('../src/encode.js');
const { decode } = require('../src/decode.js');
const { listChunks } = require('../src/inspect.js');

const image = { width: 4, height: 2, pixels: Buffer.from([9, 8, 7, 6, 5, 4, 3, 2]) };

const checks = [
  ['an image survives being written and read back', () => {
    const back = decode(encode({ ...image, notes: ['first'] }));
    assert.strictEqual(back.width, 4);
    assert.strictEqual(back.height, 2);
    assert.ok(back.pixels.equals(image.pixels));
    assert.deepStrictEqual(back.notes, ['first']);
  }],
  ['a large image is spread over several pixel chunks', () => {
    const large = { width: 20, height: 10, pixels: Buffer.alloc(200, 7) };
    const types = listChunks(encode(large)).map((chunk) => chunk.type);
    assert.ok(types.filter((type) => type === 'PIXL').length > 1);
    assert.ok(decode(encode(large)).pixels.equals(large.pixels));
  }],
  ['the name comes before the pixel data', () => {
    const types = listChunks(encode({ ...image, name: 'Sprite' })).map((chunk) => chunk.type);
    assert.deepStrictEqual(types, ['HEAD', 'name', 'PIXL', 'TAIL']);
  }],
  ['a name is text, whatever alphabet it is written in', () => {
    assert.strictEqual(decode(encode({ ...image, name: 'Café Ørsted' })).name, 'Café Ørsted');
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
