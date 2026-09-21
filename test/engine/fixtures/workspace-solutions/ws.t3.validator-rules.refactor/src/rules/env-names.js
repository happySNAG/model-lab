'use strict';

const { validationError } = require('../errors.js');

/** Upper-case letters, digits and underscores, starting with a letter. */
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

module.exports = {
  id: 'env-names',
  code: 'ENV_NAME',
  appliesTo: 'env',
  check(configuration) {
    const config = configuration === undefined ? {} : configuration;
    const env = config.env === undefined || config.env === null ? {} : config.env;
    return Object.keys(env)
      .filter((name) => !ENV_NAME.test(name))
      .map((name) => validationError('env-names', 'ENV_NAME', `env.${name}`,
        'environment variable names must be upper-case letters, digits and underscores'));
  },
};
