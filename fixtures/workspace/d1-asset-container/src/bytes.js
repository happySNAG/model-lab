'use strict';

function readUInt32(buffer, offset) {
  return buffer.readUInt32BE(offset);
}

function uint32(value) {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value >>> 0, 0);
  return out;
}

function uint16(value) {
  const out = Buffer.alloc(2);
  out.writeUInt16BE(value, 0);
  return out;
}

module.exports = { readUInt32, uint32, uint16 };
