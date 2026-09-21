'use strict';

const { RULES, listRules } = require('./rules/index.js');

/**
 * The validator: a driver over the registry.
 *
 * It makes no decision about any field. Every condition in `docs/RULES.md` lives in the rule module
 * that owns it, and the order the errors come back in is the registry's order.
 */
function validate(configuration) {
  return RULES.flatMap((rule) => rule.check(configuration));
}

/** Whether a configuration breaks nothing. */
function isValid(configuration) {
  return validate(configuration).length === 0;
}

module.exports = { validate, isValid, listRules };
