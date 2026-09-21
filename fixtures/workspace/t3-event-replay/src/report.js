'use strict';

/** Whole cents as the string a person reads. */
function formatCents(cents) {
  return `${cents < 0 ? '-' : ''}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

/** A state as a person reads it. */
function renderState(state) {
  const holds = state.holds.length === 0 ? 'no holds' : `holds ${state.holds.join(', ')}`;
  return `balance ${formatCents(state.balanceCents)} · ${holds} · through event ${state.lastSequence}`;
}

module.exports = { formatCents, renderState };
