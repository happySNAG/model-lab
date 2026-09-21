'use strict';

/**
 * The credential formats this organisation issues. See docs/REDACTION.md.
 *
 * Each is a global expression, so it can be used with `String.prototype.replace` directly.
 */
const CREDENTIAL_FORMATS = [
  // Personal access tokens: `acme_pat_` and 24 letters or digits.
  /\bacme_pat_[A-Za-z0-9]{24}\b/g,
  // Service keys: `acme_sk_` and 32 lowercase hexadecimal digits.
  /\bacme_sk_[0-9a-f]{32}\b/g,
];

module.exports = { CREDENTIAL_FORMATS };
