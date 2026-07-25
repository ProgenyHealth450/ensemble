'use strict';

const {
  findTaggedAcIds,
  findManualAcIds,
  findAcGapAcIds,
  scanConfirmedAcs,
  scanConfirmedAcsInFiles,
  scanAcCoverage,
  isStoryFullyCovered,
} = require('../lib/resume-scan');
const { buildSessionSummary } = require('../lib/session-summary');

describe('scanConfirmedAcs (AC-011-1: literal AC — 1 of 3 tagged, 2 remain pending)', () => {
  test('only the @hash:-tagged AC is confirmed; the other two are pending', () => {
    const specText = [
      '// @AC-001-1 @hash:abcdef123456',
      "test('...', async ({ page }) => {});",
      '',
      '// @AC-001-2',
      "test('...', async ({ page }) => {});",
      '',
      '// @AC-001-3',
      "test('...', async ({ page }) => {});",
    ].join('\n');

    const result = scanConfirmedAcs(specText, ['AC-001-1', 'AC-001-2', 'AC-001-3']);

    expect(result.confirmed).toEqual(['AC-001-1']);
    expect(result.pending).toEqual(['AC-001-2', 'AC-001-3']);
  });
});

describe('findTaggedAcIds (confirmation is by @hash: tag, not AC-id presence)', () => {
  test('an AC id with no @hash: tag anywhere near it is NOT confirmed', () => {
    // This spec file mentions AC-002-1 (e.g. in a describe title or comment)
    // but never tags it with @hash: — a naive "AC id present anywhere in the
    // file = confirmed" implementation would wrongly confirm this.
    const specText = [
      "describe('AC-002-1: user can log in', () => {",
      "  test('...', async ({ page }) => {});",
      '});',
    ].join('\n');

    expect(findTaggedAcIds(specText)).toEqual(new Set());
  });

  test('the same AC id IS confirmed once a @hash: tag is adjacent to it', () => {
    const specText = ['// @AC-002-1 @hash:deadbeef0000', "test('...', () => {});"].join('\n');

    expect(findTaggedAcIds(specText)).toEqual(new Set(['AC-002-1']));
  });
});

describe('scanConfirmedAcsInFiles (multi-file union, no real disk I/O)', () => {
  test('confirmed ACs spread across two files are both counted via a stubbed readFileSync', () => {
    const fileContents = {
      'spec/a.spec.ts': '// @AC-003-1 @hash:111111111111\n',
      'spec/b.spec.ts': '// @AC-003-2 @hash:222222222222\n',
    };
    const readFileSync = jest.fn((p) => fileContents[p]);

    const result = scanConfirmedAcsInFiles(
      ['spec/a.spec.ts', 'spec/b.spec.ts'],
      ['AC-003-1', 'AC-003-2', 'AC-003-3'],
      { readFileSync }
    );

    expect(result.confirmed).toEqual(['AC-003-1', 'AC-003-2']);
    expect(result.pending).toEqual(['AC-003-3']);
    expect(readFileSync).toHaveBeenCalledWith('spec/a.spec.ts');
    expect(readFileSync).toHaveBeenCalledWith('spec/b.spec.ts');
    expect(readFileSync).toHaveBeenCalledTimes(2);
  });
});

describe('findTaggedAcIds (case-insensitive tag matching)', () => {
  test('a lowercase AC id tag still confirms the uppercased AC id', () => {
    const specText = '// @ac-001-1 @hash:abcdef123456\n';

    expect(findTaggedAcIds(specText)).toEqual(new Set(['AC-001-1']));
  });
});

describe('findTaggedAcIds (±1-line adjacency boundary)', () => {
  test('a @hash: tag exactly 1 line away (line before) confirms the AC id', () => {
    const specText = ['// @hash:abcdef123456', '// @AC-004-1', "test('...', () => {});"].join('\n');

    expect(findTaggedAcIds(specText)).toEqual(new Set(['AC-004-1']));
  });

  test('a @hash: tag exactly 1 line away (line after) confirms the AC id', () => {
    const specText = ['// @AC-004-1', '// @hash:abcdef123456', "test('...', () => {});"].join('\n');

    expect(findTaggedAcIds(specText)).toEqual(new Set(['AC-004-1']));
  });

  test('a @hash: tag 2 lines away (just outside the ±1 boundary) does NOT confirm the AC id', () => {
    const specText = [
      '// @hash:abcdef123456',
      '// (an unrelated comment line sits between the tag and the AC id)',
      '// @AC-004-1',
      "test('...', () => {});",
    ].join('\n');

    expect(findTaggedAcIds(specText)).toEqual(new Set());
  });
});

