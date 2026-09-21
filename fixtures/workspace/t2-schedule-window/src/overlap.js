'use strict';

/**
 * Whether two windows share a minute.
 *
 * Half-open, as `docs/RULES.md` says: each window runs from its first minute up to but not
 * including its last. Two windows that merely touch share nothing.
 */
function intervalsOverlap(a, b) {
  return a.startMinute < b.endMinute && b.startMinute < a.endMinute;
}

/** How many minutes two windows share. Zero when they do not overlap. */
function overlapMinutes(a, b) {
  const start = Math.max(a.startMinute, b.startMinute);
  const end = Math.min(a.endMinute, b.endMinute);
  return end > start ? end - start : 0;
}

module.exports = { intervalsOverlap, overlapMinutes };
