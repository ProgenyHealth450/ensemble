'use strict';

// TRD-040-TEST: Jest coverage for delegation-contract.js's two-stage
// Proposal/Run contract (TRD-040 split the original single "ground, author,
// run" delegation so the orchestrator has a seam to present a plain-English
// summary and get the QA engineer's accept/request-changes/reject decision
// before a test ever runs against the QA environment).

const {
  validateProposalRequest,
  validateProposalResponse,
  validateRunRequest,
  validateRunResponse,
} = require('../lib/delegation-contract');

function validProposalRequest(overrides = {}) {
  return {
    acText: 'Given ... when ... then ...',
    groundingDiff: { grounded: true, diffs: [] },
    ...overrides,
  };
}

describe('validateProposalRequest', () => {
  test('a well-formed request passes', () => {
    expect(validateProposalRequest(validProposalRequest())).toBe(true);
  });

  test('missing fields collect every error, never silently pass', () => {
    expect(() => validateProposalRequest({})).toThrow(/acText.*groundingDiff/s);
  });

  test('missing request entirely throws', () => {
    expect(() => validateProposalRequest()).toThrow(/request must be an object/);
  });
});

function validProposalResponse(overrides = {}) {
  return {
    proposedTest: "test('...', async () => {});",
    selectorsUsed: ['[data-testid="submit"]'],
    plainEnglishSummary: 'Logs in as a standard user and confirms the dashboard loads.',
    ...overrides,
  };
}

describe('validateProposalResponse', () => {
  test('a well-formed proposal is valid', () => {
    expect(validateProposalResponse(validProposalResponse())).toBe(true);
  });

  test('an explicit authoringFailure is valid, and skips the proposedTest/selectors/summary checks', () => {
    expect(
      validateProposalResponse({ authoringFailure: true, reason: 'no stable selector found' })
    ).toBe(true);
  });

  test('authoringFailure with no reason throws', () => {
    expect(() => validateProposalResponse({ authoringFailure: true })).toThrow(/reason/);
  });

  test('plainEnglishSummary missing entirely throws (TRD-040: QA engineer must see it before the run)', () => {
    expect(() =>
      validateProposalResponse(validProposalResponse({ plainEnglishSummary: undefined }))
    ).toThrow(/plainEnglishSummary must be a non-empty string/);
  });

  test('a whitespace-only plainEnglishSummary throws', () => {
    expect(() => validateProposalResponse(validProposalResponse({ plainEnglishSummary: '   ' }))).toThrow(
      /plainEnglishSummary must be a non-empty string/
    );
  });

  test('proposedTest missing throws', () => {
    expect(() => validateProposalResponse(validProposalResponse({ proposedTest: '' }))).toThrow(
      /proposedTest must be a non-empty string/
    );
  });

  test('selectorsUsed must be an array', () => {
    expect(() => validateProposalResponse(validProposalResponse({ selectorsUsed: 'nope' }))).toThrow(
      /selectorsUsed must be an array/
    );
  });

  test('missing response entirely throws', () => {
    expect(() => validateProposalResponse()).toThrow(/response must be an object/);
  });
});

function validRunRequest(overrides = {}) {
  return {
    acText: 'Given ... when ... then ...',
    groundingDiff: { grounded: true, diffs: [] },
    proposedTest: "test('...', async () => {});",
    targetEnv: 'https://qa.example.com',
    mode: 'headed',
    ...overrides,
  };
}

describe('validateRunRequest', () => {
  test('a well-formed request passes', () => {
    expect(validateRunRequest(validRunRequest())).toBe(true);
  });

  test('missing fields collect every error, never silently pass', () => {
    expect(() => validateRunRequest({})).toThrow(/acText.*groundingDiff.*proposedTest.*targetEnv.*mode/s);
  });

  test('an invalid mode throws', () => {
    expect(() => validateRunRequest(validRunRequest({ mode: 'slow' }))).toThrow();
  });

  describe('authStatePath (optional, but must be non-empty when present)', () => {
    test('omitted entirely -> still valid (not every target uses stored auth state)', () => {
      expect(validateRunRequest(validRunRequest())).toBe(true);
    });

    test('a non-empty string -> valid', () => {
      expect(validateRunRequest(validRunRequest({ authStatePath: 'auth-state.qa-example-com.json' }))).toBe(true);
    });

    test.each([
      ['empty string', ''],
      ['whitespace-only', '   '],
      ['number', 42],
      ['object', {}],
    ])('%s -> throws', (_label, value) => {
      expect(() => validateRunRequest(validRunRequest({ authStatePath: value }))).toThrow(/authStatePath/);
    });
  });
});

function validRunResponse(overrides = {}) {
  return {
    runResult: { passed: true },
    ...overrides,
  };
}

describe('validateRunResponse', () => {
  test('a passing run result is valid', () => {
    expect(validateRunResponse(validRunResponse())).toBe(true);
  });

  test('a failing run result is valid', () => {
    expect(validateRunResponse(validRunResponse({ runResult: { passed: false, details: 'assertion failed' } }))).toBe(
      true
    );
  });

  test('runResult missing entirely -> throws', () => {
    expect(() => validateRunResponse({})).toThrow(/runResult/);
  });

  test('runResult.passed missing -> throws', () => {
    expect(() => validateRunResponse({ runResult: {} })).toThrow(/runResult must have a boolean `passed` field/);
  });

  describe('environmentMismatchSuspected / groundedMarkersChecked (TRD-035)', () => {
    test('a failed run with environmentMismatchSuspected + groundedMarkersChecked is valid', () => {
      expect(
        validateRunResponse(
          validRunResponse({
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
        validateRunResponse(validRunResponse({ runResult: { passed: true, environmentMismatchSuspected: true } }))
      ).toThrow(/environmentMismatchSuspected may only be true when passed is false/);
    });

    test('environmentMismatchSuspected: false on a passing result is fine (no signal either way)', () => {
      expect(
        validateRunResponse(validRunResponse({ runResult: { passed: true, environmentMismatchSuspected: false } }))
      ).toBe(true);
    });

    test('a non-boolean environmentMismatchSuspected throws', () => {
      expect(() =>
        validateRunResponse(validRunResponse({ runResult: { passed: false, environmentMismatchSuspected: 'yes' } }))
      ).toThrow(/environmentMismatchSuspected must be a boolean/);
    });

    test('a non-array groundedMarkersChecked throws', () => {
      expect(() =>
        validateRunResponse(validRunResponse({ runResult: { passed: false, groundedMarkersChecked: 'nav-icon-stack' } }))
      ).toThrow(/groundedMarkersChecked must be an array/);
    });

    test('both fields omitted on a failed result is still valid (no regression for callers that never check)', () => {
      expect(validateRunResponse(validRunResponse({ runResult: { passed: false, details: 'x' } }))).toBe(true);
    });
  });
});
