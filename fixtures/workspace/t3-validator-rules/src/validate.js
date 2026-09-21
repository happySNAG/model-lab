'use strict';

const { validationError } = require('./errors.js');

/**
 * The validator.
 *
 * `docs/RULES.md` is what this promises a caller. `docs/ARCHITECTURE.md` is how the six rules below
 * are meant to be arranged, and this file does not match it: every rule is a branch of one chain,
 * and the order they come back in is the order they happen to be written here.
 */
const NAME = /^[a-z][a-z0-9-]{0,39}$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

function validate(configuration) {
  const errors = [];
  const config = configuration === undefined ? {} : configuration;

  if (typeof config.name !== 'string' || !NAME.test(config.name)) {
    errors.push(validationError('name-format', 'NAME_FORMAT', 'name',
      'name must be 1-40 characters of lowercase letters, digits and hyphens'));
  }

  if (!Number.isInteger(config.replicas) || config.replicas < 1 || config.replicas > 20) {
    errors.push(validationError('replica-count', 'REPLICA_COUNT', 'replicas',
      'replicas must be a whole number from 1 to 20'));
  }

  if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) {
    errors.push(validationError('port-range', 'PORT_RANGE', 'port',
      'port must be a whole number from 1024 to 65535'));
  }

  const image = typeof config.image === 'string' ? config.image : '';
  const separator = image.lastIndexOf(':');
  const tag = separator > image.lastIndexOf('/') ? image.slice(separator + 1) : '';
  if (tag.length === 0 || tag === 'latest') {
    errors.push(validationError('image-tag', 'IMAGE_TAG', 'image',
      'image must name an explicit tag other than latest'));
  }

  const env = config.env === undefined || config.env === null ? {} : config.env;
  for (const name of Object.keys(env)) {
    if (!ENV_NAME.test(name)) {
      errors.push(validationError('env-names', 'ENV_NAME', `env.${name}`,
        'environment variable names must be upper-case letters, digits and underscores'));
    }
  }

  const limits = config.limits === undefined || config.limits === null ? {} : config.limits;
  const cpuMilli = limits.cpuMilli;
  const memoryMiB = limits.memoryMiB;
  if (!Number.isInteger(cpuMilli) || cpuMilli <= 0
    || !Number.isInteger(memoryMiB) || memoryMiB < 64) {
    errors.push(validationError('limits-present', 'LIMITS', 'limits',
      'cpu and memory limits are required, and memory must be at least 64 MiB'));
  }

  return errors;
}

/** Whether a configuration breaks nothing. */
function isValid(configuration) {
  return validate(configuration).length === 0;
}

module.exports = { validate, isValid };
