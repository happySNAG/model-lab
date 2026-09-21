'use strict';

const UNIT_SECONDS = { s: 1, m: 60, h: 3600 };

/**
 * A duration in whole seconds, or `undefined` when the value is not one.
 *
 * Accepts a non-negative whole number of seconds, or a string such as `"90s"`, `"2m"` or `"1h"`.
 */
function parseDuration(value) {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= 0 ? value : undefined;
  }
  if (typeof value !== 'string') return undefined;
  const match = /^(\d+)([a-z])$/.exec(value.trim());
  if (match === null) return undefined;
  const unit = UNIT_SECONDS[match[2]];
  if (unit === undefined) return undefined;
  return Number(match[1]) * unit;
}

module.exports = { parseDuration };
