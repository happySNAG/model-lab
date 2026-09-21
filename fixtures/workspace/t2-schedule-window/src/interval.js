'use strict';

const { parseClock, formatClock } = require('./timeparse.js');
const { minutesBetween } = require('./duration.js');

/**
 * A booking window.
 *
 * THE ONLY CONSTRUCTOR. `startMinute` is the first minute inside the window and `endMinute` is the
 * first minute after it — `docs/RULES.md` states the convention. The length comes from
 * `src/duration.js`, which is where this package works a duration out.
 */
function createInterval(startText, endText) {
  const startMinute = parseClock(startText);
  const minutes = minutesBetween(startMinute, parseClock(endText));
  return {
    startText,
    endText,
    startMinute,
    endMinute: startMinute + minutes,
    minutes,
  };
}

/** The window as a person reads it. */
function describeInterval(interval) {
  return `${formatClock(interval.startMinute)}–${interval.endText}`;
}

module.exports = { createInterval, describeInterval };
