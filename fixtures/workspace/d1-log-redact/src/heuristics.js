'use strict';

/** A run of characters long enough, and mixed enough, to look machine-generated. */
const MACHINE_LOOKING = /[A-Za-z0-9_-]{20,}/g;

function looksMachineGenerated(token) {
  return /[A-Za-z]/.test(token) && /[0-9]/.test(token);
}

/** The text with every machine-looking token replaced by `[masked]`. */
function maskMachineLooking(text) {
  return text.replace(MACHINE_LOOKING, (token) => (looksMachineGenerated(token) ? '[masked]' : token));
}

module.exports = { looksMachineGenerated, maskMachineLooking };
