'use strict';

const { validationError } = require('../errors.js');

module.exports = {
  id: 'limits-present',
  code: 'LIMITS',
  appliesTo: 'limits',
  check(configuration) {
    const config = configuration === undefined ? {} : configuration;
    const limits = config.limits === undefined || config.limits === null ? {} : config.limits;
    if (Number.isInteger(limits.cpuMilli) && limits.cpuMilli > 0
      && Number.isInteger(limits.memoryMiB) && limits.memoryMiB >= 64) return [];
    return [validationError('limits-present', 'LIMITS', 'limits',
      'cpu and memory limits are required, and memory must be at least 64 MiB')];
  },
};
