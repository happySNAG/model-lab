'use strict';

const { RULES } = require('./rules.js');
const { createWarnings } = require('./warnings.js');

/**
 * A version 1 configuration, upgraded to version 2.
 *
 * `docs/MIGRATION.md` is the contract. Returns the upgraded configuration and the warnings the
 * person who wrote the file should see.
 */
function upgrade(v1) {
  const warnings = createWarnings();
  const v2 = { version: 2 };
  for (const [key, rule] of Object.entries(RULES)) {
    if (!Object.prototype.hasOwnProperty.call(v1, key)) continue;
    Object.assign(v2, rule(v1[key], { path: key, warnings }));
  }
  return { config: v2, warnings: warnings.list };
}

module.exports = { upgrade };
