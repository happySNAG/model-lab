'use strict';

/** Hard-wrap a paragraph to a column width, breaking only between words. */
function wrap(text, columns) {
  if (!Number.isInteger(columns) || columns < 1) throw new RangeError(`not a column width: ${columns}`);
  const words = String(text).split(/\s+/).filter((word) => word.length > 0);
  const lines = [];
  let line = '';
  for (const word of words) {
    if (line.length === 0) {
      line = word;
    } else if (line.length + 1 + word.length <= columns) {
      line += ` ${word}`;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line.length > 0) lines.push(line);
  return lines;
}

/** The wrapped paragraph as one string. */
function wrapped(text, columns) {
  return wrap(text, columns).join('\n');
}

module.exports = { wrap, wrapped };
