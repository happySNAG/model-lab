'use strict';

const { readChunks, isCritical } = require('./chunks.js');
const { SlabError } = require('./errors.js');

/**
 * The image in a slab: `{ width, height, pixels, name, notes }`.
 *
 * Shows what it understands, as docs/FORMAT.md says a reader does: an ancillary chunk it does not
 * know is skipped, and a critical one it does not know is refused.
 */
function decode(buffer) {
  const chunks = readChunks(buffer);
  if (chunks.length === 0 || chunks[0].type !== 'HEAD') throw new SlabError('a slab starts with HEAD');
  if (chunks[chunks.length - 1].type !== 'TAIL') throw new SlabError('a slab ends with TAIL');
  const head = chunks[0].data;
  const image = { width: head.readUInt16BE(0), height: head.readUInt16BE(2), pixels: [], name: undefined, notes: [] };
  for (const [index, chunk] of chunks.entries()) {
    if (chunk.type === 'TAIL' && index !== chunks.length - 1) throw new SlabError('a chunk follows TAIL');
    if (chunk.type === 'HEAD' && index !== 0) throw new SlabError('HEAD appears twice');
    if (chunk.type === 'HEAD' || chunk.type === 'TAIL') continue;
    if (chunk.type === 'PIXL') image.pixels.push(chunk.data);
    else if (chunk.type === 'name') image.name = chunk.data.toString('utf8');
    else if (chunk.type === 'note') image.notes.push(chunk.data.toString('utf8'));
    else if (isCritical(chunk.type)) throw new SlabError(`cannot display a slab carrying a ${chunk.type} chunk`);
  }
  if (image.pixels.length === 0) throw new SlabError('a slab carries at least one PIXL chunk');
  return { ...image, pixels: Buffer.concat(image.pixels) };
}

module.exports = { decode };
