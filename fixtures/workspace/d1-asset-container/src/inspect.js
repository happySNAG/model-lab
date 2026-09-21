'use strict';

const { readChunks, isCritical } = require('./chunks.js');

/** One line per chunk: its type, its length and whether it is critical. */
function listChunks(buffer) {
  return readChunks(buffer).map(({ type, data }) => ({ type, length: data.length, critical: isCritical(type) }));
}

function describe(buffer) {
  return listChunks(buffer)
    .map(({ type, length, critical }) => `${type} ${String(length).padStart(6)}${critical ? '' : '  (ancillary)'}`)
    .join('\n');
}

module.exports = { listChunks, describe };
