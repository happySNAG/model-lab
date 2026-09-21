'use strict';

const { SENSITIVE_FIELDS } = require('./fields.js');
const { CREDENTIAL_FORMATS } = require('./formats.js');
const { scanLogfmt } = require('./logfmt.js');

const MASK = '[masked]';

function parseObject(line) {
  if (!line.trimStart().startsWith('{')) return undefined;
  try {
    const value = JSON.parse(line);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function maskCredentials(text) {
  return CREDENTIAL_FORMATS.reduce((out, format) => out.replace(format, MASK), text);
}

/**
 * A JSON value with personal-data fields and credentials masked, and whether anything was.
 * Keys keep their order; values nothing applies to are returned as they are.
 */
function maskValue(value) {
  if (typeof value === 'string') {
    const masked = maskCredentials(value);
    return { value: masked, changed: masked !== value };
  }
  if (Array.isArray(value)) {
    const entries = value.map(maskValue);
    return { value: entries.map((entry) => entry.value), changed: entries.some((entry) => entry.changed) };
  }
  if (value !== null && typeof value === 'object') {
    const out = {};
    let changed = false;
    for (const [key, entry] of Object.entries(value)) {
      if (SENSITIVE_FIELDS.has(key)) {
        out[key] = MASK;
        changed = true;
        continue;
      }
      const masked = maskValue(entry);
      out[key] = masked.value;
      changed = changed || masked.changed;
    }
    return { value: out, changed };
  }
  return { value, changed: false };
}

/**
 * One log line with personal data and credentials masked. docs/REDACTION.md is the contract: only
 * the masked spans change, and a line with nothing to mask comes back exactly as it arrived.
 */
function redactLine(line) {
  const object = parseObject(line);
  if (object !== undefined) {
    const masked = maskValue(object);
    return masked.changed ? JSON.stringify(masked.value) : line;
  }

  const pairs = scanLogfmt(line);
  if (pairs !== undefined) {
    let out = '';
    let cursor = 0;
    for (const pair of pairs) {
      if (!SENSITIVE_FIELDS.has(pair.key)) continue;
      out += line.slice(cursor, pair.start) + (pair.quoted ? `"${MASK}"` : MASK);
      cursor = pair.end;
    }
    return maskCredentials(out + line.slice(cursor));
  }

  return maskCredentials(line);
}

module.exports = { redactLine, MASK };
