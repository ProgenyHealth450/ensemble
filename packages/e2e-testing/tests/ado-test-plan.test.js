'use strict';

// TRD-038-TEST: Jest coverage for ado-test-plan.js's resolve-or-create
// decision logic (REQ-007's Test Plan prerequisite). Found live-dogfooding
// this feature's Test Plan Sync phase against a real consuming project with zero
// existing Test Plans -- every Test Suite belongs to a plan, but nothing in
// this package modeled that at all. This module never auto-picks or
// auto-names a plan; every assertion here reflects that a human choice is
// always required.

const { resolveOrCreateTestPlan, recordCreatedPlan } = require('../lib/ado-test-plan');

describe('resolveOrCreateTestPlan: resolving an existing plan', () => {
  test('a selectedPlanId matching an existing plan resolves to it', () => {
    expect(
      resolveOrCreateTestPlan({
        existingPlans: [
          { id: 7, name: 'Release 2026.08 Regression Plan' },
          { id: 8, name: 'Unrelated Plan' },
        ],
        selectedPlanId: 7,
      })
    ).toEqual({ action: 'resolve', planId: '7', planName: 'Release 2026.08 Regression Plan' });
  });

  test('selectedPlanId is string-compared against existingPlans ids (number vs string)', () => {
    expect(
      resolveOrCreateTestPlan({ existingPlans: [{ id: '7', name: 'Plan' }], selectedPlanId: 7 })
    ).toEqual({ action: 'resolve', planId: '7', planName: 'Plan' });
  });

  test('falls back to the plan id itself as planName when the matched plan has no name', () => {
    expect(resolveOrCreateTestPlan({ existingPlans: [{ id: 7 }], selectedPlanId: 7 })).toEqual({
      action: 'resolve',
      planId: '7',
      planName: '7',
    });
  });

  test('a selectedPlanId with no match in existingPlans throws, never trusted blindly', () => {
    expect(() =>
      resolveOrCreateTestPlan({ existingPlans: [{ id: 7 }], selectedPlanId: 999 })
    ).toThrow(/does not match any of the fetched existingPlans/);
  });
});

describe('resolveOrCreateTestPlan: creating a new plan', () => {
  test('a newPlanName produces a create decision, even when other plans exist', () => {
    expect(
      resolveOrCreateTestPlan({
        existingPlans: [{ id: 7, name: 'Unrelated Plan' }],
        newPlanName: 'Sprint 42 E2E Plan',
      })
    ).toEqual({ action: 'create', planName: 'Sprint 42 E2E Plan' });
  });

  test('a newPlanName is trimmed', () => {
    expect(resolveOrCreateTestPlan({ existingPlans: [], newPlanName: '  Sprint 42 E2E Plan  ' })).toEqual({
      action: 'create',
      planName: 'Sprint 42 E2E Plan',
    });
  });

  test('zero existing plans does not auto-create -- an explicit choice is still required', () => {
    expect(() => resolveOrCreateTestPlan({ existingPlans: [] })).toThrow(
      /selectedPlanId or newPlanName is required/
    );
  });
});

describe('resolveOrCreateTestPlan: never an auto-pick or an ambiguous choice', () => {
  test('neither selectedPlanId nor newPlanName given -> throws, never guesses', () => {
    expect(() => resolveOrCreateTestPlan({ existingPlans: [{ id: 1, name: 'Only Plan' }] })).toThrow(
      /selectedPlanId or newPlanName is required/
    );
  });

  test('both selectedPlanId and newPlanName given -> throws, ambiguous', () => {
    expect(() =>
      resolveOrCreateTestPlan({ existingPlans: [{ id: 1 }], selectedPlanId: 1, newPlanName: 'X' })
    ).toThrow(/not both/);
  });

  test('a whitespace-only newPlanName is treated as not given (still requires a real choice)', () => {
    expect(() => resolveOrCreateTestPlan({ existingPlans: [], newPlanName: '   ' })).toThrow(
      /selectedPlanId or newPlanName is required/
    );
  });
});

describe('resolveOrCreateTestPlan: input validation', () => {
  test('missing input entirely throws', () => {
    expect(() => resolveOrCreateTestPlan()).toThrow(/input must be an object/);
  });

  test('existingPlans must be an array', () => {
    expect(() => resolveOrCreateTestPlan({ existingPlans: 'not-an-array', newPlanName: 'X' })).toThrow(
      /existingPlans must be an array/
    );
  });

  test.each([
    ['missing id', [{ name: 'no id' }], /existingPlans\[0\]\.id must be a non-empty string or number/],
    ['non-object entry', ['not-an-object'], /existingPlans\[0\] must be an object/],
    [
      'non-string name',
      [{ id: 1, name: 42 }],
      /existingPlans\[0\]\.name must be a string when present/,
    ],
  ])('rejects an invalid existingPlans entry (%s)', (_label, existingPlans, expected) => {
    expect(() => resolveOrCreateTestPlan({ existingPlans, newPlanName: 'X' })).toThrow(expected);
  });

  test('selectedPlanId must be a non-empty string or number when present', () => {
    expect(() => resolveOrCreateTestPlan({ existingPlans: [{ id: 1 }], selectedPlanId: '' })).toThrow(
      /selectedPlanId must be a non-empty string or number/
    );
  });

  test('every error is collected in one throw, not just the first', () => {
    expect(() => resolveOrCreateTestPlan({ existingPlans: 'nope' })).toThrow(
      /existingPlans must be an array.*selectedPlanId or newPlanName is required/s
    );
  });
});

describe('recordCreatedPlan', () => {
  const createDecision = resolveOrCreateTestPlan({ existingPlans: [], newPlanName: 'Sprint 42 E2E Plan' });

  test('normalizes a valid MCP response', () => {
    expect(recordCreatedPlan(createDecision, { id: 321, name: 'Sprint 42 E2E Plan' })).toEqual({
      planId: '321',
      planName: 'Sprint 42 E2E Plan',
    });
  });

  test('falls back to the decision planName when mcpResponse omits name', () => {
    expect(recordCreatedPlan(createDecision, { id: 321 })).toEqual({
      planId: '321',
      planName: 'Sprint 42 E2E Plan',
    });
  });

  test('rejects recording against a resolve decision -- nothing was created', () => {
    const resolveDecision = resolveOrCreateTestPlan({
      existingPlans: [{ id: 7, name: 'Existing Plan' }],
      selectedPlanId: 7,
    });
    expect(() => recordCreatedPlan(resolveDecision, { id: 321 })).toThrow(/nothing was created/);
  });

  test('rejects a non-decision object', () => {
    expect(() => recordCreatedPlan({ planName: 'X' }, { id: 1 })).toThrow(
      /requires the 'create' decision returned by resolveOrCreateTestPlan/
    );
  });

  test('rejects an mcpResponse with no usable id', () => {
    expect(() => recordCreatedPlan(createDecision, {})).toThrow(
      /mcpResponse\.id must be a non-empty string or number/
    );
  });

  test('rejects a non-object mcpResponse', () => {
    expect(() => recordCreatedPlan(createDecision, null)).toThrow(/mcpResponse must be an object/);
  });
});
