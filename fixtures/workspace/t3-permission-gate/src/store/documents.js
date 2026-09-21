'use strict';

const { createDocument } = require('../model/document.js');
const { NotFoundError } = require('../errors.js');

/** The documents every store starts with. Fixed, so a run always sees the same service. */
const SEED = [
  { id: 'd1', title: 'Onboarding', body: 'How we do things.', ownerID: 'u1' },
  { id: 'd2', title: 'Salaries', body: 'Numbers.', ownerID: 'u2', confidential: true },
  { id: 'd3', title: 'Release checklist', body: 'Steps.', ownerID: 'u1', locked: true },
  { id: 'd4', title: 'Retired policy', body: 'Old.', ownerID: 'u2', archived: true },
  { id: 'd5', title: 'Roadmap', body: 'Plans.', ownerID: 'u1' },
];

/**
 * Where documents live.
 *
 * THE STORE KNOWS NOTHING ABOUT ACTORS. Every function here does what it is told; whether it should
 * have been told is settled before it is called.
 */
function createStore() {
  const documents = new Map();
  for (const fields of SEED) documents.set(fields.id, createDocument(fields));
  return { documents };
}

function fetch(store, documentID) {
  const found = store.documents.get(documentID);
  if (found === undefined) throw new NotFoundError(documentID);
  return found;
}

function put(store, document) {
  store.documents.set(document.id, document);
  return document;
}

function drop(store, documentID) {
  const document = fetch(store, documentID);
  store.documents.delete(documentID);
  return document;
}

function all(store) {
  return [...store.documents.values()];
}

module.exports = { SEED, createStore, fetch, put, drop, all };
