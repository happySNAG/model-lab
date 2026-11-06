'use strict';

// A plain Node script so the fixture needs no install, no package manager and no network.
// Exits 0 when everything holds, 1 otherwise, with one line per check on stdout.

const assert = require('node:assert');
const { readTable, writeTable } = require('../src/table.js');

const text = ['handle,name,team', '# the core team', 'ada,Ada Byron,platform', 'lin,Lin Wu,platform', ''].join('\n');

const checks = [
  ['a table reads into its header and its lines, in order', () => {
    const table = readTable(text);
    assert.deepStrictEqual(table.header, ['handle', 'name', 'team']);
    assert.deepStrictEqual(table.entries, [
      { kind: 'comment', text: '# the core team' },
      { kind: 'row', cells: ['ada', 'Ada Byron', 'platform'] },
      { kind: 'row', cells: ['lin', 'Lin Wu', 'platform'] },
    ]);
  }],
  ['a table written out is the text that was read', () => {
    assert.strictEqual(writeTable(readTable(text)), text);
  }],
  ['an empty cell is a cell', () => {
    assert.deepStrictEqual(readTable('a,b,c\n1,,3\n').entries[0].cells, ['1', '', '3']);
  }],
  ['a row with the wrong number of cells is refused', () => {
    assert.throws(() => readTable('handle,name\nada,Ada Byron,platform\n'), /3 cell\(s\) under a header of 2/);
  }],
  ['a file that does not start with its header is refused', () => {
    assert.throws(() => readTable('# nothing here\n'), /header/);
    assert.throws(() => readTable(''), /header/);
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
