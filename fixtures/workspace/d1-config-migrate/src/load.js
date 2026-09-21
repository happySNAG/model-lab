'use strict';

const { upgrade } = require('./upgrade.js');
const { validate, ConfigError } = require('./validate.js');

/**
 * The configuration in a file's text, as version 2, with anything the author should know about.
 *
 * A file with no `version`, or `"version": 1`, is upgraded; a version 2 file is used as it is.
 */
function loadConfig(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`the configuration is not valid JSON: ${error.message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigError('a configuration is a JSON object');
  }
  const version = parsed.version === undefined ? 1 : parsed.version;
  if (version === 2) return { config: validate(parsed), warnings: [] };
  if (version !== 1) throw new ConfigError(`this shipit reads versions 1 and 2, not ${String(version)}`);
  const { config, warnings } = upgrade(parsed);
  return { config: validate(config), warnings };
}

module.exports = { loadConfig };
