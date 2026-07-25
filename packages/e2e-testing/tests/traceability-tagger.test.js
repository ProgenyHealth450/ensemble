'use strict';

// TRD-015-TEST: formalizes traceability-tagger.js's embedded
// require.main===module self-check into Jest, plus the prefix-collision
// guard and a real (non-mocked) resume-scan.js round-trip. AC references:
//   - AC-014-1 (tag content correctness: AC id, @hash:, doc-id, REQ id)
//   - AC-014-2 (tagging one AC's anchor never disturbs any other AC's tag,
//     byte-for-byte) -- this file's main focus.

const { tagTestMethod, hashAcText, normalizeAcText, docIdTag } = require('../lib/traceability-tagger');
const { scaffoldNewSpecFile, appendTestMethod } = require('../lib/spec-writer');
const { scanConfirmedAcs, findTaggedAcIds } = require('../lib/resume-scan');

/** Escape a string for literal use inside a RegExp (test-local copy). */
function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Find the single line in `content` that is either the plain `// {acId}`
 * anchor or the tagged `// {acId} @hash:... ...` line. Fails the test if
 * zero or more than one line matches, so callers never silently compare
 * against the wrong line.
 */
function findAnchorLine(content, acId) {
  const lines = content.split('\n');
  const re = new RegExp(`^\\s*//\\s*${escapeRegExp(acId)}\\b`, 'i');
  const matches = lines.filter((line) => re.test(line));
  expect(matches.length).toBe(1);
  return matches[0];
}

/**
 * Assert that exactly one line differs between `before` and `after`, and
 * that every other line -- the full prefix and suffix around that one line
 * -- is exact string equality (not a normalized/visual diff). Returns the
 * index of the one line that changed.
 */
function assertExactlyOneLineChanged(before, after) {
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  expect(afterLines.length).toBe(beforeLines.length);

  let diffIndex = -1;
  for (let i = 0; i < beforeLines.length; i++) {
    if (beforeLines[i] !== afterLines[i]) {
      expect(diffIndex).toBe(-1); // fails immediately if a second differing line is found
      diffIndex = i;
    }
  }
  expect(diffIndex).toBeGreaterThanOrEqual(0);

  expect(beforeLines.slice(0, diffIndex).join('\n')).toBe(afterLines.slice(0, diffIndex).join('\n'));
  expect(beforeLines.slice(diffIndex + 1).join('\n')).toBe(afterLines.slice(diffIndex + 1).join('\n'));
  return diffIndex;
}

const details = (acId, overrides = {}) => ({
  acId,
  acText: `Given a user, when they trigger ${acId}, then the expected outcome happens.`,
  reqId: 'REQ-020',
  documentId: 'PRD-2026-abc123',
  ...overrides,
});

describe('tagTestMethod (AC-014-2: sequential tagging preserves prior tags byte-for-byte)', () => {
  test('tagging AC #1, then #2, then #3 never disturbs an already-tagged anchor line', () => {
    const scaffolded = scaffoldNewSpecFile({
      className: 'CaseSearchTests',
      baseClass: 'PageTest',
      acId: 'AC-020-1',
      testName: 'Should_Show_Results',
    });
    const withThree = appendTestMethod(
      appendTestMethod(scaffolded, { acId: 'AC-020-2', testName: 'Should_Filter_Results' }),
      { acId: 'AC-020-3', testName: 'Should_Sort_Results' }
    );

    // step 1: tag AC-020-1 -- only its own anchor line may change
    const afterFirst = tagTestMethod(withThree, details('AC-020-1'));
    assertExactlyOneLineChanged(withThree, afterFirst);
    const tag1 = findAnchorLine(afterFirst, 'AC-020-1');
    expect(tag1).toContain('@hash:');

    // step 2: tag AC-020-2 -- AC-020-1's tag line must be byte-for-byte
    // identical to what it was right after step 1
    const afterSecond = tagTestMethod(afterFirst, details('AC-020-2'));
    assertExactlyOneLineChanged(afterFirst, afterSecond);
    expect(findAnchorLine(afterSecond, 'AC-020-1')).toBe(tag1);
    const tag2 = findAnchorLine(afterSecond, 'AC-020-2');
    expect(tag2).toContain('@hash:');

    // step 3: tag AC-020-3 -- both prior tags must still be byte-for-byte identical
    const afterThird = tagTestMethod(afterSecond, details('AC-020-3'));
    assertExactlyOneLineChanged(afterSecond, afterThird);
    expect(findAnchorLine(afterThird, 'AC-020-1')).toBe(tag1);
    expect(findAnchorLine(afterThird, 'AC-020-2')).toBe(tag2);
    expect(findAnchorLine(afterThird, 'AC-020-3')).toContain('@hash:');
  });
});

describe('tagTestMethod (prefix-collision guard: AC-006-1 vs AC-006-10)', () => {
  function buildFileWithBothAnchors() {
    return appendTestMethod(
      scaffoldNewSpecFile({
        className: 'LoginTests',
        baseClass: 'PageTest',
        acId: 'AC-006-1',
        testName: 'Should_Show_Login',
      }),
      { acId: 'AC-006-10', testName: 'Should_Show_Tenth_Case' }
    );
  }

  test('tagging the short id (AC-006-1) first never touches the longer id (AC-006-10) anchor', () => {
    const original = buildFileWithBothAnchors();
    const originalLongAnchor = findAnchorLine(original, 'AC-006-10');

    const tagged = tagTestMethod(original, details('AC-006-1'));

    expect(findAnchorLine(tagged, 'AC-006-1')).toContain('@hash:');
    expect(findAnchorLine(tagged, 'AC-006-10')).toBe(originalLongAnchor); // untouched
    assertExactlyOneLineChanged(original, tagged);
  });

  test('tagging the longer id (AC-006-10) first never touches the shorter id (AC-006-1) anchor', () => {
    const original = buildFileWithBothAnchors();
    const originalShortAnchor = findAnchorLine(original, 'AC-006-1');

    const tagged = tagTestMethod(original, details('AC-006-10'));

    expect(findAnchorLine(tagged, 'AC-006-10')).toContain('@hash:');
    expect(findAnchorLine(tagged, 'AC-006-1')).toBe(originalShortAnchor); // untouched
    assertExactlyOneLineChanged(original, tagged);
  });
});

