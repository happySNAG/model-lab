'use strict';

const { fetch, drop } = require('../store/index.js');
const { ForbiddenError, ConflictError } = require('../errors.js');

/**
 * Remove a document.
 *
 * The permission check below is inline, which `docs/ARCHITECTURE.md` says it should not be.
 */
function deleteDocument(store, actor, documentID) {
  const document = fetch(store, documentID);
  const mayDelete = actor.role === 'curator' || actor.role === 'admin';
  if (!mayDelete) throw new ForbiddenError('delete', actor.role, documentID);
  if (document.archived) throw new ConflictError(`document ${documentID} is archived`, documentID);
  return drop(store, documentID);
}

module.exports = { deleteDocument };
