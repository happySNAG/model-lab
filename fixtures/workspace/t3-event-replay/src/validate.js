'use strict';

const { EVENT_KINDS } = require('./event.js');

/** Every way one event can be malformed, as a list of sentences. Empty means it is well formed. */
function problemsWith(event) {
  const problems = [];
  if (!EVENT_KINDS.includes(event.kind)) problems.push(`no such event kind: ${event.kind}`);
  if (!Number.isInteger(event.sequence) || event.sequence < 1) {
    problems.push(`not a sequence number: ${event.sequence}`);
  }
  if ((event.kind === 'deposit' || event.kind === 'withdraw') && event.amountCents <= 0) {
    problems.push(`a ${event.kind} needs a positive amount`);
  }
  if ((event.kind === 'hold' || event.kind === 'release') && event.reference.length === 0) {
    problems.push(`a ${event.kind} needs a reference`);
  }
  return problems;
}

/** Whether every event in a log is well formed, and what is wrong with the ones that are not. */
function problemsWithLog(events) {
  return events.flatMap((event) => problemsWith(event).map((problem) => `event ${event.sequence}: ${problem}`));
}

module.exports = { problemsWith, problemsWithLog };
