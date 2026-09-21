'use strict';

/**
 * One event applied to one state.
 *
 * `docs/REPLAY.md` states what this promises about the state it is handed.
 */
function applyEvent(state, event) {
  const next = { balanceCents: state.balanceCents, holds: [...state.holds], lastSequence: state.lastSequence };
  switch (event.kind) {
    case 'deposit':
      next.balanceCents += event.amountCents;
      break;
    case 'withdraw':
      next.balanceCents -= event.amountCents;
      break;
    case 'hold':
      next.holds = [...next.holds, event.reference];
      break;
    case 'release':
      next.holds = next.holds.filter((reference) => reference !== event.reference);
      break;
    default:
      throw new RangeError(`no such event kind: ${event.kind}`);
  }
  next.lastSequence = event.sequence;
  return next;
}

module.exports = { applyEvent };
