'use strict';

const { ForbiddenError, UnknownActionError } = require('../errors.js');
const { ROLES, GRANTS, NARROWED_BY_CONFIDENTIALITY, NARROWED_BY_LOCK } = require('./roles.js');

const ACTIONS = ['read', 'update', 'delete', 'export', 'archive'];

function authorize(actor, action, resource) {
  if (!ACTIONS.includes(action)) throw new UnknownActionError(action);
  const role = actor.role;
  const refuse = () => {
    throw new ForbiddenError(action, role, resource.id);
  };
  if (!ROLES.includes(role)) refuse();
  if (!GRANTS[role].includes(action)) refuse();
  if (action === 'read' && resource.confidential && NARROWED_BY_CONFIDENTIALITY.includes(role)) refuse();
  if (action === 'update' && resource.locked && NARROWED_BY_LOCK.includes(role)) refuse();
  return undefined;
}

module.exports = { ACTIONS, authorize };
