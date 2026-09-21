'use strict';

const { crc32 } = require('./crc32.js');
const { readUInt32, uint32 } = require('./bytes.js');
const { SlabError } = require('./errors.js');

const SIGNATURE = Buffer.from([0x89, 0x53, 0x4c, 0x42, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Critical chunks have an uppercase first letter; see docs/FORMAT.md. */
function isCritical(type) {
  return type[0] >= 'A' && type[0] <= 'Z';
}

/**
 * The chunks in a slab, in order, as `{ type, data }`.
 *
 * Checks the signature, every length and every checksum. It does not look inside any chunk.
 */
function readChunks(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < SIGNATURE.length
    || !buffer.subarray(0, SIGNATURE.length).equals(SIGNATURE)) {
    throw new SlabError('not a slab: the signature is missing');
  }
  const chunks = [];
  let offset = SIGNATURE.length;
  while (offset < buffer.length) {
    if (offset + 12 > buffer.length) throw new SlabError(`a chunk at byte ${offset} is cut short`);
    const length = readUInt32(buffer, offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type)) throw new SlabError(`the chunk at byte ${offset} has no valid type`);
    const end = offset + 8 + length;
    if (end + 4 > buffer.length) throw new SlabError(`the ${type} chunk at byte ${offset} is cut short`);
    const data = buffer.subarray(offset + 8, end);
    const expected = readUInt32(buffer, end);
    const actual = crc32(buffer.subarray(offset + 4, end));
    if (expected !== actual) throw new SlabError(`the ${type} chunk at byte ${offset} fails its checksum`);
    chunks.push({ type, data: Buffer.from(data) });
    offset = end + 4;
  }
  return chunks;
}

/** A slab made of these chunks, in this order, each with its checksum. */
function writeChunks(chunks) {
  const parts = [SIGNATURE];
  for (const { type, data } of chunks) {
    const typeBytes = Buffer.from(type, 'latin1');
    parts.push(uint32(data.length), typeBytes, data, uint32(crc32(Buffer.concat([typeBytes, data]))));
  }
  return Buffer.concat(parts);
}

module.exports = { SIGNATURE, readChunks, writeChunks, isCritical };
