'use strict';

/**
 * Parameters as a query string. See docs/QUERY.md.
 *
 * Values are strings; each key and value is percent-encoded on its own.
 */
function encodeQuery(parameters) {
  const pairs = [];
  for (const [key, value] of Object.entries(parameters)) {
    pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return pairs.join('&');
}

/** A query string as parameters. A `+` is a space; a pair without `=` has an empty value. */
function decodeQuery(text) {
  const parameters = {};
  for (const pair of String(text).replace(/^\?/, '').split('&')) {
    if (pair.length === 0) continue;
    const equals = pair.indexOf('=');
    const rawKey = equals === -1 ? pair : pair.slice(0, equals);
    const rawValue = equals === -1 ? '' : pair.slice(equals + 1);
    const key = decodeURIComponent(rawKey.replace(/\+/g, ' '));
    parameters[key] = decodeURIComponent(rawValue.replace(/\+/g, ' '));
  }
  return parameters;
}

module.exports = { encodeQuery, decodeQuery };
