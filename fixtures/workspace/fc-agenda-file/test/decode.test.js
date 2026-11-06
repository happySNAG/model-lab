'use strict';

// A plain Node script so the fixture needs no install, no package manager and no network.
// Exits 0 when everything holds, 1 otherwise, with one line per check on stdout.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { decode } = require('../src/decode.js');
const { eventsOn, describe } = require('../src/query.js');

const text = [
  'BEGIN:AGENDA', 'VERSION:1', 'NAME:Platform team',
  'BEGIN:EVENT', 'ID:standup', 'TITLE:Stand-up', 'DTSTART:2026-03-02T09:00', 'DTEND:2026-03-02T09:15', 'ROOM:Harbour', 'END:EVENT',
  'BEGIN:EVENT', 'ID:review', 'TITLE:Design review', 'DTSTART:2026-03-02T14:00', 'DTEND:2026-03-02T15:30', 'STATUS:CANCELLED', 'END:EVENT',
  'END:AGENDA', '',
].join('\n');
const example = fs.readFileSync(path.join(__dirname, '..', 'examples', 'team.agenda'), 'utf8');

const checks = [
  ['an agenda reads into its name and its events', () => {
    const agenda = decode(text);
    assert.strictEqual(agenda.name, 'Platform team');
    assert.deepStrictEqual(agenda.events.map((event) => event.id), ['standup', 'review']);
    assert.strictEqual(agenda.events[0].room, 'Harbour');
    assert.strictEqual(agenda.events[0].status, 'CONFIRMED');
    assert.strictEqual(agenda.events[1].status, 'CANCELLED');
  }],
  ['a reader takes what it understands and ignores the rest', () => {
    const agenda = decode(example);
    assert.deepStrictEqual(agenda.events.map((event) => event.id), ['standup', 'review']);
    assert.strictEqual(agenda.events[0].room, 'Harbour');
    assert.strictEqual(agenda.events[1].title, 'Design review');
  }],
  ['the events on a day come back earliest first', () => {
    assert.deepStrictEqual(eventsOn(text, '2026-03-02').map((event) => event.id), ['standup', 'review']);
    assert.deepStrictEqual(eventsOn(text, '2026-03-03'), []);
    assert.strictEqual(describe(text).split('\n')[1], '2026-03-02T14:00 Design review — cancelled');
  }],
  ['an event without a DTEND is refused', () => {
    const cut = text.replace('DTEND:2026-03-02T09:15\n', '');
    assert.throws(() => decode(cut), /DTEND/);
  }],
  ['an event that ends before it starts is refused', () => {
    const backwards = text.replace('DTEND:2026-03-02T09:15', 'DTEND:2026-03-02T08:15');
    assert.throws(() => decode(backwards), /before/);
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
