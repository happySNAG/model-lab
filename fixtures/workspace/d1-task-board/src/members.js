'use strict';

function createMembers(names) {
  return new Set(names);
}

function isMember(members, name) {
  return members.has(name);
}

module.exports = { createMembers, isMember };
