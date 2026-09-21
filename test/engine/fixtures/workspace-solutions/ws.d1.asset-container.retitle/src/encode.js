'use strict';

const { writeChunks } = require('./chunks.js');
const { uint16 } = require('./bytes.js');

/** Pixel data is split into chunks of at most this many bytes. */
const PIXEL_CHUNK_BYTES = 64;

/** A new slab holding this image: `{ width, height, pixels, name?, notes? }`. */
function encode(image) {
  const chunks = [{ type: 'HEAD', data: Buffer.concat([uint16(image.width), uint16(image.height)]) }];
  if (image.name !== undefined) chunks.push({ type: 'name', data: Buffer.from(image.name, 'utf8') });
  const pixels = Buffer.from(image.pixels);
  for (let offset = 0; offset < pixels.length || offset === 0; offset += PIXEL_CHUNK_BYTES) {
    chunks.push({ type: 'PIXL', data: pixels.subarray(offset, offset + PIXEL_CHUNK_BYTES) });
    if (pixels.length === 0) break;
  }
  for (const note of image.notes ?? []) chunks.push({ type: 'note', data: Buffer.from(note, 'utf8') });
  chunks.push({ type: 'TAIL', data: Buffer.alloc(0) });
  return writeChunks(chunks);
}

module.exports = { encode, PIXEL_CHUNK_BYTES };
