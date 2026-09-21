'use strict';

const { loadConfig } = require('./load.js');
const { upgrade } = require('./upgrade.js');
const { parseDuration } = require('./durations.js');

module.exports = { loadConfig, upgrade, parseDuration };
