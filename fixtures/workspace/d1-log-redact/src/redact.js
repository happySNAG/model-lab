'use strict';

const { SENSITIVE_FIELDS } = require('./fields.js');
const { CREDENTIAL_FORMATS } = require('./formats.js');
const { parseLogfmt, formatValue } = require('./logfmt.js');
const { maskMachineLooking } = require('./heuristics.js');

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

function maskFields(object) {
  const out = {};
  for (const [key, value] of Object.entries(object)) out[key] = SENSITIVE_FIELDS.has(key) ? MASK : value;
  return out;
}

/**
 * One log line with personal data and credentials masked. docs/REDACTION.md is the contract.
 */
function redactLine(line) {
  const object = parseObject(line);
  if (object !== undefined) return JSON.stringify(maskFields(object));

  const pairs = parseLogfmt(line);
  if (pairs !== undefined) {
    return pairs
      .map(([key, value]) => `${key}=${SENSITIVE_FIELDS.has(key) ? MASK : formatValue(maskCredentials(value))}`)
      .join(' ');
  }

  return maskMachineLooking(maskCredentials(line));
}

module.exports = { redactLine, MASK };
