'use strict';

const { decode } = require('./decode.js');
const { encode } = require('./encode.js');
const { DEFAULT_ROLE, isRole } = require('./roles.js');
const { RosterError } = require('./errors.js');

const HANDLE = /^[a-z][a-z0-9-]*$/;

function memberOf(members, handle) {
  const member = members.find((entry) => entry.handle === handle);
  if (member === undefined) throw new RosterError(`no member ${handle}`);
  return member;
}

/** The same roster with `handle` on `team`. See "Editing a roster" in docs/FORMAT.md. */
function transfer(text, handle, team) {
  const members = decode(text);
  memberOf(members, handle).team = team;
  return encode(members);
}

/** The same roster with `handle` holding `role`. */
function promote(text, handle, role) {
  if (!isRole(role)) throw new RosterError(`${role} is not a role`);
  const members = decode(text);
  memberOf(members, handle).role = role;
  return encode(members);
}

/** The same roster with one more member: `{ handle, name, team, role?, since? }`. */
function addMember(text, member) {
  if (!HANDLE.test(member.handle ?? '')) throw new RosterError(`"${member.handle}" is not a handle`);
  const role = member.role ?? DEFAULT_ROLE;
  if (!isRole(role)) throw new RosterError(`${role} is not a role`);
  const members = decode(text);
  if (members.some((entry) => entry.handle === member.handle)) throw new RosterError(`${member.handle} is already on the roster`);
  return encode([...members, { handle: member.handle, name: member.name, team: member.team, role, since: member.since ?? '' }]);
}

/** The same roster without `handle`. */
function retire(text, handle) {
  const members = decode(text);
  memberOf(members, handle);
  return encode(members.filter((entry) => entry.handle !== handle));
}

module.exports = { transfer, promote, addMember, retire };
