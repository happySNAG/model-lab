'use strict';

const KEY = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const SPACE = /\s/;

/**
 * A logfmt line as `{ key, value, start, end, quoted }` entries, or `undefined` when the line is not
 * logfmt. `start` and `end` delimit the value exactly as it is written, quotes included, so a caller
 * can replace one value without touching anything else on the line.
 */
function scanLogfmt(line) {
  const pairs = [];
  let index = 0;
  while (index < line.length) {
    while (index < line.length && SPACE.test(line[index])) index += 1;
    if (index >= line.length) break;
    const keyStart = index;
    while (index < line.length && line[index] !== '=' && !SPACE.test(line[index])) index += 1;
    if (line[index] !== '=') return undefined;
    const key = line.slice(keyStart, index);
    if (!KEY.test(key)) return undefined;
    index += 1;
    const start = index;
    let value = '';
    let quoted = false;
    if (line[index] === '"') {
      quoted = true;
      index += 1;
      while (index < line.length && line[index] !== '"') {
        if (line[index] === '\\' && index + 1 < line.length) { value += line[index + 1]; index += 2; continue; }
        value += line[index];
        index += 1;
      }
      if (index >= line.length) return undefined;
      index += 1;
      if (index < line.length && !SPACE.test(line[index])) return undefined;
    } else {
      while (index < line.length && !SPACE.test(line[index])) index += 1;
      value = line.slice(start, index);
    }
    pairs.push({ key, value, start, end: index, quoted });
  }
  return pairs.length === 0 ? undefined : pairs;
}

/**
 * A logfmt line as `[key, value]` pairs, or `undefined` when the line is not logfmt.
 *
 * A value containing spaces is double-quoted; the quotes are not part of the value.
 */
function parseLogfmt(line) {
  const pairs = scanLogfmt(line);
  return pairs === undefined ? undefined : pairs.map(({ key, value }) => [key, value]);
}

/** A value as it would be written: quoted when it contains a space. */
function formatValue(value) {
  return /\s/.test(value) ? `"${value}"` : value;
}

module.exports = { scanLogfmt, parseLogfmt, formatValue };
