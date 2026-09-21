'use strict';

const { labelFor } = require('./schema.js');

/** One error, as a line a person reads. */
function renderError(error) {
  return `${error.code}  ${labelFor(error.path)} (${error.path}): ${error.message}`;
}

/** Every error, one per line, or a sentence saying there were none. */
function renderErrors(errors) {
  if (errors.length === 0) return 'the configuration is valid';
  return errors.map(renderError).join('\n');
}

/** How many errors there were, by code, in the order the codes first appeared. */
function countByCode(errors) {
  const counts = {};
  for (const error of errors) counts[error.code] = (counts[error.code] || 0) + 1;
  return counts;
}

module.exports = { renderError, renderErrors, countByCode };
