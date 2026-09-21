'use strict';

const { createState } = require('./state.js');
const { applyEvent } = require('./apply.js');
const { inOrder } = require('./order.js');

/**
 * A log applied to a starting state.
 *
 * This function relies on `applyEvent` answering with a new state rather than changing the one it
 * was given — see `docs/REPLAY.md`. It does not defend against an `applyEvent` that does not, and
 * it is not supposed to have to.
 */
function replay(events, from) {
  let state = from === undefined ? createState() : from;
  for (const event of inOrder(events)) {
    state = applyEvent(state, event);
  }
  return state;
}

/** The state after the events up to and including `sequence`. */
function replayUpTo(events, sequence, from) {
  return replay(events.filter((event) => event.sequence <= sequence), from);
}

/** The events after `sequence`, in the order they happened. */
function tailAfter(events, sequence) {
  return inOrder(events.filter((event) => event.sequence > sequence));
}

module.exports = { replay, replayUpTo, tailAfter };
