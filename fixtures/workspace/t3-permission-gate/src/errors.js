'use strict';

/** A caller asked for something its role does not allow. `docs/AUTHZ.md` is the table. */
class ForbiddenError extends Error {
  constructor(action, role, documentID) {
    super(`a ${role} may not ${action} document ${documentID}`);
    this.name = 'ForbiddenError';
    this.action = action;
    this.role = role;
    this.documentID = documentID;
  }
}

/** A caller asked for an action this service does not have. */
class UnknownActionError extends Error {
  constructor(action) {
    super(`no such action: ${action}`);
    this.name = 'UnknownActionError';
    this.action = action;
  }
}

/** A caller named a document that is not there. */
class NotFoundError extends Error {
  constructor(documentID) {
    super(`no such document: ${documentID}`);
    this.name = 'NotFoundError';
    this.documentID = documentID;
  }
}

/** A caller asked for something that cannot be done to this document whoever is asking. */
class ConflictError extends Error {
  constructor(message, documentID) {
    super(message);
    this.name = 'ConflictError';
    this.documentID = documentID;
  }
}

module.exports = { ForbiddenError, UnknownActionError, NotFoundError, ConflictError };
