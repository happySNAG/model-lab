'use strict';

/**
 * A logical clock.
 *
 * NOTHING IN THIS PACKAGE READS THE MACHINE'S CLOCK. Time here is a counter the caller advances, so
 * a sequence of calls always produces the same answer however fast or slow it is run.
 */
function createClock() {
  let tick = 0;
  return {
    now() {
      return tick;
    },
    advance(ticks) {
      if (!Number.isInteger(ticks) || ticks < 0) throw new RangeError(`not a number of ticks: ${ticks}`);
      tick += ticks;
      return tick;
    },
  };
}

module.exports = { createClock };
