'use strict';

/**
 * One event applied to one state.
 *
 * `docs/REPLAY.md` states what this promises about the state it is handed.
 */
function applyEvent(state, event) {
  switch (event.kind) {
    case 'deposit':
      state.balanceCents += event.amountCents;
      break;
    case 'withdraw':
      state.balanceCents -= event.amountCents;
      break;
    case 'hold':
      state.holds.push(event.reference);
      break;
    case 'release':
      state.holds = state.holds.filter((reference) => reference !== event.reference);
      break;
    default:
      throw new RangeError(`no such event kind: ${event.kind}`);
  }
  state.lastSequence = event.sequence;
  return state;
}

module.exports = { applyEvent };
