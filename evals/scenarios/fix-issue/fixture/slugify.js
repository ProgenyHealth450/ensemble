'use strict';

function slugify(text) {
  if (typeof text !== 'string') return '';
  // BUG: does not collapse runs of separators or trim edges.
  return text.toLowerCase().replace(/[^a-z0-9]/g, '-');
}

module.exports = { slugify };
