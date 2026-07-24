'use strict';

const { checkPrState, NO_OPEN_PR_MESSAGE } = require('../lib/pr-state');

describe('checkPrState (AC-001-1: no open PR halts)', () => {
  test('empty array from gh -> hasOpenPr: false', () => {
    const exec = jest.fn(() => '[]');
    const result = checkPrState('feature/x', { exec });
    expect(result).toEqual({ hasOpenPr: false, state: null, url: null, number: null });
  });

  test('NO_OPEN_PR_MESSAGE documents the halt instruction', () => {
    expect(NO_OPEN_PR_MESSAGE).toMatch(/implement-trd-beads/);
    expect(NO_OPEN_PR_MESSAGE).toMatch(/No open PR/i);
  });

  test('gh throws (missing/unauthenticated/network failure) -> hasOpenPr: false', () => {
    const exec = jest.fn(() => {
      throw new Error('gh: command not found');
    });
    const result = checkPrState('feature/x', { exec });
    expect(result).toEqual({ hasOpenPr: false, state: null, url: null, number: null });
  });

  test('malformed/non-JSON gh output -> hasOpenPr: false', () => {
    const exec = jest.fn(() => 'not json at all');
    const result = checkPrState('feature/x', { exec });
    expect(result).toEqual({ hasOpenPr: false, state: null, url: null, number: null });
  });
});

describe('checkPrState (AC-001-2: open PR is detected and surfaced)', () => {
  test('valid PR JSON -> hasOpenPr: true with state/url/number surfaced', () => {
    const exec = jest.fn(() =>
      JSON.stringify([{ number: 42, state: 'OPEN', url: 'https://github.com/org/repo/pull/42' }])
    );
    const result = checkPrState('feature/trd-003', { exec });
    expect(result).toEqual({
      hasOpenPr: true,
      state: 'OPEN',
      url: 'https://github.com/org/repo/pull/42',
      number: 42,
    });
  });
});

describe('checkPrState (argv safety)', () => {
  test('branch name is passed as a discrete argv element, not string-interpolated', () => {
    const exec = jest.fn(() => '[]');
    checkPrState('feature/some-branch; rm -rf /', { exec });
    expect(exec).toHaveBeenCalledWith([
      'pr',
      'list',
      '--head',
      'feature/some-branch; rm -rf /',
      '--state',
      'open',
      '--json',
      'number,state,url',
    ]);
  });
});
