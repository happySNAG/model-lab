'use strict';

const { parseDuration } = require('./durations.js');

/** Used when a timeout cannot be read. */
const DEFAULT_TIMEOUT_SECONDS = 60;

const STRATEGIES = ['rolling', 'recreate', 'blueGreen'];

function deploySection(value) {
  const section = {};
  if (typeof value.strategy === 'string') {
    section.strategy = STRATEGIES.includes(value.strategy) ? value.strategy : 'rolling';
  }
  if (value.maxSurge !== undefined) section.maxSurge = value.maxSurge;
  return { deploy: section };
}

function notifySection(value) {
  const section = {};
  if (Array.isArray(value.channels)) section.channels = value.channels;
  return { notify: section };
}

/**
 * What each version 1 key becomes in version 2.
 *
 * A rule receives the version 1 value and a context carrying the key's dotted `path` and the
 * `warnings` list, and returns the version 2 keys it produces.
 */
const RULES = {
  name: (value) => ({ name: value }),
  region: (value) => ({ region: value }),
  timeout: (value) => {
    const seconds = parseDuration(value);
    return { timeoutSeconds: seconds === undefined ? DEFAULT_TIMEOUT_SECONDS : seconds };
  },
  deploy: (value) => deploySection(value),
  notify: (value) => notifySection(value),
};

module.exports = { RULES, DEFAULT_TIMEOUT_SECONDS };
