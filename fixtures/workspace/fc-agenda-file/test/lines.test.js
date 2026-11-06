'use strict';

// A plain Node script so the fixture needs no install, no package manager and no network.
// Exits 0 when everything holds, 1 otherwise, with one line per check on stdout.

const assert = require('node:assert');
const { parseLine, formatLine } = require('../src/lines.js');
const { readComponents, writeComponents } = require('../src/components.js');

const checks = [
  ['a plain line is a name and a value', () => {
    assert.deepStrictEqual(parseLine('ROOM:Harbour'), { name: 'ROOM', parameters: {}, value: 'Harbour' });
  }],
  ['parameters sit between the name and the first colon', () => {
    assert.deepStrictEqual(parseLine('ATTENDEE;ROLE=CHAIR;RSVP=TRUE:mailto:ada@example.test'),
      { name: 'ATTENDEE', parameters: { ROLE: 'CHAIR', RSVP: 'TRUE' }, value: 'mailto:ada@example.test' });
  }],
  ['a line put back together is the line that was read', () => {
    for (const line of ['TITLE:Stand-up', 'TITLE;LANGUAGE=en-GB:Stand-up', 'X-COLOUR:#3366ff', 'DTSTART:2026-03-02T09:00']) {
      assert.strictEqual(formatLine(parseLine(line)), line);
    }
  }],
  ['a line without a colon is refused', () => {
    assert.throws(() => parseLine('just words'), /colon/);
  }],
  ['components nest, and read back in the order written', () => {
    const text = ['BEGIN:AGENDA', 'VERSION:1', 'BEGIN:EVENT', 'ID:a', 'BEGIN:ALARM', 'TRIGGER:-PT5M', 'END:ALARM',
      'END:EVENT', 'END:AGENDA', ''].join('\n');
    const root = readComponents(text);
    assert.strictEqual(root.kind, 'AGENDA');
    assert.strictEqual(root.entries[0], 'VERSION:1');
    assert.strictEqual(root.entries[1].kind, 'EVENT');
    assert.strictEqual(root.entries[1].entries[1].kind, 'ALARM');
    assert.strictEqual(writeComponents(root), text);
  }],
  ['an END that does not match its BEGIN is refused', () => {
    assert.throws(() => readComponents('BEGIN:AGENDA\nBEGIN:EVENT\nEND:AGENDA\nEND:EVENT\n'), /closes/);
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
