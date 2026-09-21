'use strict';

const { readDocument } = require('./read.js');
const { updateDocument } = require('./update.js');
const { deleteDocument } = require('./delete.js');
const { exportDocument } = require('./export.js');
const { archiveDocument } = require('./archive.js');

/** Every thing a caller can ask this service to do. */
module.exports = { readDocument, updateDocument, deleteDocument, exportDocument, archiveDocument };
