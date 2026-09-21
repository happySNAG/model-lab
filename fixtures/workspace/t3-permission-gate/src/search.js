'use strict';

/**
 * Finding documents by title.
 *
 * Takes documents that have already been handed to it. No actor, no decision.
 */
function titleMatches(document, query) {
  const needle = String(query).trim().toLowerCase();
  if (needle.length === 0) return false;
  return document.title.toLowerCase().includes(needle);
}

/** Every document whose title matches, in the order they were given. */
function searchByTitle(documents, query) {
  return documents.filter((document) => titleMatches(document, query));
}

/** Documents by title, case-insensitively, ties keeping the order they were given in. */
function sortedByTitle(documents) {
  return documents
    .map((document, index) => ({ document, index, key: document.title.toLowerCase() }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.index - b.index))
    .map((entry) => entry.document);
}

module.exports = { titleMatches, searchByTitle, sortedByTitle };
