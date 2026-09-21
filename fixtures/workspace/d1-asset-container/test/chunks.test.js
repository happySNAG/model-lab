'use strict';

// A plain Node script so the fixture needs no install, no package manager and no network.
// Exits 0 when everything holds, 1 otherwise, with one line per check on stdout.

const assert = require('node:assert');
const { SIGNATURE, readChunks, writeChunks, isCritical } = require('../src/chunks.js');

const sample = [
  { type: 'HEAD', data: Buffer.from([0, 2, 0, 1]) },
  { type: 'PIXL', data: Buffer.from([1, 2, 3, 4, 5, 6]) },
  { type: 'TAIL', data: Buffer.alloc(0) },
];

const checks = [
  ['a chunk sequence survives being written and read back', () => {
    const slab = writeChunks(sample);
    assert.ok(slab.subarray(0, 8).equals(SIGNATURE));
    assert.deepStrictEqual(readChunks(slab).map((chunk) => chunk.type), ['HEAD', 'PIXL', 'TAIL']);
    assert.ok(readChunks(slab)[1].data.equals(Buffer.from([1, 2, 3, 4, 5, 6])));
  }],
  ['a damaged chunk is refused rather than read', () => {
    const slab = writeChunks(sample);
    slab[slab.length - 20] ^= 0xff;
    assert.throws(() => readChunks(slab), /checksum/);
  }],
  ['a file without the signature is refused', () => {
    assert.throws(() => readChunks(Buffer.from('not a slab at all')), /signature/);
  }],
  ['critical chunks are the ones whose type starts with a capital', () => {
    assert.strictEqual(isCritical('HEAD'), true);
    assert.strictEqual(isCritical('note'), false);
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
