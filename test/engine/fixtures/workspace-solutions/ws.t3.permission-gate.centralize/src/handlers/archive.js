'use strict';

const { fetch, put } = require('../store/index.js');
const { withChanges } = require('../model/document.js');
const { authorize } = require('../authz/policy.js');
const { ConflictError } = require('../errors.js');

/** Mark a document as a record of what was. */
function archiveDocument(store, actor, documentID) {
  const document = fetch(store, documentID);
  authorize(actor, 'archive', document);
  if (document.archived) throw new ConflictError(`document ${documentID} is already archived`, documentID);
  return put(store, withChanges(document, { archived: true }));
}

module.exports = { archiveDocument };
