'use strict';

class AgendaError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AgendaError';
  }
}

module.exports = { AgendaError };
