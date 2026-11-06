'use strict';

// A plain Node script so the fixture needs no install, no package manager and no network.
// Exits 0 when everything holds, 1 otherwise, with one line per check on stdout.

const assert = require('node:assert');
const { decode } = require('../src/decode.js');
const { transfer, promote, addMember, retire } = require('../src/edit.js');
const { RosterError } = require('../src/errors.js');

const text = [
  'handle,name,team,role,since',
  'zed,Zed Okafor,infra,lead,2024-05-01',
  'ada,Ada Byron,platform,member,2025-01-15',
  'lin,Lin Wu,platform,member,2025-09-03',
  '',
].join('\n');
const handles = (roster) => decode(roster).map((member) => member.handle);
const memberIn = (roster, handle) => decode(roster).find((member) => member.handle === handle);

const checks = [
  ['transferring moves one member and keeps every row where it was', () => {
    const moved = transfer(text, 'ada', 'infra');
    assert.strictEqual(memberIn(moved, 'ada').team, 'infra');
    assert.strictEqual(memberIn(moved, 'lin').team, 'platform');
    assert.deepStrictEqual(handles(moved), ['zed', 'ada', 'lin']);
  }],
  ['promoting sets the role, maintainer included', () => {
    assert.strictEqual(memberIn(promote(text, 'lin', 'maintainer'), 'lin').role, 'maintainer');
    assert.strictEqual(memberIn(promote(text, 'ada', 'lead'), 'ada').role, 'lead');
  }],
  ['a new member goes at the end, with the default role', () => {
    const grown = addMember(text, { handle: 'sam', name: 'Sam Reyes', team: 'infra' });
    assert.deepStrictEqual(handles(grown), ['zed', 'ada', 'lin', 'sam']);
    assert.deepStrictEqual(memberIn(grown, 'sam'), { handle: 'sam', name: 'Sam Reyes', team: 'infra', role: 'member', since: '' });
  }],
  ['retiring removes one member', () => {
    assert.deepStrictEqual(handles(retire(text, 'zed')), ['ada', 'lin']);
  }],
  ['a handle that is not on the roster is refused', () => {
    assert.throws(() => transfer(text, 'sam', 'infra'), RosterError);
    assert.throws(() => retire(text, 'sam'), RosterError);
  }],
  ['a role that does not exist is refused', () => {
    assert.throws(() => promote(text, 'ada', 'emperor'), /not a role/);
    assert.throws(() => addMember(text, { handle: 'sam', name: 'Sam Reyes', team: 'infra', role: 'emperor' }), /not a role/);
  }],
  ['a second row for a handle is refused', () => {
    assert.throws(() => addMember(text, { handle: 'ada', name: 'Ada Again', team: 'infra' }), /already/);
  }],
];

let failed = 0;
for (const [name, check] of checks) {
  try {
    check();
    console.log(`ok - ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`not ok - ${name}: ${error.message}`);
  }
}
console.log(`${checks.length - failed}/${checks.length} passed`);
process.exit(failed === 0 ? 0 : 1);
