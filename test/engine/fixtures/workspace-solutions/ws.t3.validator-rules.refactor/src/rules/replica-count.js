'use strict';

const { validationError } = require('../errors.js');

module.exports = {
  id: 'replica-count',
  code: 'REPLICA_COUNT',
  appliesTo: 'replicas',
  check(configuration) {
    const config = configuration === undefined ? {} : configuration;
    const replicas = config.replicas;
    if (Number.isInteger(replicas) && replicas >= 1 && replicas <= 20) return [];
    return [validationError('replica-count', 'REPLICA_COUNT', 'replicas',
      'replicas must be a whole number from 1 to 20')];
  },
};
