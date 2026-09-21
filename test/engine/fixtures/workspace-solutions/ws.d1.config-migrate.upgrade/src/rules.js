'use strict';

const { parseDuration } = require('./durations.js');

/** Kept for callers that read it; the upgrade never substitutes it for a value it cannot read. */
const DEFAULT_TIMEOUT_SECONDS = 60;

const STRATEGY_RENAMES = { 'blue-green': 'blueGreen', rolling: 'rolling', recreate: 'recreate' };

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Leave a recognised key exactly as written, and say so. */
function keepAsWritten(key, value, context, message) {
  context.warnings.add(context.path, message);
  return { [key]: value };
}

function deploySection(value, context) {
  if (!isObject(value)) return keepAsWritten('deploy', value, context, 'deploy is not an object, so it was left as written');
  const section = { ...value };
  if (Object.prototype.hasOwnProperty.call(value, 'strategy')) {
    const renamed = STRATEGY_RENAMES[value.strategy];
    if (renamed === undefined) {
      context.warnings.add(`${context.path}.strategy`, `unrecognised strategy ${JSON.stringify(value.strategy)} was left as written`);
    } else {
      section.strategy = renamed;
    }
  }
  return { deploy: section };
}

function notifySection(value, context) {
  if (!isObject(value)) return keepAsWritten('notify', value, context, 'notify is not an object, so it was left as written');
  const section = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key !== 'slack') { section[key] = entry; continue; }
    if (typeof entry !== 'string') {
      context.warnings.add(`${context.path}.slack`, 'slack is not a channel name, so it was left as written');
      section.slack = entry;
      continue;
    }
    const channels = Array.isArray(section.channels) ? section.channels : [];
    section.channels = [...channels, { kind: 'slack', target: entry }];
  }
  return { notify: section };
}

/**
 * What each version 1 key becomes in version 2.
 *
 * A rule receives the version 1 value and a context carrying the key's dotted `path` and the
 * `warnings` list, and returns the version 2 keys it produces. A value it cannot interpret comes
 * back under its version 1 name, unchanged, with a warning.
 */
const RULES = {
  name: (value) => ({ name: value }),
  region: (value) => ({ region: value }),
  timeout: (value, context) => {
    const seconds = parseDuration(value);
    return seconds === undefined
      ? keepAsWritten('timeout', value, context, `${JSON.stringify(value)} is not a duration, so it was left as written`)
      : { timeoutSeconds: seconds };
  },
  color: (value, context) => {
    if (value === true) return { color: 'always' };
    if (value === false) return { color: 'never' };
    if (value === 'auto') return { color: 'auto' };
    return keepAsWritten('color', value, context, `${JSON.stringify(value)} is not a colour setting, so it was left as written`);
  },
  deploy: (value, context) => deploySection(value, context),
  notify: (value, context) => notifySection(value, context),
};

module.exports = { RULES, DEFAULT_TIMEOUT_SECONDS };
