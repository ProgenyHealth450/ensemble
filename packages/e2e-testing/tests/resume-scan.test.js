'use strict';

const {
  findTaggedAcIds,
  scanConfirmedAcs,
  scanConfirmedAcsInFiles,
} = require('../lib/resume-scan');

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
