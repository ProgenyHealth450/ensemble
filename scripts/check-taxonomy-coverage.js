#!/usr/bin/env node
'use strict';
/**
 * Taxonomy coverage check CLI (TRD-2026-8d825f54 TRD-048). Exit 0 = every tool maps to
 * exactly one category, no unmapped command in a shared source's fenced shell block, and
 * every category has an existing default adapter; exit 1 otherwise.
 */
const path = require('path');
const { checkCoverage } = require('./lib/taxonomy-coverage');

function main(root = path.resolve(__dirname, '..')) {
  const { errors, scanned } = checkCoverage(root);
  console.log(`Taxonomy coverage: ${scanned} source file(s) scanned.`);
  for (const err of errors) {
    const where = err.file ? path.relative(root, err.file) + (err.line ? `:${err.line}` : '') + ' ' : '';
    console.log(`${where}${err.class} ${err.message}`);
  }
  process.exit(errors.length > 0 ? 1 : 0);
}

module.exports = { main };

if (require.main === module) {
  main();
}
