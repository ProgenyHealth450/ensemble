'use strict';

/**
 * TRD-015: traceability tagging for /ensemble:author-playwright-tests (REQ-014).
 *
 * spec-writer.js (TRD-014) leaves a plain `// {acId}` comment above each
 * generated `[Test]` method as an anchor -- explicitly NOT the full
 * traceability tag (see spec-writer.js's own header comment). This module
 * turns that anchor into the real tag once an AC is confirmed: `@hash:<hash>`
 * (the drift-detection fingerprint), the PRD's `@<documentId>` tag, and the
 * owning `@REQ-NNN`, all landing on that same anchor line so later tooling
 * can match test to requirement (AC-014-1).
 *
 * Compatibility contract with resume-scan.js (TRD-005, already shipped):
 * resume-scan.js's findTaggedAcIds() considers an AC id "confirmed" if a
 * `@hash:[0-9a-f]+` tag appears on the SAME line as the AC id, or on a line
 * immediately before/after it (case-insensitive). This module always keeps
 * the AC id and its `@hash:` tag on one line, so it satisfies that contract
 * unconditionally, not just in the common case.
 *
 * Hashing convention: reuses the exact approach packages/product/lib/
 * feature-gen.js's hashAc() established (sha256 of normalized AC text,
 * truncated to 12 hex chars) -- replicated locally rather than imported
 * cross-package, matching TRD-002's prd-ac-parser.js precedent (see that
 * file's header for the same reasoning).
 *
 * Scope (Implementation AC for TRD-015):
 *   - AC-014-1: a saved test file carries a comment/attribute tagging the
 *     REQ-NNN, AC-NNN-M, and the PRD's Document ID.
 *   - AC-014-2: tagging a new AC's anchor line never disturbs the tags
 *     already present for other ACs in the same file -- every other line,
 *     byte for byte, is untouched.
 *
 * Out of scope here (TRD-018's job): the `@ado-testcase:<id>` tag added once
 * a test syncs to Azure DevOps. This module only handles the REQ/AC/doc-id
 * tag from AC-014-1.
 *
 * Convention: plain functions over plain strings (no C# AST), matching this
 * package's existing modules (spec-writer.js, resume-scan.js). No disk I/O --
 * this module operates on file content already read into memory.
 */

const crypto = require('crypto');

/** Throw a clear error if `value` isn't a non-empty string. */
function assertNonEmptyString(label, value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string (got: ${JSON.stringify(value)})`);
  }
}

/**
 * Normalize AC text the same way feature-gen.js's normalizeAcText does for
 * free-form text: lowercased, whitespace-collapsed, trimmed -- so cosmetic
 * edits don't register as drift.
 */
function normalizeAcText(acText) {
  return String(acText || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** 12-hex-char sha256 prefix of the normalized AC text (feature-gen.js's hashAc convention). */
function hashAcText(acText) {
  return crypto.createHash('sha256').update(normalizeAcText(acText)).digest('hex').slice(0, 12);
}

/** `@<documentId>` tag: lowercase, non-alphanumeric runs replaced with hyphens (feature-gen.js's docIdTag convention). */
function docIdTag(documentId) {
  return '@' + String(documentId || 'prd').toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

/** Escape a string for literal use inside a RegExp. */
function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Find spec-writer.js's plain `// {acId}` anchor line for one specific AC id
 * and replace it with the full traceability tag line, leaving every other
 * byte in `fileContent` untouched (AC-014-2).
 *
 * @param {string} fileContent - the spec file's full text (as produced/appended
 *   by spec-writer.js, containing a `// {acId}` anchor comment)
 * @param {object} details
 * @param {string} details.acId - e.g. "AC-006-1" -- must match the anchor
 *   spec-writer.js left verbatim (matched case-insensitively)
 * @param {string} details.acText - the AC's raw text, hashed for drift detection
 * @param {string} details.reqId - e.g. "REQ-006"
 * @param {string} details.documentId - the PRD's Document ID (prd-ac-parser.js's parsePrdAcs() output)
 * @returns {string} full updated file content, with only the one anchor line changed
 * @throws {Error} if any required field is missing, fileContent is empty, the
 *   anchor for `acId` can't be found, or more than one anchor for `acId` exists
 *   (this module never guesses which line to tag)
 */
function tagTestMethod(fileContent, details = {}) {
  const { acId, acText, reqId, documentId } = details;
  assertNonEmptyString('acId', acId);
  assertNonEmptyString('acText', acText);
  assertNonEmptyString('reqId', reqId);
  assertNonEmptyString('documentId', documentId);
  if (typeof fileContent !== 'string' || fileContent === '') {
    throw new Error('tagTestMethod requires non-empty fileContent to search for an existing anchor comment.');
  }

  // spec-writer.js's anchor line is exactly `{indent}// {acId}` -- nothing
  // else on the line. Matching to end-of-line (allowing an optional trailing
  // \r for CRLF files) also guards against a prefix collision, e.g. this
  // regex for "AC-006-1" will NOT match a "// AC-006-10" line, since the "0"
  // following "AC-006-1" isn't trailing whitespace/EOL.
  const anchorRe = new RegExp(`^([ \\t]*)//[ \\t]*${escapeRegExp(acId)}[ \\t]*\\r?$`, 'gmi');

  const matches = [...fileContent.matchAll(anchorRe)];
  if (matches.length === 0) {
    throw new Error(
      `tagTestMethod: could not find an existing "// ${acId}" anchor comment in fileContent -- ` +
        'spec-writer.js must write the plain anchor before this module can tag it.'
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `tagTestMethod: found ${matches.length} "// ${acId}" anchor comments in fileContent -- ` +
        'expected exactly one; refusing to guess which one to tag.'
    );
  }

  const match = matches[0];
  const indent = match[1];
  const hash = hashAcText(acText);
  const tagLine = `${indent}// ${acId} @hash:${hash} ${docIdTag(documentId)} @${reqId}`;

  const start = match.index;
  const end = start + match[0].length;
  return fileContent.slice(0, start) + tagLine + fileContent.slice(end);
}

