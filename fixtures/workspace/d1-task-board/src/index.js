'use strict';

const board = require('./board.js');
const errors = require('./errors.js');

module.exports = { ...board, ...errors };
