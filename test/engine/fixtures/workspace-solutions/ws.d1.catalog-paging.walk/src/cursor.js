'use strict';

class InvalidCursorError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidCursorError';
  }
}

/** The opaque text a caller holds for a place in the listing: the sort key of a product. */
function encodeCursor(product) {
  return Buffer.from(JSON.stringify({ rank: product.rank, id: product.id }), 'utf8').toString('base64url');
}

/** The place a cursor stands for, as `{ rank, id }`. Refuses text this package did not produce. */
function decodeCursor(text) {
  if (typeof text !== 'string' || text.length === 0) throw new InvalidCursorError('a cursor is a non-empty string');
  let position;
  try {
    position = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidCursorError('this is not a cursor this catalogue issued');
  }
  if (position === null || typeof position !== 'object' || Array.isArray(position)
    || typeof position.rank !== 'number' || typeof position.id !== 'string') {
    throw new InvalidCursorError('this is not a cursor this catalogue issued');
  }
  return { rank: position.rank, id: position.id };
}

module.exports = { encodeCursor, decodeCursor, InvalidCursorError };
