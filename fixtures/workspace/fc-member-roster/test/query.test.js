'use strict';

// A plain Node script so the fixture needs no install, no package manager and no network.
// Exits 0 when everything holds, 1 otherwise, with one line per check on stdout.

const assert = require('node:assert');
const { membersOf, teamsIn, describe } = require('../src/query.js');

const text = [
  'handle,name,team,role,since',
  'zed,Zed Okafor,infra,lead,2024-05-01',
  'ada,Ada Byron,platform,member,2025-01-15',
  'lin,Lin Wu,platform,member,',
  '',
].join('\n');

const checks = [
  ['the members of a team, in the order written', () => {
    assert.deepStrictEqual(membersOf(text, 'platform').map((member) => member.handle), ['ada', 'lin']);
    assert.deepStrictEqual(membersOf(text, 'design'), []);
  }],
  ['the teams, in the order they first appear', () => {
    assert.deepStrictEqual(teamsIn(text), ['infra', 'platform']);
  }],
  ['one line per member, for people', () => {
    assert.deepStrictEqual(describe(text).split('\n'), [
      'Zed Okafor (zed) — lead on infra since 2024-05-01',
      'Ada Byron (ada) — member on platform since 2025-01-15',
      'Lin Wu (lin) — member on platform',
    ]);
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
