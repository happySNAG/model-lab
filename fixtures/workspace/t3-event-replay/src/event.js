'use strict';

/** Every kind of event this package understands. */
const EVENT_KINDS = ['deposit', 'withdraw', 'hold', 'release'];

/**
 * One thing that happened.
 *
 * `sequence` says where it belongs in the order; nothing here generates one, because a sequence
 * number is a fact about the log this event came from.
 */
function createEvent(fields) {
  if (!EVENT_KINDS.includes(fields.kind)) throw new RangeError(`no such event kind: ${fields.kind}`);
  if (!Number.isInteger(fields.sequence) || fields.sequence < 1) {
    throw new RangeError(`not a sequence number: ${fields.sequence}`);
  }
  return {
    sequence: fields.sequence,
    kind: fields.kind,
    amountCents: Number.isInteger(fields.amountCents) ? fields.amountCents : 0,
    reference: typeof fields.reference === 'string' ? fields.reference : '',
  };
}

module.exports = { EVENT_KINDS, createEvent };
