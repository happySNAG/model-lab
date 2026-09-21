'use strict';

/** What an account looks like at a moment. */
function createState() {
  return { balanceCents: 0, holds: [], lastSequence: 0 };
}

/** A copy that shares nothing with the original. */
function cloneState(state) {
  return {
    balanceCents: state.balanceCents,
    holds: [...state.holds],
    lastSequence: state.lastSequence,
  };
}

/** Whether two states say the same thing. */
function statesEqual(left, right) {
  return left.balanceCents === right.balanceCents
    && left.lastSequence === right.lastSequence
    && left.holds.length === right.holds.length
    && left.holds.every((reference, index) => reference === right.holds[index]);
}

module.exports = { createState, cloneState, statesEqual };
