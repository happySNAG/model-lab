'use strict';

const { buildURL } = require('./url.js');

/** Previous and next links for a paged listing, keeping every other parameter as it was. */
function pageLinks(path, parameters, page, pageCount) {
  const at = (number) => buildURL(path, { ...parameters, page: String(number) });
  return {
    previous: page > 1 ? at(page - 1) : null,
    next: page < pageCount ? at(page + 1) : null,
  };
}

/** A link to a listing narrowed by a filter, starting again from its first page. */
function filterLink(path, parameters, filter) {
  const { page, ...rest } = parameters;
  return buildURL(path, { ...rest, filter });
}

module.exports = { pageLinks, filterLink };
