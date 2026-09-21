'use strict';

const { cloneState } = require('./state.js');

/** A state, kept so a later replay need not start from nothing. */
function snapshotOf(state) {
  return { atSequence: state.lastSequence, state: cloneState(state) };
}

/** The state a snapshot holds, ready to replay from. */
function restore(snapshot) {
  return cloneState(snapshot.state);
}

module.exports = { snapshotOf, restore };
