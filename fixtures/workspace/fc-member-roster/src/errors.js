'use strict';

class RosterError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RosterError';
  }
}

module.exports = { RosterError };
