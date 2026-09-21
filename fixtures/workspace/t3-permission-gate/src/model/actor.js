'use strict';

/**
 * Who is asking.
 *
 * An actor is an id and a role. What a role may do is not decided here — see `docs/AUTHZ.md`.
 */
function createActor(fields) {
  if (typeof fields.id !== 'string' || fields.id.length === 0) {
    throw new TypeError('an actor needs a non-empty id');
  }
  if (typeof fields.role !== 'string' || fields.role.length === 0) {
    throw new TypeError('an actor needs a role');
  }
  return { id: fields.id, role: fields.role };
}

module.exports = { createActor };
