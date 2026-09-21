'use strict';

const { validationError } = require('../errors.js');

/** 1-40 characters of lowercase letters, digits and hyphens, starting with a letter. */
const NAME = /^[a-z][a-z0-9-]{0,39}$/;

module.exports = {
  id: 'name-format',
  code: 'NAME_FORMAT',
  appliesTo: 'name',
  check(configuration) {
    const config = configuration === undefined ? {} : configuration;
    if (typeof config.name === 'string' && NAME.test(config.name)) return [];
    return [validationError('name-format', 'NAME_FORMAT', 'name',
      'name must be 1-40 characters of lowercase letters, digits and hyphens')];
  },
};
