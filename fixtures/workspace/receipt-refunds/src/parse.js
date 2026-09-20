'use strict';

/** Pulls the amount out of an entry. */
const AMOUNT = /\$([0-9]+(?:\.[0-9]{1,2})?)/;

/**
 * One line of a receipt file, as a record.
 *
 * `amountCents` is a whole number of cents. This is the only place a line of text becomes a number:
 * everything downstream does arithmetic on the record and never re-reads the line.
 */
function parseLine(line) {
  const separator = line.indexOf(':');
  if (separator < 0) throw new SyntaxError(`no ':' in receipt line: ${line}`);
  const name = line.slice(0, separator).trim();
  const amount = line.slice(separator + 1).trim();
  const match = AMOUNT.exec(amount);
  if (match === null) throw new SyntaxError(`no amount in receipt line: ${line}`);
  return { name, amountCents: Math.round(Number.parseFloat(match[1]) * 100) };
}

/** Every line of a receipt, in order. Blank lines are skipped. */
function parseReceipt(lines) {
  return lines.filter((line) => line.trim().length > 0).map(parseLine);
}

module.exports = { parseLine, parseReceipt };
