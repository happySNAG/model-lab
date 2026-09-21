'use strict';

/**
 * A validation error.
 *
 * `docs/RULES.md` states the four fields and what each one carries. This is the only place one is
 * built, so every error in this package has the same shape.
 */
function validationError(rule, code, path, message) {
  return { rule, code, path, message };
}

module.exports = { validationError };
