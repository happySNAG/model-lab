'use strict';

const { parseClock, formatClock } = require('./timeparse.js');
const { minutesBetween, durationLabel } = require('./duration.js');
const { createInterval, describeInterval } = require('./interval.js');
const { intervalsOverlap, overlapMinutes } = require('./overlap.js');
const { createSchedule, book, conflictsOf } = require('./schedule.js');
const { bookedMinutes, renderBooking, renderAgenda } = require('./agenda.js');
const { ROOMS, roomByID, roomsSeating, describeRoom } = require('./room.js');
const { createAttendee, displayName, sortedByDisplayName } = require('./attendee.js');

/** The public API. A consumer of this package never reaches past this file into `src/`. */
module.exports = {
  parseClock,
  formatClock,
  minutesBetween,
  durationLabel,
  createInterval,
  describeInterval,
  intervalsOverlap,
  overlapMinutes,
  createSchedule,
  book,
  conflictsOf,
  bookedMinutes,
  renderBooking,
  renderAgenda,
  ROOMS,
  roomByID,
  roomsSeating,
  describeRoom,
  createAttendee,
  displayName,
  sortedByDisplayName,
};
