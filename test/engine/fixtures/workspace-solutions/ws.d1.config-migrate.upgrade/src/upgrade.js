'use strict';

const { RULES } = require('./rules.js');
const { createWarnings } = require('./warnings.js');

/**
 * A version 1 configuration, upgraded to version 2.
 *
 * `docs/MIGRATION.md` is the contract. Every key is visited in the order it was written: a key a
 * rule recognises is replaced by what the rule produces, and a key nothing recognises is carried
 * across as it is. Returns the upgraded configuration and the warnings the author should see.
 */
function upgrade(v1) {
  const warnings = createWarnings();
  const v2 = { version: 2 };
  for (const [key, value] of Object.entries(v1)) {
    if (key === 'version') continue;
    const rule = Object.prototype.hasOwnProperty.call(RULES, key) ? RULES[key] : undefined;
    if (rule === undefined) {
      v2[key] = value;
      continue;
    }
    Object.assign(v2, rule(value, { path: key, warnings }));
  }
  return { config: v2, warnings: warnings.list };
}

module.exports = { upgrade };
