'use strict';

const { FIELDS, fieldAt, labelFor } = require('./schema.js');
const { validationError } = require('./errors.js');
const { DEFAULT_CONFIGURATION, withDefaults } = require('./defaults.js');
const { validate, isValid } = require('./validate.js');
const { renderError, renderErrors, countByCode } = require('./report.js');
const { describeRules } = require('./explain.js');

/** The public API. A consumer of this package never reaches past this file into `src/`. */
module.exports = {
  FIELDS, fieldAt, labelFor,
  validationError,
  DEFAULT_CONFIGURATION, withDefaults,
  validate, isValid,
  renderError, renderErrors, countByCode,
  describeRules,
};
