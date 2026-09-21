'use strict';

/** `HH:MM`, 24-hour, zero-padded. Nothing else is a clock time here. */
const CLOCK = /^([0-9]{2}):([0-9]{2})$/;

/** Clock text as minutes since midnight. */
function parseClock(text) {
  const match = CLOCK.exec(String(text));
  if (match === null) throw new SyntaxError(`not a clock time: ${text}`);
  const hours = Number.parseInt(match[1], 10);
  const minutes = Number.parseInt(match[2], 10);
  if (hours > 23 || minutes > 59) throw new RangeError(`not a clock time: ${text}`);
  return hours * 60 + minutes;
}

/** Minutes since midnight as clock text. */
function formatClock(minute) {
  if (!Number.isInteger(minute) || minute < 0 || minute > 24 * 60) {
    throw new RangeError(`not a minute of the day: ${minute}`);
  }
  const hours = Math.floor(minute / 60);
  return `${String(hours).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
}

module.exports = { parseClock, formatClock };
