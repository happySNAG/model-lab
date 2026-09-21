'use strict';

// A plain Node script so the fixture needs no install, no package manager and no network.
// Exits 0 when everything holds, 1 otherwise, with one line per check on stdout.

const assert = require('node:assert');
const { encode } = require('../src/encode.js');
const { decode } = require('../src/decode.js');
const { setName, addNote, removeNotes } = require('../src/edit.js');
const { listChunks } = require('../src/inspect.js');

const image = { width: 2, height: 2, pixels: Buffer.from([1, 2, 3, 4]) };
const typesOf = (slab) => listChunks(slab).map((chunk) => chunk.type);

const checks = [
  ['naming an image that has no name gives it one, in the right place', () => {
    const named = setName(encode(image), 'Tile');
    assert.strictEqual(decode(named).name, 'Tile');
    assert.deepStrictEqual(typesOf(named), ['HEAD', 'name', 'PIXL', 'TAIL']);
  }],
  ['renaming an image replaces its name', () => {
    const renamed = setName(setName(encode(image), 'Tile'), 'Floor tile');
    assert.strictEqual(decode(renamed).name, 'Floor tile');
    assert.strictEqual(typesOf(renamed).filter((type) => type === 'name').length, 1);
  }],
  ['a note can be added, and the file still reads', () => {
    const noted = addNote(addNote(encode(image), 'drawn by hand'), 'second pass');
    assert.deepStrictEqual(decode(noted).notes, ['drawn by hand', 'second pass']);
    assert.strictEqual(typesOf(noted)[typesOf(noted).length - 1], 'TAIL');
  }],
  ['notes can be removed', () => {
    const cleaned = removeNotes(encode({ ...image, name: 'Tile', notes: ['a', 'b'] }));
    assert.deepStrictEqual(decode(cleaned).notes, []);
    assert.strictEqual(decode(cleaned).name, 'Tile');
  }],
  ['editing leaves the pixels alone', () => {
    const edited = removeNotes(addNote(setName(encode(image), 'Tile'), 'x'));
    assert.ok(decode(edited).pixels.equals(image.pixels));
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
