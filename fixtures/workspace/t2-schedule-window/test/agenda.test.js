'use strict';

// A plain Node script so the fixture needs no install, no package manager and no network.
// Exits 0 when everything holds, 1 otherwise, with one line per check on stdout.

const assert = require('node:assert');
const { createSchedule, book } = require('../src/schedule.js');
const { bookedMinutes, renderBooking, renderAgenda } = require('../src/agenda.js');

function scheduleOf(...bookings) {
  const schedule = createSchedule('oak');
  for (const [title, startText, endText] of bookings) book(schedule, title, startText, endText);
  return schedule;
}

const checks = [
  ['a booking line says how long the booking runs for', () => {
    const schedule = scheduleOf(['Standup', '09:00', '10:00']);
    assert.strictEqual(renderBooking(schedule.bookings[0]), '09:00–10:00  Standup (1 hour)');
  }],
  ['a shorter booking says so', () => {
    const schedule = scheduleOf(['Standup', '09:00', '09:15']);
    assert.strictEqual(renderBooking(schedule.bookings[0]), '09:00–09:15  Standup (15 minutes)');
  }],
  ['the booked total is the sum of the bookings', () => {
    const schedule = scheduleOf(['Standup', '09:00', '09:15'], ['Review', '10:00', '11:00']);
    assert.strictEqual(bookedMinutes(schedule), 75);
  }],
  ['the agenda ends with how much of the day was booked', () => {
    const schedule = scheduleOf(['Standup', '09:00', '09:15'], ['Review', '10:00', '11:00']);
    assert.strictEqual(renderAgenda(schedule), [
      '09:00–09:15  Standup (15 minutes)',
      '10:00–11:00  Review (1 hour)',
      'booked 1 hour 15 minutes',
    ].join('\n'));
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
