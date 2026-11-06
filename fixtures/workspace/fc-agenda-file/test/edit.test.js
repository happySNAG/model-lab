'use strict';

// A plain Node script so the fixture needs no install, no package manager and no network.
// Exits 0 when everything holds, 1 otherwise, with one line per check on stdout.

const assert = require('node:assert');
const { encode } = require('../src/encode.js');
const { decode } = require('../src/decode.js');
const { reschedule, rename, cancel } = require('../src/edit.js');
const { eventsOn } = require('../src/query.js');
const { AgendaError } = require('../src/errors.js');

const text = encode({
  name: 'Platform team',
  events: [
    { id: 'standup', title: 'Stand-up', start: '2026-03-02T09:00', end: '2026-03-02T09:15', room: 'Harbour' },
    { id: 'review', title: 'Design review', start: '2026-03-02T14:00', end: '2026-03-02T15:30' },
  ],
});
const eventIn = (agenda, id) => decode(agenda).events.find((event) => event.id === id);

const checks = [
  ['rescheduling moves the start and keeps the duration', () => {
    const moved = eventIn(reschedule(text, 'standup', '2026-03-03T10:30'), 'standup');
    assert.strictEqual(moved.start, '2026-03-03T10:30');
    assert.strictEqual(moved.end, '2026-03-03T10:45');
    assert.strictEqual(moved.room, 'Harbour');
  }],
  ['renaming replaces the title', () => {
    assert.strictEqual(eventIn(rename(text, 'review', 'Design crit'), 'review').title, 'Design crit');
  }],
  ['cancelling keeps the event on the agenda, marked cancelled', () => {
    const cancelled = cancel(text, 'standup');
    assert.strictEqual(decode(cancelled).events.length, 2);
    assert.strictEqual(eventIn(cancelled, 'standup').status, 'CANCELLED');
    assert.deepStrictEqual(eventsOn(cancelled, '2026-03-02').map((event) => event.id), ['standup', 'review']);
  }],
  ['editing leaves the other events alone', () => {
    const before = eventIn(text, 'review');
    const edited = cancel(rename(reschedule(text, 'standup', '2026-03-03T10:30'), 'standup', 'Daily'), 'standup');
    assert.deepStrictEqual(eventIn(edited, 'review'), before);
  }],
  ['an event that is not on the agenda is refused', () => {
    assert.throws(() => rename(text, 'lunch', 'Lunch'), AgendaError);
    assert.throws(() => reschedule(text, 'lunch', '2026-03-02T12:00'), AgendaError);
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
