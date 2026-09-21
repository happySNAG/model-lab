'use strict';

const { fetch } = require('../store/index.js');
const { authorize } = require('../authz/policy.js');

/** Read a document. */
function readDocument(store, actor, documentID) {
  const document = fetch(store, documentID);
  authorize(actor, 'read', document);
  return document;
}

module.exports = { readDocument };
