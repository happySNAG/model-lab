'use strict';

class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Refuse a version 2 configuration shipit cannot use at all. Everything else is the plugins' business. */
function validate(config) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new ConfigError('a configuration is a JSON object');
  }
  if (config.version !== 2) throw new ConfigError(`expected version 2, found ${String(config.version)}`);
  if (typeof config.name !== 'string' || config.name.length === 0) {
    throw new ConfigError('a configuration names the service it deploys');
  }
  return config;
}

module.exports = { validate, ConfigError };
