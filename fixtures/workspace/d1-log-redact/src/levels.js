'use strict';

const LEVELS = ['debug', 'info', 'warn', 'error'];

/** The level a line declares, in either structured shape, or `undefined`. */
function levelOf(line) {
  const json = /"level"\s*:\s*"([a-z]+)"/.exec(line);
  if (json !== null) return json[1];
  const logfmt = /(?:^|\s)level=([a-z]+)/.exec(line);
  return logfmt === null ? undefined : logfmt[1];
}

/** Whether a line at `level` is at or above `minimum`. A line with no level always passes. */
function atLeast(level, minimum) {
  if (level === undefined || minimum === undefined) return true;
  return LEVELS.indexOf(level) >= LEVELS.indexOf(minimum);
}

module.exports = { LEVELS, levelOf, atLeast };
