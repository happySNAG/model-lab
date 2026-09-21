'use strict';

const { redactLine } = require('./redact.js');
const { levelOf, atLeast } = require('./levels.js');

/**
 * A block of log text, redacted line by line.
 *
 * `minimumLevel` drops lines below that level; it is the only thing that removes a line, and a
 * caller asks for it by name. Line endings are kept as they were.
 */
function redactText(text, { minimumLevel } = {}) {
  const lines = String(text).split('\n');
  const out = [];
  for (const line of lines) {
    if (!atLeast(levelOf(line), minimumLevel)) continue;
    out.push(redactLine(line));
  }
  return out.join('\n');
}

module.exports = { redactText };
