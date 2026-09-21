'use strict';

const nameFormat = require('./name-format.js');
const replicaCount = require('./replica-count.js');
const portRange = require('./port-range.js');
const imageTag = require('./image-tag.js');
const envNames = require('./env-names.js');
const limitsPresent = require('./limits-present.js');

/** The rules, in the order docs/RULES.md lists them. This list is the order. */
const RULES = [nameFormat, replicaCount, portRange, imageTag, envNames, limitsPresent];

function listRules() {
  return RULES.map((rule) => rule.id);
}

module.exports = { RULES, listRules };
