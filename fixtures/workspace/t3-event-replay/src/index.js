'use strict';

const { EVENT_KINDS, createEvent } = require('./event.js');
const { problemsWith, problemsWithLog } = require('./validate.js');
const { createState, cloneState, statesEqual } = require('./state.js');
const { applyEvent } = require('./apply.js');
const { inOrder, isContiguous } = require('./order.js');
const { replay, replayUpTo, tailAfter } = require('./replay.js');
const { snapshotOf, restore } = require('./snapshot.js');
const { logOf, appended, shuffledForTransport } = require('./log.js');
const { formatCents, renderState } = require('./report.js');
const { countByKind, describeLog } = require('./summary.js');

/** The public API. A consumer of this package never reaches past this file into `src/`. */
module.exports = {
  EVENT_KINDS, createEvent,
  problemsWith, problemsWithLog,
  createState, cloneState, statesEqual,
  applyEvent,
  inOrder, isContiguous,
  replay, replayUpTo, tailAfter,
  snapshotOf, restore,
  logOf, appended, shuffledForTransport,
  formatCents, renderState,
  countByKind, describeLog,
};
