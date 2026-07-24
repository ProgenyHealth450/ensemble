'use strict';

/**
 * TRD-005: resume-detection scan for /ensemble:author-playwright-tests.
 *
 * Scans cribs.e2e.tests' *.spec.ts files for the per-AC "@hash:" tag this
 * repo's own Gherkin generator already uses (see
 * packages/product/lib/feature-gen.js renderScenario(), which emits
 * "@AC-001-1 @hash:<12-hex>" above each Scenario:). TRD-015's
 * traceability-tagger.js is the sibling module that *writes* this tag once a
 * test is confirmed and landed; this module only *reads* it, so an
 * interrupted authoring session can resume without re-proposing tests for
 * ACs that are already confirmed.
 *
 * Tag shape in a .spec.ts file (TypeScript has no Gherkin comment line, so
 * the tag lives in a `//` comment directly above, or on the same line as,
 * the AC id it belongs to):
 *
 *   // @AC-001-1 @hash:abcdef123456
 *   test('...', async ({ page }) => { ... });
 *
 * Matching rule (deliberately simple): an AC id (AC-NNN, AC-NNN-M, or
 * AC-NNNa shape, matching packages/development/lib/trd-parser.js's
 * AC_ID_RE) is "confirmed" if a `@hash:<hex>` tag appears on the same line
 * as the AC id, or on the line immediately before/after it. Anything else
 * is "pending".
 *
 * Pure matching logic (findTaggedAcIds) takes text, not files — the disk
 * I/O is isolated to the thin scanConfirmedAcsInFiles wrapper below.
 */

const fs = require('fs');

// Mirrors packages/development/lib/trd-parser.js's AC_ID_RE shape.
const AC_ID_RE = /\bAC-\d+(?:-\d+|[a-z])?\b/gi;
const HASH_TAG_RE = /@hash:[0-9a-f]+/i;

/**
 * Find every AC id in `specText` that is tagged with an adjacent `@hash:`
 * marker (same line, or the line directly before/after).
 *
 * @param {string} specText - contents of one .spec.ts file
 * @returns {Set<string>} uppercased AC ids confirmed by a @hash: tag
 */
function findTaggedAcIds(specText) {
  const lines = String(specText || '').split(/\r\n|\r|\n/);
  const confirmed = new Set();

  lines.forEach((line, i) => {
    const acMatches = line.match(AC_ID_RE);
    if (!acMatches) return;

    const hasHash =
      HASH_TAG_RE.test(line) ||
      HASH_TAG_RE.test(lines[i - 1] || '') ||
      HASH_TAG_RE.test(lines[i + 1] || '');

    if (!hasHash) return;
    for (const id of acMatches) confirmed.add(id.toUpperCase());
  });

  return confirmed;
}

/**
 * Resume-detection scan: given the spec file text(s) already on disk and
 * the AC ids the session expects to cover, report which ACs already have a
 * confirmed, landed test (tagged with @hash:) vs. which are still pending
 * and need to be proposed this session.
 *
 * @param {string|string[]} specTexts - one spec file's text, or an array of them
 * @param {string[]} expectedAcIds - all AC ids the session expects to cover
 * @returns {{confirmed: string[], pending: string[]}}
 */
function scanConfirmedAcs(specTexts, expectedAcIds) {
  const texts = Array.isArray(specTexts) ? specTexts : [specTexts];
  const confirmedSet = new Set();
  for (const text of texts) {
    for (const id of findTaggedAcIds(text)) confirmedSet.add(id);
  }

  const expected = (expectedAcIds || []).map((id) => String(id).toUpperCase());
  return {
    confirmed: expected.filter((id) => confirmedSet.has(id)),
    pending: expected.filter((id) => !confirmedSet.has(id)),
  };
}

/**
 * File-reading wrapper: scan actual *.spec.ts files on disk (e.g. a glob
 * over cribs.e2e.tests) rather than in-memory text.
 *
 * @param {string[]} specFilePaths - paths to .spec.ts files
 * @param {string[]} expectedAcIds - all AC ids the session expects to cover
 * @param {object} [opts]
 * @param {(p: string) => string} [opts.readFileSync] - injectable file reader, for tests
 * @returns {{confirmed: string[], pending: string[]}}
 */
function scanConfirmedAcsInFiles(specFilePaths, expectedAcIds, opts = {}) {
  const readFileSync = opts.readFileSync || ((p) => fs.readFileSync(p, 'utf8'));
  const texts = (specFilePaths || []).map((p) => readFileSync(p));
  return scanConfirmedAcs(texts, expectedAcIds);
}

module.exports = { findTaggedAcIds, scanConfirmedAcs, scanConfirmedAcsInFiles };
