'use strict';

const { readChunks, writeChunks } = require('./chunks.js');
const { SlabError } = require('./errors.js');

/**
 * Editing works on the chunk sequence, never on the decoded image: every chunk an edit was not asked
 * to change is copied as it is, including chunks this package does not understand. See "Editing a
 * slab" in docs/FORMAT.md.
 */
function chunksOf(buffer) {
  const chunks = readChunks(buffer);
  if (chunks.length === 0 || chunks[0].type !== 'HEAD') throw new SlabError('a slab starts with HEAD');
  if (chunks[chunks.length - 1].type !== 'TAIL') throw new SlabError('a slab ends with TAIL');
  return chunks;
}

/** The same slab with its title set to `name`. */
function setName(buffer, name) {
  const chunks = chunksOf(buffer);
  const named = { type: 'name', data: Buffer.from(name, 'utf8') };
  const existing = chunks.findIndex((chunk) => chunk.type === 'name');
  if (existing !== -1) {
    chunks[existing] = named;
  } else {
    const firstPixels = chunks.findIndex((chunk) => chunk.type === 'PIXL');
    chunks.splice(firstPixels === -1 ? 1 : firstPixels, 0, named);
  }
  return writeChunks(chunks);
}

/** The same slab with one more note, immediately before TAIL. */
function addNote(buffer, text) {
  const chunks = chunksOf(buffer);
  chunks.splice(chunks.length - 1, 0, { type: 'note', data: Buffer.from(text, 'utf8') });
  return writeChunks(chunks);
}

/** The same slab without its note chunks, and with everything else as it was. */
function removeNotes(buffer) {
  return writeChunks(chunksOf(buffer).filter((chunk) => chunk.type !== 'note'));
}

module.exports = { setName, addNote, removeNotes };
