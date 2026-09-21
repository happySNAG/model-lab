'use strict';

const { durationLabel } = require('./duration.js');
const { describeInterval } = require('./interval.js');

/** How many minutes of the day the bookings occupy, counting each booking once. */
function bookedMinutes(schedule) {
  return schedule.bookings.reduce((total, booking) => total + booking.interval.minutes, 0);
}

/** One booking, as a line of the agenda. */
function renderBooking(booking) {
  return `${describeInterval(booking.interval)}  ${booking.title} (${durationLabel(booking.interval.minutes)})`;
}

/** The day a person reads: every booking in the order it was made, then how much was booked. */
function renderAgenda(schedule) {
  const lines = schedule.bookings.map(renderBooking);
  lines.push(`booked ${durationLabel(bookedMinutes(schedule))}`);
  return lines.join('\n');
}

module.exports = { bookedMinutes, renderBooking, renderAgenda };
