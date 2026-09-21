'use strict';

const { readChunks, writeChunks } = require('./chunks.js');
const { decode } = require('./decode.js');
const { encode } = require('./encode.js');

/** The same slab with its title set to `name`. See "Editing a slab" in docs/FORMAT.md. */
function setName(buffer, name) {
  return encode({ ...decode(buffer), name });
}

/** The same slab with one more note. */
function addNote(buffer, text) {
  return writeChunks([...readChunks(buffer), { type: 'note', data: Buffer.from(text, 'utf8') }]);
}

/** The same slab without its notes. */
function removeNotes(buffer) {
  return encode({ ...decode(buffer), notes: [] });
}

module.exports = { setName, addNote, removeNotes };
