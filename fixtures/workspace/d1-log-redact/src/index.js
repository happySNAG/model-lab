'use strict';

const { redactLine, MASK } = require('./redact.js');
const { redactText } = require('./pipeline.js');
const { SENSITIVE_FIELDS } = require('./fields.js');
const { CREDENTIAL_FORMATS } = require('./formats.js');

module.exports = { redactLine, redactText, MASK, SENSITIVE_FIELDS, CREDENTIAL_FORMATS };
