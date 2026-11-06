'use strict';

// A plain Node script so the fixture needs no install, no package manager and no network.
// Exits 0 when everything holds, 1 otherwise, with one line per check on stdout.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { decode } = require('../src/decode.js');

const text = [
  'handle,name,team,role,since',
  'zed,Zed Okafor,infra,lead,2024-05-01',
  'ada,Ada Byron,platform,member,2025-01-15',
  '',
].join('\n');
const shuffled = [
  'since,handle,name,role,team',
  '2024-05-01,zed,Zed Okafor,lead,infra',
  '2025-01-15,ada,Ada Byron,member,platform',
  '',
].join('\n');
const example = fs.readFileSync(path.join(__dirname, '..', 'examples', 'platform.roster'), 'utf8');

const checks = [
  ['members read back in the order written', () => {
    assert.deepStrictEqual(decode(text), [
      { handle: 'zed', name: 'Zed Okafor', team: 'infra', role: 'lead', since: '2024-05-01' },
      { handle: 'ada', name: 'Ada Byron', team: 'platform', role: 'member', since: '2025-01-15' },
    ]);
  }],
  ['columns are found by their header, whatever order they are in', () => {
    assert.deepStrictEqual(decode(shuffled), decode(text));
  }],
  ['a reader takes what it understands and ignores the rest', () => {
    const members = decode(example);
    assert.deepStrictEqual(members.map((member) => member.handle), ['zed', 'ada', 'lin']);
    assert.deepStrictEqual(members.map((member) => member.team), ['infra', 'platform', 'platform']);
    assert.strictEqual(members[2].since, '2025-09-03');
  }],
  ['a roster without a team column is refused', () => {
    assert.throws(() => decode('handle,name\nada,Ada Byron\n'), /no team column/);
  }],
  ['two rows with one handle are refused', () => {
    assert.throws(() => decode(`${text}zed,Another Zed,infra,member,\n`), /two rows carry the handle zed/);
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
