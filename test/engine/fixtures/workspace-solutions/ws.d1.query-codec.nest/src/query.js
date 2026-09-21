'use strict';

/**
 * Parameters as a query string, and back. docs/QUERY.md is the format.
 *
 * Every key and every leaf value is percent-encoded on its own, so the only brackets, `=` and `&`
 * left in the text are the ones this module wrote as structure.
 */
function encodeQuery(parameters) {
  const pairs = [];
  const write = (name, value) => {
    if (Array.isArray(value)) {
      for (const element of value) write(`${name}[]`, element);
    } else if (value !== null && typeof value === 'object') {
      for (const [key, entry] of Object.entries(value)) write(`${name}[${encodeURIComponent(key)}]`, entry);
    } else {
      pairs.push(`${name}=${encodeURIComponent(String(value))}`);
    }
  };
  for (const [key, value] of Object.entries(parameters)) write(encodeURIComponent(key), value);
  return pairs.join('&');
}

/** Marks an empty `[]` in a name: an array element, as opposed to a key. */
const APPEND = Symbol('append');

/** `+` is a space, and it is replaced before percent-decoding so an encoded `+` stays a `+`. */
const decodeComponent = (text) => decodeURIComponent(text.replace(/\+/g, ' '));

/**
 * A raw name as its top-level key and the path below it. The brackets are found BEFORE anything is
 * decoded, so an encoded bracket is part of a key. A name whose brackets are not well formed is one
 * flat key.
 */
function parseName(rawName) {
  const open = rawName.indexOf('[');
  if (open <= 0) return { key: decodeComponent(rawName), path: [] };
  const path = [];
  let rest = rawName.slice(open);
  while (rest.length > 0) {
    const segment = /^\[([^[\]]*)\]/.exec(rest);
    if (segment === null) return { key: decodeComponent(rawName), path: [] };
    path.push(segment[1] === '' ? APPEND : decodeComponent(segment[1]));
    rest = rest.slice(segment[0].length);
  }
  return { key: decodeComponent(rawName.slice(0, open)), path };
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function setOwn(target, key, value) {
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}

/** Put `value` at `keys` under `container`, making the objects and arrays the path asks for. */
function place(container, keys, value) {
  let target = container;
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index];
    const last = index === keys.length - 1;
    if (key === APPEND) {
      if (last) target.push(value);
      return;
    }
    if (last) {
      setOwn(target, key, value);
      return;
    }
    const wantsArray = keys[index + 1] === APPEND;
    const existing = Object.prototype.hasOwnProperty.call(target, key) ? target[key] : undefined;
    if (wantsArray ? !Array.isArray(existing) : !isPlainObject(existing)) setOwn(target, key, wantsArray ? [] : {});
    target = target[key];
  }
}

/** A query string as parameters. A `+` is a space; a pair without `=` has an empty value. */
function decodeQuery(text) {
  const parameters = {};
  for (const pair of String(text).replace(/^\?/, '').split('&')) {
    if (pair.length === 0) continue;
    const equals = pair.indexOf('=');
    const rawName = equals === -1 ? pair : pair.slice(0, equals);
    const rawValue = equals === -1 ? '' : pair.slice(equals + 1);
    const { key, path } = parseName(rawName);
    place(parameters, [key, ...path], decodeComponent(rawValue));
  }
  return parameters;
}

module.exports = { encodeQuery, decodeQuery };
