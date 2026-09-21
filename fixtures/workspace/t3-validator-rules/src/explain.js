'use strict';

const { labelFor } = require('./schema.js');

/**
 * What this package checks, as data a caller can print.
 *
 * A SECOND CONSUMER OF THE SAME LIST. `validate` runs the rules and this describes them, and the two
 * must never be able to disagree about which rules exist or what order they come in — a caller
 * shown a list of six checks and given errors from a seventh has been told something false.
 *
 * `docs/ARCHITECTURE.md` says where that one list lives.
 */
const DESCRIPTIONS = [
  { id: 'name-format', code: 'NAME_FORMAT', appliesTo: 'name' },
  { id: 'replica-count', code: 'REPLICA_COUNT', appliesTo: 'replicas' },
  { id: 'port-range', code: 'PORT_RANGE', appliesTo: 'port' },
  { id: 'image-tag', code: 'IMAGE_TAG', appliesTo: 'image' },
  { id: 'env-names', code: 'ENV_NAME', appliesTo: 'env' },
  { id: 'limits-present', code: 'LIMITS', appliesTo: 'limits' },
];

/** One line per rule, in the order the rules run. */
function describeRules() {
  return DESCRIPTIONS.map((rule) => `${rule.id}  ${labelFor(rule.appliesTo)} (${rule.appliesTo})  ${rule.code}`);
}

module.exports = { describeRules };