describe('tagTestMethod integration with the real resume-scan.js (round-trip, no mocking)', () => {
  test('resume-scan.js reports the tagged AC as confirmed and the other ACs as still pending', () => {
    const scaffolded = scaffoldNewSpecFile({
      className: 'CaseSearchTests',
      baseClass: 'PageTest',
      acId: 'AC-021-1',
      testName: 'Should_Show_Results',
    });
    const withThree = appendTestMethod(
      appendTestMethod(scaffolded, { acId: 'AC-021-2', testName: 'Should_Filter_Results' }),
      { acId: 'AC-021-3', testName: 'Should_Sort_Results' }
    );

    const tagged = tagTestMethod(withThree, details('AC-021-2'));

    expect(findTaggedAcIds(tagged)).toEqual(new Set(['AC-021-2']));
    const result = scanConfirmedAcs(tagged, ['AC-021-1', 'AC-021-2', 'AC-021-3']);
    expect(result.confirmed).toEqual(['AC-021-2']);
    expect(result.pending).toEqual(['AC-021-1', 'AC-021-3']);
  });
});

describe('tagTestMethod (AC-014-1: tag line content correctness)', () => {
  test('the tag line carries the AC id, a matching @hash:, the PRD doc-id tag, and the REQ id', () => {
    const scaffolded = scaffoldNewSpecFile({
      className: 'CaseSearchTests',
      baseClass: 'PageTest',
      acId: 'AC-030-1',
      testName: 'Should_Show_Results',
    });
    const acText = 'Given a user, when they search by case id, then matching cases are shown.';

    const tagged = tagTestMethod(scaffolded, {
      acId: 'AC-030-1',
      acText,
      reqId: 'REQ-030',
      documentId: 'PRD-2026-deadbeef',
    });

    const line = findAnchorLine(tagged, 'AC-030-1');
    expect(line).toContain('AC-030-1');
    expect(line).toContain(`@hash:${hashAcText(acText)}`);
    expect(line).toMatch(/@hash:[0-9a-f]{12}\b/);
    expect(line).toContain('@prd-2026-deadbeef');
    expect(line).toContain('@REQ-030');
  });

  test('the doc-id tag is derived via docIdTag -- lowercased with non-alphanumeric runs hyphenated', () => {
    expect(docIdTag('PRD-2026-DeadBeef')).toBe('@prd-2026-deadbeef');
  });
});

describe('tagTestMethod (error paths)', () => {
  const scaffolded = scaffoldNewSpecFile({
    className: 'LoginTests',
    baseClass: 'PageTest',
    acId: 'AC-006-1',
    testName: 'Should_Show_Login',
  });

  test('throws a clear error when no anchor exists for the given acId', () => {
    expect(() => tagTestMethod(scaffolded, details('AC-999-1'))).toThrow(
      /could not find an existing "\/\/ AC-999-1" anchor/
    );
  });

  test('throws a clear error when more than one anchor exists for the given acId (refuses to guess)', () => {
    const duplicated = scaffolded + '\n// AC-006-1\n';
    expect(() => tagTestMethod(duplicated, details('AC-006-1'))).toThrow(
      /found 2 "\/\/ AC-006-1" anchor comments/
    );
  });

  test('throws when fileContent is empty', () => {
    expect(() => tagTestMethod('', details('AC-006-1'))).toThrow(/requires non-empty fileContent/);
  });

  test.each([
    ['acId', { acId: undefined }],
    ['acText', { acText: undefined }],
    ['reqId', { reqId: undefined }],
    ['documentId', { documentId: undefined }],
  ])('throws a clear error when %s is missing', (field, overrides) => {
    expect(() => tagTestMethod(scaffolded, details('AC-006-1', overrides))).toThrow(
      new RegExp(`${field} must be a non-empty string`)
    );
  });

  test.each([
    ['acId', { acId: '   ' }],
    ['acText', { acText: '   ' }],
    ['reqId', { reqId: '   ' }],
    ['documentId', { documentId: '   ' }],
  ])('throws a clear error when %s is whitespace-only', (field, overrides) => {
    expect(() => tagTestMethod(scaffolded, details('AC-006-1', overrides))).toThrow(
      new RegExp(`${field} must be a non-empty string`)
    );
  });
});

describe('hashAcText (determinism)', () => {
  test('the same acText produces the same hash across repeated calls', () => {
    const text = 'Given a user, when they log in, then a session is created.';
    const first = hashAcText(text);
    expect(hashAcText(text)).toBe(first);
    expect(hashAcText(text)).toBe(first);
  });

  test('different acText produces different hashes', () => {
    expect(hashAcText('Given A, when B, then C.')).not.toBe(hashAcText('Given X, when Y, then Z.'));
  });

  test('every hash is a 12-hex-char string', () => {
    expect(hashAcText('Some AC text.')).toMatch(/^[0-9a-f]{12}$/);
  });

  test('cosmetic whitespace/case differences normalize to the same hash (normalizeAcText)', () => {
    expect(hashAcText('Some Text')).toBe(hashAcText('some   text'));
    expect(normalizeAcText('  Some   Text  ')).toBe('some text');
  });
});
