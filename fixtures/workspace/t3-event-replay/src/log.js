'use strict';

const { createEvent } = require('./event.js');

/** A log built from plain descriptions, numbered in the order they were given. */
function logOf(descriptions) {
  return descriptions.map((description, index) => createEvent({ ...description, sequence: index + 1 }));
}

/** A copy of the log with one more event at the end. */
function appended(events, description) {
  const next = events.reduce((highest, event) => Math.max(highest, event.sequence), 0) + 1;
  return [...events, createEvent({ ...description, sequence: next })];
}

/** The log as it would arrive out of a queue: reversed, which is still the same log. */
function shuffledForTransport(events) {
  return [...events].reverse();
}

module.exports = { logOf, appended, shuffledForTransport };
