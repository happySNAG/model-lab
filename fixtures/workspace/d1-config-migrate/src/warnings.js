'use strict';

/**
 * The things the person who wrote a configuration file should be told about.
 *
 * Collected rather than printed: `load.js` decides how they are shown, and a caller embedding shipit
 * may want them as data.
 */
function createWarnings() {
  const list = [];
  return {
    list,
    add(path, message) {
      list.push({ path, message });
    },
  };
}

module.exports = { createWarnings };
