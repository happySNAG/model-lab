'use strict';

const { decode } = require('./decode.js');

/** The events that start on `date` (`YYYY-MM-DD`), earliest first, cancelled ones included. */
function eventsOn(text, date) {
  return decode(text).events
    .filter((event) => event.start.startsWith(`${date}T`))
    .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
}

/** One line per event, for people: when, what, where, and whether it is still on. */
function describe(text) {
  return decode(text).events
    .map((event) => `${event.start} ${event.title}`
      + `${event.room === undefined ? '' : ` (${event.room})`}`
      + `${event.status === 'CANCELLED' ? ' — cancelled' : ''}`)
    .join('\n');
}

module.exports = { eventsOn, describe };
