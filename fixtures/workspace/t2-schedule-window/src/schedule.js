'use strict';

const { createInterval } = require('./interval.js');
const { intervalsOverlap } = require('./overlap.js');

/** A room's bookings for one day, in the order they were made. */
function createSchedule(roomID) {
  return { roomID, bookings: [] };
}

/** Book a window. The booking is recorded whether or not it conflicts; conflicts are reported. */
function book(schedule, title, startText, endText) {
  const booking = { title, interval: createInterval(startText, endText) };
  schedule.bookings.push(booking);
  return booking;
}

/**
 * Every pair of bookings that shares a minute, in the order the later one was made.
 *
 * Each conflicting pair is reported once, as `{ first, second }`.
 */
function conflictsOf(schedule) {
  const conflicts = [];
  for (let later = 1; later < schedule.bookings.length; later += 1) {
    for (let earlier = 0; earlier < later; earlier += 1) {
      if (intervalsOverlap(schedule.bookings[earlier].interval, schedule.bookings[later].interval)) {
        conflicts.push({ first: schedule.bookings[earlier].title, second: schedule.bookings[later].title });
      }
    }
  }
  return conflicts;
}

module.exports = { createSchedule, book, conflictsOf };
