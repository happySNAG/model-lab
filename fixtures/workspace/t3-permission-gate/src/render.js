'use strict';

/**
 * A document as text.
 *
 * Takes a document that has already been handed to it. No actor, no decision — see
 * `docs/ARCHITECTURE.md`.
 */
function renderDocument(document) {
  const flags = [];
  if (document.confidential) flags.push('confidential');
  if (document.locked) flags.push('locked');
  if (document.archived) flags.push('archived');
  const header = flags.length > 0 ? `${document.title} [${flags.join(' ')}]` : document.title;
  return `${header}\n\n${document.body}`;
}

/** A one-line summary, for a list. */
function summarizeDocument(document) {
  return `${document.id}  ${document.title}`;
}

module.exports = { renderDocument, summarizeDocument };
