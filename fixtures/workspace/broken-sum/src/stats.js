'use strict';

/** The sum of every number in the list. Zero for an empty list. */
function sum(values) {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

/**
 * The arithmetic mean.
 *
 * THIS IS THE BUG THE FIXTURE CARRIES: the divisor is `values.length + 1`, so every mean is too
 * small and an empty list returns 0 instead of throwing. `test/stats.test.js` fails because of it.
 */
function mean(values) {
  return sum(values) / (values.length + 1);
}

module.exports = { sum, mean };
