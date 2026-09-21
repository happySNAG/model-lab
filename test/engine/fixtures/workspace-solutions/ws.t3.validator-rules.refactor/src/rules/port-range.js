'use strict';

const { validationError } = require('../errors.js');

module.exports = {
  id: 'port-range',
  code: 'PORT_RANGE',
  appliesTo: 'port',
  check(configuration) {
    const config = configuration === undefined ? {} : configuration;
    const port = config.port;
    if (Number.isInteger(port) && port >= 1024 && port <= 65535) return [];
    return [validationError('port-range', 'PORT_RANGE', 'port',
      'port must be a whole number from 1024 to 65535')];
  },
};
