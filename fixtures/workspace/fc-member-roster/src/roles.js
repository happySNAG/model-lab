'use strict';

/** The roles docs/ROLES.md names, and the one a new member gets when none is given. */
const ROLES = ['member', 'lead'];
const DEFAULT_ROLE = 'member';

function isRole(text) {
  return ROLES.includes(text);
}

module.exports = { ROLES, DEFAULT_ROLE, isRole };
