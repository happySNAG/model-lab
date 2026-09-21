'use strict';

const { parseURL } = require('./url.js');
const { listIssues, showIssue } = require('./handlers.js');

const ROUTES = [
  { pattern: /^\/issues$/, handler: (parameters) => listIssues(parameters) },
  { pattern: /^\/issues\/(\d+)$/, handler: (parameters, groups) => showIssue(parameters, { id: groups[1] }) },
];

/** What handling a request URL produces, or `null` when no route matches. */
function route(url) {
  const { path, parameters } = parseURL(url);
  for (const { pattern, handler } of ROUTES) {
    const groups = pattern.exec(path);
    if (groups !== null) return handler(parameters, groups);
  }
  return null;
}

module.exports = { route };
