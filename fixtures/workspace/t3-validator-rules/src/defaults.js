'use strict';

/** The configuration a caller gets when it names nothing. It satisfies every rule. */
const DEFAULT_CONFIGURATION = {
  name: 'service',
  replicas: 1,
  port: 8080,
  image: 'registry.example/service:1.0.0',
  env: {},
  limits: { cpuMilli: 250, memoryMiB: 128 },
};

/** A configuration with the defaults filled in underneath whatever the caller named. */
function withDefaults(configuration) {
  const named = configuration === undefined ? {} : configuration;
  return {
    ...DEFAULT_CONFIGURATION,
    ...named,
    env: { ...DEFAULT_CONFIGURATION.env, ...(named.env || {}) },
    limits: { ...DEFAULT_CONFIGURATION.limits, ...(named.limits || {}) },
  };
}

module.exports = { DEFAULT_CONFIGURATION, withDefaults };
