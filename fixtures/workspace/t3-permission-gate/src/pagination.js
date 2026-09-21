'use strict';

/** One page of a list: which items, and where the reader is. */
function pageOf(items, pageNumber, pageSize) {
  if (!Number.isInteger(pageNumber) || pageNumber < 1) throw new RangeError(`not a page number: ${pageNumber}`);
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new RangeError(`not a page size: ${pageSize}`);
  const start = (pageNumber - 1) * pageSize;
  return {
    items: items.slice(start, start + pageSize),
    pageNumber,
    pageSize,
    pageCount: Math.max(1, Math.ceil(items.length / pageSize)),
    total: items.length,
  };
}

/** The page as a person reads it. */
function describePage(page) {
  return `page ${page.pageNumber} of ${page.pageCount} (${page.items.length} of ${page.total})`;
}

module.exports = { pageOf, describePage };
