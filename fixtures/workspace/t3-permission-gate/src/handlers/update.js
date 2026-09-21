'use strict';

const { fetch, put } = require('../store/index.js');
const { withChanges } = require('../model/document.js');
const { ForbiddenError, ConflictError } = require('../errors.js');

/**
 * Change a document's title or body.
 *
 * The permission check below is inline, which `docs/ARCHITECTURE.md` says it should not be.
 */
function updateDocument(store, actor, documentID, changes) {
  const document = fetch(store, documentID);
  const mayUpdate = actor.role === 'curator' || actor.role === 'admin'
    || (actor.role === 'writer' && !document.locked);
  if (!mayUpdate) throw new ForbiddenError('update', actor.role, documentID);
  if (document.archived) throw new ConflictError(`document ${documentID} is archived`, documentID);
  const allowed = {};
  if (typeof changes.title === 'string') allowed.title = changes.title;
  if (typeof changes.body === 'string') allowed.body = changes.body;
  return put(store, withChanges(document, allowed));
}

module.exports = { updateDocument };