describe('scanConfirmedAcs (empty/no-tag input -> everything pending)', () => {
  test('empty string input confirms nothing', () => {
    const result = scanConfirmedAcs('', ['AC-005-1', 'AC-005-2']);
    expect(result.confirmed).toEqual([]);
    expect(result.pending).toEqual(['AC-005-1', 'AC-005-2']);
  });

  test('spec text with AC ids but no @hash: tags anywhere confirms nothing', () => {
    const specText = ['// @AC-005-1', "test('...', () => {});", '// @AC-005-2', "test('...', () => {});"].join(
      '\n'
    );
    const result = scanConfirmedAcs(specText, ['AC-005-1', 'AC-005-2']);
    expect(result.confirmed).toEqual([]);
    expect(result.pending).toEqual(['AC-005-1', 'AC-005-2']);
  });
});

// --- TRD-023 (AC-011-2: full-session idempotence) ---

describe('scanAcCoverage (TRD-023: confirmed/manual/gap superset)', () => {
  test('full coverage via ALL confirmed (@hash:) -> pending empty', () => {
    const specText = [
      '// @AC-011-1 @hash:111111111111',
      "test('...', () => {});",
      '// @AC-011-2 @hash:222222222222',
      "test('...', () => {});",
    ].join('\n');

    const result = scanAcCoverage(specText, ['AC-011-1', 'AC-011-2']);

    expect(result.confirmed).toEqual(['AC-011-1', 'AC-011-2']);
    expect(result.manual).toEqual([]);
    expect(result.gap).toEqual([]);
    expect(result.pending).toEqual([]);
  });

  test('full coverage via ALL manual (@manual) -> pending empty', () => {
    const specText = ['// @AC-011-1 @manual', '// @AC-011-2 @manual'].join('\n');

    const result = scanAcCoverage(specText, ['AC-011-1', 'AC-011-2']);

    expect(result.confirmed).toEqual([]);
    expect(result.manual).toEqual(['AC-011-1', 'AC-011-2']);
    expect(result.gap).toEqual([]);
    expect(result.pending).toEqual([]);
  });

  test('full coverage via ALL gap (@ac-gap) -> pending empty', () => {
    const specText = ['// @AC-011-1 @ac-gap', '// @AC-011-2 @ac-gap'].join('\n');

    const result = scanAcCoverage(specText, ['AC-011-1', 'AC-011-2']);

    expect(result.confirmed).toEqual([]);
    expect(result.manual).toEqual([]);
    expect(result.gap).toEqual(['AC-011-1', 'AC-011-2']);
    expect(result.pending).toEqual([]);
  });

  test('full coverage via a MIX of confirmed + manual + gap -> pending empty', () => {
    const specText = [
      '// @AC-011-1 @hash:111111111111',
      "test('...', () => {});",
      '// @AC-011-2 @manual',
      '// @AC-011-3 @ac-gap',
    ].join('\n');

    const result = scanAcCoverage(specText, ['AC-011-1', 'AC-011-2', 'AC-011-3']);

    expect(result.confirmed).toEqual(['AC-011-1']);
    expect(result.manual).toEqual(['AC-011-2']);
    expect(result.gap).toEqual(['AC-011-3']);
    expect(result.pending).toEqual([]);
  });
});

describe('isStoryFullyCovered (TRD-023/AC-011-2 decision function)', () => {
  test('true when every AC is @hash:-confirmed', () => {
    const specText = ['// @AC-012-1 @hash:aaaaaaaaaaaa', '// @AC-012-2 @hash:bbbbbbbbbbbb'].join('\n');

    expect(isStoryFullyCovered(['AC-012-1', 'AC-012-2'], specText)).toBe(true);
  });

  test('true when every AC is @manual', () => {
    const specText = ['// @AC-012-1 @manual', '// @AC-012-2 @manual'].join('\n');

    expect(isStoryFullyCovered(['AC-012-1', 'AC-012-2'], specText)).toBe(true);
  });

  test('true when every AC is @ac-gap', () => {
    const specText = ['// @AC-012-1 @ac-gap', '// @AC-012-2 @ac-gap'].join('\n');

    expect(isStoryFullyCovered(['AC-012-1', 'AC-012-2'], specText)).toBe(true);
  });

  test('true when coverage is a mix of confirmed + manual + gap', () => {
    const specText = ['// @AC-012-1 @hash:aaaaaaaaaaaa', '// @AC-012-2 @manual', '// @AC-012-3 @ac-gap'].join(
      '\n'
    );

    expect(isStoryFullyCovered(['AC-012-1', 'AC-012-2', 'AC-012-3'], specText)).toBe(true);
  });

  test('false at the exact N-1-covered/1-pending boundary: 2 of 3 ACs covered is NOT fully covered', () => {
    const specText = ['// @AC-012-1 @hash:aaaaaaaaaaaa', '// @AC-012-2 @manual', '// @AC-012-3 (no marker)'].join(
      '\n'
    );

    const coverage = scanAcCoverage(specText, ['AC-012-1', 'AC-012-2', 'AC-012-3']);
    expect(coverage.pending).toEqual(['AC-012-3']); // sanity: exactly the one uncovered AC is pending

    expect(isStoryFullyCovered(['AC-012-1', 'AC-012-2', 'AC-012-3'], specText)).toBe(false);
  });
});

