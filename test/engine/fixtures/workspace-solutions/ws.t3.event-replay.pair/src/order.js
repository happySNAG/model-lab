'use strict';

/**
 * Events in the order they happened.
 *
 * `docs/REPLAY.md` states what this promises about the list it is handed and the order it answers
 * with.
 */
function inOrder(events) {
  return [...events].sort((a, b) => a.sequence - b.sequence);
}

/** Whether a log has every sequence number from 1 to its length, once each. */
function isContiguous(events) {
  const seen = new Set(events.map((event) => event.sequence));
  if (seen.size !== events.length) return false;
  for (let sequence = 1; sequence <= events.length; sequence += 1) {
    if (!seen.has(sequence)) return false;
  }
  return true;
}

module.exports = { inOrder, isContiguous };
