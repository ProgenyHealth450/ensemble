'use strict';

const { parseSubState, validateTransition } = require('./helpers/team-utils');

describe('advisor veto and reopen flow', () => {
  test('br-comment representation: in_advisory -> in_progress veto is valid', () => {
    expect(validateTransition('in_advisory', 'in_progress')).toBe(true);

    const state = parseSubState(
      'status:in_progress advisor:advisor verdict:rejected reason:left-TODO-in-production-code',
      'br-comment'
    );

    expect(state).toEqual({
      state: 'in_progress',
      metadata: {
        advisor: 'advisor',
        verdict: 'rejected',
        reason: 'left-TODO-in-production-code',
      },
    });
  });

  test('br-comment representation: closed -> in_advisory reopen is valid', () => {
    expect(validateTransition('closed', 'in_advisory')).toBe(true);

    const state = parseSubState(
      'status:in_advisory advisor:advisor reason:post-hoc-shortcut-detected',
      'br-comment'
    );

    expect(state).toEqual({
      state: 'in_advisory',
      metadata: {
        advisor: 'advisor',
        reason: 'post-hoc-shortcut-detected',
      },
    });
  });

  test('git-trailer representation: in_advisory -> in_progress veto normalizes the same shape', () => {
    const state = parseSubState(
      [
        'Status: in_progress',
        'Advisor: advisor',
        'Verdict: rejected',
        'Reason: left-TODO-in-production-code',
      ].join('\n'),
      'git-trailer'
    );

    expect(state).toEqual({
      state: 'in_progress',
      metadata: {
        advisor: 'advisor',
        verdict: 'rejected',
        reason: 'left-TODO-in-production-code',
      },
    });
  });

  test('git-trailer representation: closed -> in_advisory reopen normalizes the same shape', () => {
    const state = parseSubState(
      [
        'Status: in_advisory',
        'Advisor: advisor',
        'Reason: post-hoc-shortcut-detected',
      ].join('\n'),
      'git-trailer'
    );

    expect(state).toEqual({
      state: 'in_advisory',
      metadata: {
        advisor: 'advisor',
        reason: 'post-hoc-shortcut-detected',
      },
    });
  });
});
