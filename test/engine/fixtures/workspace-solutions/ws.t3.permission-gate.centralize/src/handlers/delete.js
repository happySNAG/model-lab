'use strict';

const { fetch, drop } = require('../store/index.js');
const { authorize } = require('../authz/policy.js');
const { ConflictError } = require('../errors.js');

/** Remove a document. */
function deleteDocument(store, actor, documentID) {
  const document = fetch(store, documentID);
  authorize(actor, 'delete', document);
  if (document.archived) throw new ConflictError(`document ${documentID} is archived`, documentID);
  return drop(store, documentID);
}

module.exports = { deleteDocument };
