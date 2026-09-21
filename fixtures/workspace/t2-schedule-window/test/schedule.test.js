'use strict';

// A plain Node script so the fixture needs no install, no package manager and no network.
// Exits 0 when everything holds, 1 otherwise, with one line per check on stdout.

const assert = require('node:assert');
const { createSchedule, book, conflictsOf } = require('../src/schedule.js');

function scheduleOf(...bookings) {
  const schedule = createSchedule('oak');
  for (const [title, startText, endText] of bookings) book(schedule, title, startText, endText);
  return schedule;
}

const checks = [
  ['back-to-back bookings are not a conflict', () => {
    const schedule = scheduleOf(['Standup', '09:00', '10:00'], ['Review', '10:00', '11:00']);
    assert.deepStrictEqual(conflictsOf(schedule), []);
  }],
  ['a whole morning of back-to-back bookings is not a conflict', () => {
    const schedule = scheduleOf(
      ['Standup', '09:00', '09:15'], ['Design', '09:15', '10:00'],
      ['Review', '10:00', '11:00'], ['Lunch', '11:00', '12:00'],
    );
    assert.deepStrictEqual(conflictsOf(schedule), []);
  }],
  ['bookings that share one minute ARE a conflict', () => {
    const schedule = scheduleOf(['Standup', '09:00', '10:00'], ['Review', '09:59', '11:00']);
    assert.deepStrictEqual(conflictsOf(schedule), [{ first: 'Standup', second: 'Review' }]);
  }],
  ['bookings that genuinely overlap are a conflict', () => {
    const schedule = scheduleOf(['Standup', '09:00', '10:00'], ['Review', '09:30', '10:30']);
    assert.deepStrictEqual(conflictsOf(schedule), [{ first: 'Standup', second: 'Review' }]);
  }],
  ['each conflicting pair is reported once', () => {
    const schedule = scheduleOf(
      ['Standup', '09:00', '10:00'], ['Review', '09:30', '10:30'], ['Design', '13:00', '14:00'],
    );
    assert.deepStrictEqual(conflictsOf(schedule), [{ first: 'Standup', second: 'Review' }]);
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
