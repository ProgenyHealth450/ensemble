'use strict';

const { validateDelegationRequest, validateDelegationResponse } = require('../lib/delegation-contract');

function validRequest(overrides = {}) {
  return {
    acText: 'Given ... when ... then ...',
    groundingDiff: { grounded: true, diffs: [] },
    targetEnv: 'https://qa.example.com',
    mode: 'headed',
    ...overrides,
  };
}

describe('validateDelegationRequest', () => {
  test('a well-formed request passes', () => {
    expect(validateDelegationRequest(validRequest())).toBe(true);
  });

  test('missing fields collect every error, never silently pass', () => {
    expect(() => validateDelegationRequest({})).toThrow(/acText.*groundingDiff.*targetEnv.*mode/s);
  });

  test('an invalid mode throws', () => {
    expect(() => validateDelegationRequest(validRequest({ mode: 'slow' }))).toThrow();
  });

  describe('authStatePath (TRD-036: optional, but must be non-empty when present)', () => {
    test('omitted entirely -> still valid (not every target uses stored auth state)', () => {
      expect(validateDelegationRequest(validRequest())).toBe(true);
    });

    test('a non-empty string -> valid', () => {
      expect(validateDelegationRequest(validRequest({ authStatePath: 'auth-state.qa-example-com.json' }))).toBe(true);
    });

    test.each([
      ['empty string', ''],
      ['whitespace-only', '   '],
      ['number', 42],
      ['object', {}],
    ])('%s -> throws', (_label, value) => {
      expect(() => validateDelegationRequest(validRequest({ authStatePath: value }))).toThrow(/authStatePath/);
    });
  });
});

function validResponse(overrides = {}) {
  return {
    proposedTest: "test('...', async () => {});",
    selectorsUsed: ['[data-testid="submit"]'],
    runResult: { passed: true },
    ...overrides,
  };
}

describe('validateDelegationResponse', () => {
  test('a passing run result is valid', () => {
    expect(validateDelegationResponse(validResponse())).toBe(true);
  });

  test('an explicit authoringFailure is valid', () => {
    expect(
      validateDelegationResponse(
        validResponse({ runResult: { authoringFailure: true, reason: 'no stable selector found' } })
      )
    ).toBe(true);
  });

  test('runResult missing entirely -> throws', () => {
    expect(() => validateDelegationResponse({ proposedTest: 'x', selectorsUsed: [] })).toThrow(/runResult/);
  });

  test('authoringFailure with no reason -> throws', () => {
    expect(() =>
      validateDelegationResponse(validResponse({ runResult: { authoringFailure: true } }))
    ).toThrow(/reason/);
  });

  describe('environmentMismatchSuspected / groundedMarkersChecked (TRD-035)', () => {
    test('a failed run with environmentMismatchSuspected + groundedMarkersChecked is valid', () => {
      expect(
        validateDelegationResponse(
          validResponse({
            runResult: {
              passed: false,
              details: 'assertion failed',
              environmentMismatchSuspected: true,
              groundedMarkersChecked: ['nav-icon-stack'],
            },
          })
        )
      ).toBe(true);
    });

    test('a passing run never carries environmentMismatchSuspected: true', () => {
      expect(() =>
        validateDelegationResponse(validResponse({ runResult: { passed: true, environmentMismatchSuspected: true } }))
      ).toThrow(/environmentMismatchSuspected may only be true when passed is false/);
    });

    test('environmentMismatchSuspected: false on a passing result is fine (no signal either way)', () => {
      expect(
        validateDelegationResponse(validResponse({ runResult: { passed: true, environmentMismatchSuspected: false } }))
      ).toBe(true);
    });

    test('a non-boolean environmentMismatchSuspected throws', () => {
      expect(() =>
        validateDelegationResponse(validResponse({ runResult: { passed: false, environmentMismatchSuspected: 'yes' } }))
      ).toThrow(/environmentMismatchSuspected must be a boolean/);
    });

    test('a non-array groundedMarkersChecked throws', () => {
      expect(() =>
        validateDelegationResponse(validResponse({ runResult: { passed: false, groundedMarkersChecked: 'nav-icon-stack' } }))
      ).toThrow(/groundedMarkersChecked must be an array/);
    });

    test('both fields omitted on a failed result is still valid (no regression for callers that never check)', () => {
      expect(validateDelegationResponse(validResponse({ runResult: { passed: false, details: 'x' } }))).toBe(true);
    });
  });
});
