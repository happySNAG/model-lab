'use strict';

const { decode } = require('./decode.js');

/** The members on `team`, in the order written. */
function membersOf(text, team) {
  return decode(text).filter((member) => member.team === team);
}

/** Every team with at least one member, in the order teams first appear. */
function teamsIn(text) {
  return [...new Set(decode(text).map((member) => member.team))];
}

/** One line per member, for people: who, what they do, and where. */
function describe(text) {
  return decode(text)
    .map((member) => `${member.name} (${member.handle}) — ${member.role} on ${member.team}${member.since === '' ? '' : ` since ${member.since}`}`)
    .join('\n');
}

module.exports = { membersOf, teamsIn, describe };
