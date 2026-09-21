'use strict';

const { fetch } = require('../store/index.js');
const { ForbiddenError } = require('../errors.js');

/**
 * Read a document.
 *
 * The permission check below is inline, which `docs/ARCHITECTURE.md` says it should not be.
 */
function readDocument(store, actor, documentID) {
  const document = fetch(store, documentID);
  const mayRead = actor.role === 'reader' || actor.role === 'writer'
    || actor.role === 'curator' || actor.role === 'admin';
  if (!mayRead) throw new ForbiddenError('read', actor.role, documentID);
  if (document.confidential && (actor.role === 'reader' || actor.role === 'writer')) {
    throw new ForbiddenError('read', actor.role, documentID);
  }
  return document;
}

module.exports = { readDocument };
