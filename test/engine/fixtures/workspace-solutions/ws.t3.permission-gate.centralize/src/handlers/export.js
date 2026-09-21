'use strict';

const { fetch } = require('../store/index.js');
const { authorize } = require('../authz/policy.js');
const { renderDocument } = require('../render.js');

/** Hand a document out as text a caller can take away. */
function exportDocument(store, actor, documentID) {
  const document = fetch(store, documentID);
  authorize(actor, 'export', document);
  return renderDocument(document);
}

module.exports = { exportDocument };
