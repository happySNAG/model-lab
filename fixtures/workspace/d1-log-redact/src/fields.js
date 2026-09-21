'use strict';

/** Fields whose values are personal data. See docs/REDACTION.md. */
const SENSITIVE_FIELDS = new Set(['email', 'phone', 'card_number', 'iban']);

module.exports = { SENSITIVE_FIELDS };
