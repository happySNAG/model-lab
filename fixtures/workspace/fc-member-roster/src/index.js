'use strict';

const { readTable, writeTable } = require('./table.js');
const { ROLES, DEFAULT_ROLE, isRole } = require('./roles.js');
const { decode } = require('./decode.js');
const { encode } = require('./encode.js');
const { transfer, promote, addMember, retire } = require('./edit.js');
const { membersOf, teamsIn, describe } = require('./query.js');
const { RosterError } = require('./errors.js');

module.exports = {
  readTable, writeTable, ROLES, DEFAULT_ROLE, isRole, decode, encode,
  transfer, promote, addMember, retire, membersOf, teamsIn, describe, RosterError,
};
