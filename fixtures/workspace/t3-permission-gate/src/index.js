'use strict';

const { createActor } = require('./model/actor.js');
const { createDocument, withChanges } = require('./model/document.js');
const { createStore, all } = require('./store/index.js');
const handlers = require('./handlers/index.js');
const { renderDocument, summarizeDocument } = require('./render.js');
const { titleMatches, searchByTitle, sortedByTitle } = require('./search.js');
const { pageOf, describePage } = require('./pagination.js');
const errors = require('./errors.js');

/** The public API. A consumer of this service never reaches past this file into `src/`. */
module.exports = {
  createActor,
  createDocument,
  withChanges,
  createStore,
  all,
  readDocument: handlers.readDocument,
  updateDocument: handlers.updateDocument,
  deleteDocument: handlers.deleteDocument,
  exportDocument: handlers.exportDocument,
  archiveDocument: handlers.archiveDocument,
  renderDocument,
  summarizeDocument,
  titleMatches,
  searchByTitle,
  sortedByTitle,
  pageOf,
  describePage,
  ForbiddenError: errors.ForbiddenError,
  UnknownActionError: errors.UnknownActionError,
  NotFoundError: errors.NotFoundError,
  ConflictError: errors.ConflictError,
};
