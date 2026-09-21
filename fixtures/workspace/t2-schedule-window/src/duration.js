'use strict';

/**
 * The package's duration arithmetic.
 *
 * THE ONLY PLACE A LENGTH OF TIME IS WORKED OUT. `docs/RULES.md` states the window convention these
 * two functions answer under, and everything that needs a duration asks here rather than
 * subtracting minute marks of its own.
 */

/** How long the window `[startMinute, endMinute)` runs for, in whole minutes. */
function minutesBetween(startMinute, endMinute) {
  if (!Number.isInteger(startMinute) || !Number.isInteger(endMinute)) {
    throw new TypeError('a minute mark is a whole number of minutes since midnight');
  }
  if (endMinute < startMinute) throw new RangeError('a window cannot end before it starts');
  return endMinute - startMinute + 1;
}

/** A length of time, the way a person says it. */
function durationLabel(minutes) {
  if (!Number.isInteger(minutes) || minutes < 0) throw new RangeError(`not a length of time: ${minutes}`);
  if (minutes === 0) return 'no time';
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const parts = [];
  if (hours > 0) parts.push(`${hours} hour${hours === 1 ? '' : 's'}`);
  if (rest > 0) parts.push(`${rest} minute${rest === 1 ? '' : 's'}`);
  return parts.join(' ');
}

module.exports = { minutesBetween, durationLabel };
