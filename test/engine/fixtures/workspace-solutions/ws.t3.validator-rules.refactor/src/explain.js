'use strict';

const { labelFor } = require('./schema.js');
const { RULES } = require('./rules/index.js');

/**
 * What this package checks, as data a caller can print.
 *
 * Read from the registry, so this and `validate` can never disagree about what runs.
 */
function describeRules() {
  return RULES.map((rule) => `${rule.id}  ${labelFor(rule.appliesTo)} (${rule.appliesTo})  ${rule.code}`);
}

module.exports = { describeRules };
