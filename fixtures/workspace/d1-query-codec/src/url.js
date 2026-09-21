'use strict';

const { encodeQuery, decodeQuery } = require('./query.js');

/** A path with its parameters. A URL with no parameters carries no `?`. */
function buildURL(path, parameters = {}) {
  const query = encodeQuery(parameters);
  return query.length === 0 ? path : `${path}?${query}`;
}

/** A URL's path and parameters. Anything after `#` is not sent to the server and is ignored. */
function parseURL(url) {
  const withoutFragment = String(url).split('#')[0];
  const question = withoutFragment.indexOf('?');
  if (question === -1) return { path: withoutFragment, parameters: {} };
  return { path: withoutFragment.slice(0, question), parameters: decodeQuery(withoutFragment.slice(question + 1)) };
}

module.exports = { buildURL, parseURL };
