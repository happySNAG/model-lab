'use strict';

/**
 * Text to rows.
 *
 * Commas separate, double quotes group, and a doubled quote inside a quoted field is one quote.
 * Blank lines are skipped. Line endings may be `\n` or `\r\n`.
 */
function parseCSV(text) {
  const rows = [];
  for (const rawLine of String(text).split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.trim().length === 0) continue;
    rows.push(parseLine(line));
  }
  return rows;
}

function parseLine(line) {
  const cells = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quoted) {
      if (character === '"' && line[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        cell += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ',') {
      cells.push(cell);
      cell = '';
    } else {
      cell += character;
    }
  }
  cells.push(cell);
  return cells;
}

module.exports = { parseCSV, parseLine };
