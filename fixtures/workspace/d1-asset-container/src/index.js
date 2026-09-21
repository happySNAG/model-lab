'use strict';

const { SIGNATURE, readChunks, writeChunks, isCritical } = require('./chunks.js');
const { decode } = require('./decode.js');
const { encode } = require('./encode.js');
const { setName, addNote, removeNotes } = require('./edit.js');
const { listChunks, describe } = require('./inspect.js');
const { SlabError } = require('./errors.js');

module.exports = {
  SIGNATURE, readChunks, writeChunks, isCritical,
  decode, encode, setName, addNote, removeNotes, listChunks, describe, SlabError,
};
