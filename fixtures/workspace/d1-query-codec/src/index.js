'use strict';

const { encodeQuery, decodeQuery } = require('./query.js');
const { buildURL, parseURL } = require('./url.js');
const { pageLinks, filterLink } = require('./links.js');
const { route } = require('./router.js');

module.exports = { encodeQuery, decodeQuery, buildURL, parseURL, pageLinks, filterLink, route };
