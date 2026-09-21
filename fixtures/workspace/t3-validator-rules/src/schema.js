'use strict';

/**
 * The fields a service configuration has.
 *
 * `path` is what an error about this field carries, and what `src/report.js` prints. Nothing here
 * says whether a value is acceptable; that is what the rules are for.
 */
const FIELDS = [
  { path: 'name', label: 'service name' },
  { path: 'replicas', label: 'replica count' },
  { path: 'port', label: 'listening port' },
  { path: 'image', label: 'container image' },
  { path: 'env', label: 'environment' },
  { path: 'limits', label: 'resource limits' },
];

function fieldAt(path) {
  return FIELDS.find((field) => field.path === path);
}

/** The label a person reads for a path, falling back to the path itself. */
function labelFor(path) {
  const field = fieldAt(String(path).split('.')[0]);
  return field === undefined ? String(path) : field.label;
}

module.exports = { FIELDS, fieldAt, labelFor };
