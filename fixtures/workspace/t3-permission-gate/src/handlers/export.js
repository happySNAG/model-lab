'use strict';

const { fetch } = require('../store/index.js');
const { renderDocument } = require('../render.js');

/**
 * Hand a document out as text a caller can take away.
 *
 * `docs/AUTHZ.md` has a column for this action.
 */
function exportDocument(store, actor, documentID) {
  const document = fetch(store, documentID);
  return renderDocument(document);
}

module.exports = { exportDocument };
