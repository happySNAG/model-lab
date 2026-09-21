'use strict';

/**
 * What a document is.
 *
 * `confidential`, `locked` and `archived` are facts about the document. What they MEAN for a given
 * caller is a permission question and is not decided here.
 */
function createDocument(fields) {
  if (typeof fields.id !== 'string' || fields.id.length === 0) {
    throw new TypeError('a document needs a non-empty id');
  }
  return {
    id: fields.id,
    title: typeof fields.title === 'string' ? fields.title : '',
    body: typeof fields.body === 'string' ? fields.body : '',
    ownerID: typeof fields.ownerID === 'string' ? fields.ownerID : '',
    confidential: fields.confidential === true,
    locked: fields.locked === true,
    archived: fields.archived === true,
  };
}

/** A copy with some fields changed. Documents are values here; nothing is mutated in place. */
function withChanges(document, changes) {
  return createDocument({ ...document, ...changes, id: document.id });
}

module.exports = { createDocument, withChanges };