module.exports = {
  tagTestMethod,
  hashAcText,
  normalizeAcText,
  docIdTag,
};

// ponytail self-check: `node packages/e2e-testing/lib/traceability-tagger.js`
// exercises the tag/preserve/error paths, plus the resume-scan.js
// compatibility contract directly -- no separate test file yet (TRD-015-TEST
// is a separate later task that will formalize this into Jest).
if (require.main === module) {
  const assert = require('assert');
  const { scaffoldNewSpecFile, appendTestMethod } = require('./spec-writer');
  const { findTaggedAcIds } = require('./resume-scan');

  const scaffolded = scaffoldNewSpecFile({
    className: 'LoginTests',
    baseClass: 'AuthenticatedPageTest',
    acId: 'AC-006-1',
    testName: 'Should_Redirect_To_Login_When_Unauthenticated',
  });
  const withSecondAc = appendTestMethod(scaffolded, {
    acId: 'AC-006-2',
    testName: 'Should_Show_Error_On_Bad_Password',
    testBody: 'await Page.FillAsync("#password", "wrong");',
  });

  // --- AC-014-1: tagging carries AC id, hash, doc id, and REQ id ---
  const tagged = tagTestMethod(withSecondAc, {
    acId: 'AC-006-1',
    acText: 'Given an unauthenticated user, when they load a protected page, then they are redirected to login.',
    reqId: 'REQ-006',
    documentId: 'PRD-2026-abc123',
  });
  assert.ok(tagged.includes('// AC-006-1 @hash:'));
  assert.ok(tagged.includes('@prd-2026-abc123'));
  assert.ok(tagged.includes('@REQ-006'));
  // untagged AC-006-2's plain anchor is still there, untouched
  assert.ok(tagged.includes('// AC-006-2\n') || tagged.includes('// AC-006-2\r\n'));

  // resume-scan.js must recognize the tagged AC as confirmed, and the
  // untagged one as still pending -- the actual reader contract, not just a
  // string-shape assumption.
  const afterFirstTag = findTaggedAcIds(tagged);
  assert.ok(afterFirstTag.has('AC-006-1'));
  assert.ok(!afterFirstTag.has('AC-006-2'));

  // --- AC-014-2: tagging a second AC preserves the first AC's tag verbatim ---
  const taggedBoth = tagTestMethod(tagged, {
    acId: 'AC-006-2',
    acText: 'Given a bad password, when the user submits login, then an error is shown.',
    reqId: 'REQ-006',
    documentId: 'PRD-2026-abc123',
  });
  assert.ok(taggedBoth.includes('// AC-006-1 @hash:')); // first tag untouched
  assert.ok(taggedBoth.includes('// AC-006-2 @hash:')); // second tag added
  const afterBothTags = findTaggedAcIds(taggedBoth);
  assert.ok(afterBothTags.has('AC-006-1'));
  assert.ok(afterBothTags.has('AC-006-2'));
  // every line outside the two anchor lines is byte-for-byte identical
  const stripAnchorLines = (s) =>
    s
      .split(/\r\n|\r|\n/)
      .filter((line) => !/\/\/\s*AC-006-[12]\b/i.test(line))
      .join('\n');
  assert.strictEqual(stripAnchorLines(taggedBoth), stripAnchorLines(withSecondAc));

  // hashing is whitespace/case-insensitive (normalizeAcText), so cosmetic AC
  // text edits produce the same hash -- same convention as feature-gen.js
  assert.strictEqual(
    hashAcText('Given an unauthenticated user, when they load a protected page.'),
    hashAcText('given an unauthenticated user,   when they load a protected page.  ')
  );

  // --- error paths ---
  assert.throws(
    () => tagTestMethod(withSecondAc, { acId: 'AC-999-1', acText: 'x', reqId: 'REQ-006', documentId: 'PRD-1' }),
    /could not find an existing "\/\/ AC-999-1" anchor/
  );
  assert.throws(
    () => tagTestMethod(withSecondAc, { acText: 'x', reqId: 'REQ-006', documentId: 'PRD-1' }),
    /acId must be a non-empty string/
  );
  assert.throws(
    () => tagTestMethod('', { acId: 'AC-006-1', acText: 'x', reqId: 'REQ-006', documentId: 'PRD-1' }),
    /requires non-empty fileContent/
  );
  // duplicate anchors for the same acId (e.g. hand-edited/corrupted file) -- refuse to guess
  assert.throws(
    () =>
      tagTestMethod(withSecondAc + '\n// AC-006-1\n', {
        acId: 'AC-006-1',
        acText: 'x',
        reqId: 'REQ-006',
        documentId: 'PRD-1',
      }),
    /found 2 "\/\/ AC-006-1" anchor comments/
  );

  // --- hashAcText: matches feature-gen.js's hashAc convention (sha256, 12 hex chars) ---
  assert.strictEqual(hashAcText('  Some Text  ').length, 12);
  assert.strictEqual(hashAcText('Some Text'), hashAcText('some   text')); // normalized before hashing
  assert.match(hashAcText('Some Text'), /^[0-9a-f]{12}$/);

  console.log('traceability-tagger.js self-check passed');
}
