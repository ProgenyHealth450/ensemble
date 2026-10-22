'use strict';

const { classifyReviews, decideBlock } = require('../lib/local-ci-review');

const rv = (login, type, state, submittedAt) => {
  const review = { author: { login }, state, submittedAt };
  if (type !== undefined) review.author.type = type;
  return review;
};

describe('classifyReviews', () => {
  test('name ignored: a User whose login ends in [bot] is a User; a Bot named like a person is a Bot', () => {
    const out = classifyReviews([
      rv('sneaky[bot]', 'User', 'APPROVED', '2026-01-01T00:00:00Z'),
      rv('alice', 'Bot', 'APPROVED', '2026-01-01T00:00:00Z'),
    ]);
    expect(out.map((e) => e.kind)).toEqual(['User', 'Bot']);
    expect(out.map((e) => e.login)).toEqual(['sneaky[bot]', 'alice']);
  });

  test('unreadable or unknown type is classified User and flagged unreadable', () => {
    const out = classifyReviews([rv('x', undefined, 'APPROVED'), rv('y', 7, 'APPROVED'), rv('z', 'Organization', 'APPROVED'), null]);
    expect(out.map((e) => e.kind)).toEqual(['User', 'User', 'User', 'User']);
    expect(out.map((e) => e.typeReadable)).toEqual([false, false, false, false]);
  });

  test('a readable type is flagged readable', () => {
    const out = classifyReviews([rv('a', 'Bot', 'APPROVED'), rv('b', 'User', 'APPROVED')]);
    expect(out.map((e) => e.typeReadable)).toEqual([true, true]);
  });
});

describe('decideBlock', () => {
  test('bot request does not block', () => {
    const result = decideBlock([rv('coderabbitai[bot]', 'Bot', 'CHANGES_REQUESTED', '2026-01-01T00:00:00Z')]);
    expect(result.blocked).toBe(false);
    expect(result.reviewers).toEqual([]);
  });

  test('bot still reviewing: pending bot review does not block and nothing waits', () => {
    const result = decideBlock([rv('coderabbitai[bot]', 'Bot', 'PENDING')]);
    expect(result.blocked).toBe(false);
    expect(result.waiting).toBe(false);
  });

  test('human request blocks and names that user', () => {
    const result = decideBlock([
      rv('coderabbitai[bot]', 'Bot', 'CHANGES_REQUESTED', '2026-01-01T00:00:00Z'),
      rv('alice', 'User', 'CHANGES_REQUESTED', '2026-01-01T00:00:00Z'),
    ]);
    expect(result.blocked).toBe(true);
    expect(result.reviewers).toEqual(['alice']);
    expect(result.reasons[0]).toContain('alice');
  });

  test('name ignored: a User login ending in [bot] with a request still blocks', () => {
    const result = decideBlock([rv('evil[bot]', 'User', 'CHANGES_REQUESTED', '2026-01-01T00:00:00Z')]);
    expect(result.blocked).toBe(true);
    expect(result.reviewers).toEqual(['evil[bot]']);
  });

  test('name ignored: a Bot with a human-looking name does not block', () => {
    expect(decideBlock([rv('alice', 'Bot', 'CHANGES_REQUESTED', '2026-01-01T00:00:00Z')]).blocked).toBe(false);
  });

  test('human re-approves: later APPROVED supersedes the request', () => {
    const result = decideBlock([
      rv('alice', 'User', 'CHANGES_REQUESTED', '2026-01-01T00:00:00Z'),
      rv('alice', 'User', 'APPROVED', '2026-01-02T00:00:00Z'),
    ]);
    expect(result.blocked).toBe(false);
  });

  test('human request later DISMISSED does not block', () => {
    const result = decideBlock([
      rv('alice', 'User', 'CHANGES_REQUESTED', '2026-01-01T00:00:00Z'),
      rv('alice', 'User', 'DISMISSED', '2026-01-02T00:00:00Z'),
    ]);
    expect(result.blocked).toBe(false);
  });

  test('a later request after an approval blocks, even when listed first', () => {
    const result = decideBlock([
      rv('alice', 'User', 'CHANGES_REQUESTED', '2026-01-03T00:00:00Z'),
      rv('alice', 'User', 'APPROVED', '2026-01-02T00:00:00Z'),
    ]);
    expect(result.blocked).toBe(true);
  });

  test('a later COMMENTED or PENDING review does not supersede a request', () => {
    const result = decideBlock([
      rv('alice', 'User', 'CHANGES_REQUESTED', '2026-01-01T00:00:00Z'),
      rv('alice', 'User', 'COMMENTED', '2026-01-02T00:00:00Z'),
      rv('alice', 'User', 'PENDING', '2026-01-03T00:00:00Z'),
    ]);
    expect(result.blocked).toBe(true);
  });

  test("one human's approval does not clear another human's request", () => {
    const result = decideBlock([
      rv('alice', 'User', 'CHANGES_REQUESTED', '2026-01-01T00:00:00Z'),
      rv('bob', 'User', 'APPROVED', '2026-01-02T00:00:00Z'),
    ]);
    expect(result.blocked).toBe(true);
    expect(result.reviewers).toEqual(['alice']);
  });

  test('unreadable author is human: no type blocks', () => {
    const result = decideBlock([rv('mystery', undefined, 'CHANGES_REQUESTED', '2026-01-01T00:00:00Z')]);
    expect(result.blocked).toBe(true);
    expect(result.reviewers).toEqual(['mystery']);
  });

  test('unreadable author is human: missing author object blocks', () => {
    const result = decideBlock([{ state: 'CHANGES_REQUESTED', submittedAt: '2026-01-01T00:00:00Z' }]);
    expect(result.blocked).toBe(true);
  });

  test('state letter case and spelling are tolerated', () => {
    expect(decideBlock([rv('alice', 'User', 'changes_requested')]).blocked).toBe(true);
    expect(decideBlock([rv('alice', 'User', 'ChangesRequested')]).blocked).toBe(true);
    expect(decideBlock([rv('alice', 'user', 'approved')]).blocked).toBe(false);
  });

  test('fail closed: unrecognised human state, non-array input and non-object entry block', () => {
    expect(decideBlock([rv('alice', 'User', 'MAYBE')]).blocked).toBe(true);
    expect(decideBlock(undefined).blocked).toBe(true);
    expect(decideBlock([null]).blocked).toBe(true);
  });

  test('no reviews does not block', () => {
    expect(decideBlock([]).blocked).toBe(false);
  });
});
