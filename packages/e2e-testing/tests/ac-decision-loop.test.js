'use strict';

const { recordDecision } = require('../lib/ac-decision-loop');
const { markManual } = require('../lib/manual-ac-tracker');

describe('recordDecision (AC-003-2: request-changes revises and re-presents, never silently finalizes)', () => {
  test('request-changes returns revise with the changeDescription preserved for re-delegation, never accepted', () => {
    const result = recordDecision('request-changes', {
      acId: 'AC-003-1',
      changeDescription: 'assert on the confirmation toast text, not just navigation',
    });

    expect(result.outcome).toBe('revise');
    expect(result.outcome).not.toBe('accepted');
    expect(result.changeDescription).toBe('assert on the confirmation toast text, not just navigation');
  });

  test.each([
    ['missing', { acId: 'AC-003-1' }],
    ['blank', { acId: 'AC-003-1', changeDescription: '   ' }],
  ])('%s changeDescription throws instead of silently finalizing', (_label, context) => {
    expect(() => recordDecision('request-changes', context)).toThrow(/changeDescription is required/);
  });
});

describe('recordDecision + markManual (AC-003-3: true reject routes to the manual tracker, REQ-017 escape hatch)', () => {
  test('reject -> manual-escape-hatch, fed into markManual(), lands recorded with status "manual" end to end', () => {
    const decision = recordDecision('reject', { acId: 'AC-017-1' });

    expect(decision).toEqual({ outcome: 'manual-escape-hatch', acId: 'AC-017-1' });

    // Simulate the orchestrator's routing: manual-escape-hatch's acId feeds
    // markManual() directly -- proves the two modules actually compose, not
    // just that each works alone.
    const recorded = markManual(decision.acId, 'visual-only check, no camera in QA env');

    expect(recorded).toEqual({
      acId: 'AC-017-1',
      status: 'manual',
      reason: 'visual-only check, no camera in QA env',
    });
  });

  test('status strings never collide across the package\'s three per-AC outcomes', () => {
    const manualStatus = markManual('AC-017-1').status;

    // resume-scan.js's 'confirmed' and implementation-grounding.js's 'gap' are
    // not literal status fields on those modules' return shapes, but the
    // distinct label itself must never collide with either.
    expect(manualStatus).toBe('manual');
    expect(manualStatus).not.toBe('confirmed');
    expect(manualStatus).not.toBe('gap');
  });
});

describe('recordDecision (regression smoke: invalid decision values still throw)', () => {
  test.each([
    ['typo', 'maybe'],
    ['wrong case', 'Accept'],
    ['empty string', ''],
  ])('%s decision "%s" throws, never silently defaults', (_label, decision) => {
    expect(() => recordDecision(decision, { acId: 'AC-003-1' })).toThrow(/Invalid decision/);
  });
});
