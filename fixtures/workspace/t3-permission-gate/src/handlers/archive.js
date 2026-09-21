'use strict';

const { fetch, put } = require('../store/index.js');
const { withChanges } = require('../model/document.js');
const { ConflictError } = require('../errors.js');

/**
 * Mark a document as a record of what was.
 *
 * `docs/AUTHZ.md` has a column for this action.
 */
function archiveDocument(store, actor, documentID) {
  const document = fetch(store, documentID);
  if (document.archived) throw new ConflictError(`document ${documentID} is already archived`, documentID);
  return put(store, withChanges(document, { archived: true }));
}

module.exports = { archiveDocument };
