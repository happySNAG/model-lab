'use strict';

const { fetch, put } = require('../store/index.js');
const { withChanges } = require('../model/document.js');
const { authorize } = require('../authz/policy.js');
const { ConflictError } = require('../errors.js');

/** Change a document's title or body. */
function updateDocument(store, actor, documentID, changes) {
  const document = fetch(store, documentID);
  authorize(actor, 'update', document);
  if (document.archived) throw new ConflictError(`document ${documentID} is archived`, documentID);
  const allowed = {};
  if (typeof changes.title === 'string') allowed.title = changes.title;
  if (typeof changes.body === 'string') allowed.body = changes.body;
  return put(store, withChanges(document, allowed));
}

module.exports = { updateDocument };
