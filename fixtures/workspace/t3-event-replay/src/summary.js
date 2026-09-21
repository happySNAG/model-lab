'use strict';

const { EVENT_KINDS } = require('./event.js');

/** How many events of each kind a log holds, in the order the kinds are declared. */
function countByKind(events) {
  const counts = {};
  for (const kind of EVENT_KINDS) counts[kind] = 0;
  for (const event of events) counts[event.kind] += 1;
  return counts;
}

/** The counts as a person reads them, leaving out the kinds that never happened. */
function describeLog(events) {
  const counts = countByKind(events);
  const parts = EVENT_KINDS.filter((kind) => counts[kind] > 0).map((kind) => `${counts[kind]} ${kind}`);
  return parts.length === 0 ? 'nothing happened' : parts.join(', ');
}

module.exports = { countByKind, describeLog };