describe('findManualAcIds / findAcGapAcIds (TRD-023 marker tags: same-line only)', () => {
  test('findManualAcIds confirms an AC id tagged @manual on the same line', () => {
    const specText = '// @AC-017-1 @manual\n';

    expect(findManualAcIds(specText)).toEqual(new Set(['AC-017-1']));
  });

  test('findAcGapAcIds confirms an AC id tagged @ac-gap on the same line', () => {
    const specText = '// @AC-009-1 @ac-gap\n';

    expect(findAcGapAcIds(specText)).toEqual(new Set(['AC-009-1']));
  });

  test('a stacked marker block does not cross-contaminate neighboring lines (regression)', () => {
    // Regression test for the bug found during TRD-023's own review: a naive
    // ±1-line adjacency window (the @hash: behavior) would wrongly let
    // AC-017-1's line "see" the @ac-gap tag on the line below it, and
    // AC-009-1's line "see" the @manual tag on the line above it.
    const specText = ['// @AC-017-1 @manual', '// @AC-009-1 @ac-gap'].join('\n');

    expect(findManualAcIds(specText)).toEqual(new Set(['AC-017-1']));
    expect(findAcGapAcIds(specText)).toEqual(new Set(['AC-009-1']));
  });

  test('a marker line immediately next to a @hash:-tagged line does not bleed into "confirmed" (regression)', () => {
    // Regression test for the second bug: @hash:'s ±1-line adjacency window
    // must not let a @manual/@ac-gap marker line's own AC id get treated as
    // @hash:-confirmed just because it sits next to a real tagged test line,
    // nor should the real test's AC id pick up the marker line's tag.
    const specText = [
      '// @AC-017-1 @manual',
      '// @AC-020-1 @hash:cccccccccccc',
      "test('...', () => {});",
    ].join('\n');

    expect(findTaggedAcIds(specText)).toEqual(new Set(['AC-020-1'])); // AC-017-1 must NOT appear
    expect(findManualAcIds(specText)).toEqual(new Set(['AC-017-1'])); // AC-020-1 must NOT appear
  });
});

describe('buildSessionSummary alreadyComplete flag (TRD-023/AC-011-2)', () => {
  test('session scope renders the fixed "already complete" message, ignoring any category args', () => {
    const summary = buildSessionSummary({ alreadyComplete: true, testsWritten: ['should be ignored'] });

    expect(summary).toBe('Session summary\n  Already complete -- no changes made.');
  });

  test('checkpoint scope renders the same message under the REQ-specific header', () => {
    const summary = buildSessionSummary({ scope: 'checkpoint', reqId: 'REQ-011', alreadyComplete: true });

    expect(summary).toBe('REQ-011 checkpoint summary\n  Already complete -- no changes made.');
  });

  test('a non-boolean alreadyComplete value is rejected', () => {
    expect(() => buildSessionSummary({ alreadyComplete: 'yes' })).toThrow(
      /alreadyComplete must be a boolean when present/
    );
  });
});

describe('End-to-end AC-011-2: a fully-covered story (mixed confirmed/manual/gap) reports complete with no changes', () => {
  test('scanAcCoverage/isStoryFullyCovered detect full coverage, and the resulting summary reports no changes', () => {
    // A 3-AC story where each AC reached "done" via a different route:
    //   AC-021-1: a real, landed test (@hash: tag)
    //   AC-021-2: tracked as manual (manual-ac-tracker.js) via a @manual marker
    //   AC-021-3: tracked as an ac-gap (ac-gap-detector.js) via an @ac-gap marker
    const specText = [
      '// @AC-021-1 @hash:deadbeefcafe',
      "test('user can do the thing', async ({ page }) => {});",
      '',
      '// tracking block for markers with no test method to anchor to:',
      '// @AC-021-2 @manual',
      '// @AC-021-3 @ac-gap',
    ].join('\n');
    const expectedAcIds = ['AC-021-1', 'AC-021-2', 'AC-021-3'];

    const coverage = scanAcCoverage(specText, expectedAcIds);
    expect(coverage).toEqual({
      confirmed: ['AC-021-1'],
      manual: ['AC-021-2'],
      gap: ['AC-021-3'],
      pending: [],
    });
    expect(isStoryFullyCovered(expectedAcIds, specText)).toBe(true);

    // Orchestrator design: when isStoryFullyCovered() is true, no further
    // spec-writer.js/ado-test-case-sync.js work happens -- the summary is
    // built straight off that decision, with no category arrays at all.
    const summary = buildSessionSummary({ alreadyComplete: true });
    expect(summary).toBe('Session summary\n  Already complete -- no changes made.');
  });
});
