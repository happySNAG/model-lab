'use strict';

class SlabError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SlabError';
  }
}

module.exports = { SlabError };
