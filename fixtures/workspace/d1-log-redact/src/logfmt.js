'use strict';

const KEY = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

/**
 * A logfmt line as `[key, value]` pairs, or `undefined` when the line is not logfmt.
 *
 * A value containing spaces is double-quoted; the quotes are not part of the value.
 */
function parseLogfmt(line) {
  const tokens = line.trim().split(/\s+/).filter((token) => token.length > 0);
  if (tokens.length === 0) return undefined;
  const pairs = [];
  for (const token of tokens) {
    const equals = token.indexOf('=');
    if (equals <= 0) return undefined;
    const key = token.slice(0, equals);
    if (!KEY.test(key)) return undefined;
    let value = token.slice(equals + 1);
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1);
    pairs.push([key, value]);
  }
  return pairs;
}

/** A value as it would be written: quoted when it contains a space. */
function formatValue(value) {
  return /\s/.test(value) ? `"${value}"` : value;
}

module.exports = { parseLogfmt, formatValue };
