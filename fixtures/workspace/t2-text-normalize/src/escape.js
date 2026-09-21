'use strict';

const REPLACEMENTS = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Text, safe to embed between HTML tags or inside an attribute. */
function escapeHTML(text) {
  return String(text).replace(/[&<>"']/g, (character) => REPLACEMENTS[character]);
}

module.exports = { escapeHTML };
