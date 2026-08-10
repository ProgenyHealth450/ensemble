'use strict';

// TRD-020-TEST: Jest coverage for ac-gap-detector.js's semantic-gap
// flag/review logic (REQ-009). AC references:
//   - AC-009-1: a genuine gap (grounded code that doesn't satisfy the AC) is
//     flagged, not silently passed over.
//   - AC-009-2: the QA engineer's review either confirms the gap or overrides it,
//     redirecting grounding at the corrected code path.

const { flagAcGap, resolveGapReview } = require('../lib/ac-gap-detector');
const { groundImplementation } = require('../lib/implementation-grounding');
const { scanConfirmedAcs } = require('../lib/resume-scan');
const { markManual } = require('../lib/manual-ac-tracker');
const { recordSyncAttempt, flagUnsynced } = require('../lib/ado-sync-resilience');

const groundedResult = {
  grounded: true,
  reqId: 'REQ-009',
  files: ['src/handlers/submitClaim.js'],
  diffs: [{ file: 'src/handlers/submitClaim.js', diff: '+ return res.status(501).end(); // TODO' }],
  partialGaps: [],
};

describe('flagAcGap (AC-009-1: a genuine gap is flagged, not silently passed over)', () => {
  test('valid grounded:true result + reason -> fully recorded ac-gap, nothing silently dropped', () => {
    const result = flagAcGap('AC-009-1', {
      reqId: 'REQ-009',
      groundingResult: groundedResult,
      reason: 'handler is a 501 stub; described validation logic does not exist yet',
    });

    expect(result).toEqual({
      status: 'ac-gap',
      acId: 'AC-009-1',
      reqId: 'REQ-009',
      reason: 'handler is a 501 stub; described validation logic does not exist yet',
      groundedFiles: ['src/handlers/submitClaim.js'],
      review: null,
    });
    // every field genuinely present -- an adversarial "silently dropped" bug
    // would show up as an undefined value here, not just a missing key.
    for (const key of ['status', 'acId', 'reqId', 'reason', 'groundedFiles', 'review']) {
      expect(result[key]).not.toBeUndefined();
    }
    expect(result.review).toBeNull();
  });

  test('groundedFiles defaults to [] when groundingResult has no files array, never undefined', () => {
    const result = flagAcGap('AC-009-1', {
      reqId: 'REQ-009',
      groundingResult: { grounded: true },
      reason: 'x',
    });
    expect(result.groundedFiles).toEqual([]);
  });

  test('groundedFiles is a copy, not a live reference into groundingResult.files', () => {
    const files = ['a.js'];
    const result = flagAcGap('AC-009-1', {
      reqId: 'REQ-009',
      groundingResult: { grounded: true, files },
      reason: 'x',
    });
    files.push('b.js');
    expect(result.groundedFiles).toEqual(['a.js']);
  });
});

describe('flagAcGap rejects a structural (grounded: false) groundingResult', () => {
  test('a real grounding-lookup gap (from implementation-grounding.js itself) is rejected, not silently accepted', () => {
    const structuralGap = groundImplementation(); // no reqId/trdPath -> a real {grounded:false, gap:true} result
    expect(structuralGap).toEqual(expect.objectContaining({ grounded: false, gap: true }));

    expect(() =>
      flagAcGap('AC-009-1', { reqId: 'REQ-009', groundingResult: structuralGap, reason: 'x' })
    ).toThrow(/grounded: true/);
  });

  test('grounded: false explicitly -> throws the same, never converted into an ac-gap', () => {
    expect(() =>
      flagAcGap('AC-009-1', { reqId: 'REQ-009', groundingResult: { grounded: false }, reason: 'x' })
    ).toThrow(/grounded: true/);
  });
});

describe('flagAcGap validation', () => {
  test.each([
    ['missing', undefined],
    ['empty string', ''],
    ['whitespace-only', '   '],
    ['non-string', 123],
  ])('rejects a %s acId', (_label, acId) => {
    expect(() =>
      flagAcGap(acId, { reqId: 'REQ-009', groundingResult: groundedResult, reason: 'x' })
    ).toThrow(/acId must be a non-empty string/);
  });

  test('missing context entirely throws', () => {
    expect(() => flagAcGap('AC-009-1', undefined)).toThrow(/context is required/);
  });

  test('missing reqId throws', () => {
    expect(() => flagAcGap('AC-009-1', { groundingResult: groundedResult, reason: 'x' })).toThrow(
      /reqId must be a non-empty string/
    );
  });

  test.each([
    ['missing', undefined],
    ['empty string', ''],
    ['whitespace-only', '   '],
  ])('rejects a %s reason', (_label, reason) => {
    expect(() =>
      flagAcGap('AC-009-1', { reqId: 'REQ-009', groundingResult: groundedResult, reason })
    ).toThrow(/reason must be a non-empty string/);
  });

  test('missing groundingResult throws', () => {
    expect(() => flagAcGap('AC-009-1', { reqId: 'REQ-009', reason: 'x' })).toThrow(
      /groundingResult is required/
    );
  });

  test.each([
    ['a string', 'not-an-object'],
    ['a number', 42],
    ['null', null],
  ])('rejects a non-object groundingResult (%s)', (_label, groundingResult) => {
    expect(() => flagAcGap('AC-009-1', { reqId: 'REQ-009', groundingResult, reason: 'x' })).toThrow(
      /groundingResult is required/
    );
  });
});

describe('resolveGapReview "confirmed" path (AC-009-2)', () => {
  test('confirmed with a note -> gap-confirmed, note preserved', () => {
    expect(resolveGapReview('AC-009-1', 'confirmed', { note: 'filed on Story 4821' })).toEqual({
      outcome: 'gap-confirmed',
      acId: 'AC-009-1',
      note: 'filed on Story 4821',
    });
  });

  test('confirmed with no details -> gap-confirmed, note: null (never a forced default string)', () => {
    expect(resolveGapReview('AC-009-1', 'confirmed')).toEqual({
      outcome: 'gap-confirmed',
      acId: 'AC-009-1',
      note: null,
    });
  });

  test('confirmed never requires correctedTargetFiles', () => {
    expect(() => resolveGapReview('AC-009-1', 'confirmed', {})).not.toThrow();
  });
});

describe('resolveGapReview "override" path (AC-009-2: redirects grounding at the corrected code path)', () => {
  test('override -> gap-overridden with correctedTargetFiles + note', () => {
    const result = resolveGapReview('AC-009-1', 'override', {
      correctedTargetFiles: ['src/handlers/validateClaim.js'],
      note: 'grounding looked at the wrong handler',
    });
    expect(result).toEqual({
      outcome: 'gap-overridden',
      acId: 'AC-009-1',
      correctedTargetFiles: ['src/handlers/validateClaim.js'],
      note: 'grounding looked at the wrong handler',
    });
  });

  test('correctedTargetFiles is a copy, not a live reference', () => {
    const files = ['src/handlers/validateClaim.js'];
    const result = resolveGapReview('AC-009-1', 'override', { correctedTargetFiles: files });
    files.push('src/other.js');
    expect(result.correctedTargetFiles).toEqual(['src/handlers/validateClaim.js']);
  });

  test('correctedTargetFiles composes directly into a re-grounding groundImplementation() call', () => {
    const overridden = resolveGapReview('AC-009-1', 'override', {
      correctedTargetFiles: ['src/handlers/validateClaim.js'],
    });

    // Simulate the orchestrator's redirect: feed the overridden
    // correctedTargetFiles straight in as the task's targetFiles and confirm
    // a fresh groundImplementation() call grounds against exactly that
    // corrected path -- no real git repo needed, using its injectable opts.
    const parseTrd = jest.fn(() => ({
      tasksById: {
        'TASK-009': { id: 'TASK-009', satisfies: ['REQ-009'], targetFiles: overridden.correctedTargetFiles },
      },
    }));
    const gitExec = jest.fn((args) => {
      if (args[0] === 'merge-base') return 'deadbeef\n';
      if (args[0] === 'diff') return '+++ corrected validation logic added\n';
      throw new Error(`unexpected git invocation: ${args.join(' ')}`);
    });
    const existsSync = jest.fn(() => true);

    const regrounded = groundImplementation('REQ-009', 'docs/TRD/x.md', { parseTrd, gitExec, existsSync });

    expect(regrounded.grounded).toBe(true);
    expect(regrounded.files).toEqual(overridden.correctedTargetFiles);
    expect(regrounded.diffs).toEqual([
      { file: 'src/handlers/validateClaim.js', diff: '+++ corrected validation logic added\n' },
    ]);
    expect(gitExec).toHaveBeenCalledWith(['diff', 'deadbeef', 'HEAD', '--', 'src/handlers/validateClaim.js']);
  });
});

describe('resolveGapReview rejects "override" with missing/empty/non-array correctedTargetFiles', () => {
  test('missing details entirely throws', () => {
    expect(() => resolveGapReview('AC-009-1', 'override')).toThrow(/correctedTargetFiles is required/);
  });

  test('details given but correctedTargetFiles key missing throws', () => {
    expect(() => resolveGapReview('AC-009-1', 'override', { note: 'x' })).toThrow(
      /correctedTargetFiles is required/
    );
  });

  test('empty array throws', () => {
    expect(() => resolveGapReview('AC-009-1', 'override', { correctedTargetFiles: [] })).toThrow(
      /correctedTargetFiles is required/
    );
  });

  test.each([
    ['a string', 'src/foo.js'],
    ['a number', 42],
    ['an object', { file: 'src/foo.js' }],
  ])('non-array correctedTargetFiles (%s) throws', (_label, correctedTargetFiles) => {
    expect(() => resolveGapReview('AC-009-1', 'override', { correctedTargetFiles })).toThrow(
      /correctedTargetFiles is required/
    );
  });
});

describe('resolveGapReview rejects an invalid decision value with no silent default', () => {
  test.each([
    ['typo', 'maybe'],
    ['wrong case (confirmed)', 'Confirmed'],
    ['wrong case (override)', 'Override'],
    ['empty string', ''],
  ])('%s decision "%s" throws, never silently defaults', (_label, decision) => {
    expect(() => resolveGapReview('AC-009-1', decision)).toThrow(/Invalid decision/);
  });
});

describe('status collision check: "ac-gap" never collides with the package\'s other per-AC status vocabularies', () => {
  test('distinct from resume-scan confirmed/pending, manual-ac-tracker manual, ado-sync-resilience unsynced, and implementation-grounding grounded/gap', () => {
    const flagged = flagAcGap('AC-009-1', { reqId: 'REQ-009', groundingResult: groundedResult, reason: 'x' });
    expect(flagged.status).toBe('ac-gap');

    const scan = scanConfirmedAcs(['no tags here'], ['AC-001-1']);
    expect(Object.keys(scan).sort()).toEqual(['confirmed', 'pending']);
    expect(flagged.status).not.toBe('confirmed');
    expect(flagged.status).not.toBe('pending');

    const manual = markManual('AC-017-1');
    expect(flagged.status).not.toBe(manual.status);

    const exhausted = recordSyncAttempt(null, { success: false, error: 'x' }).state;
    const unsynced = flagUnsynced('AC-008-1', exhausted);
    expect(flagged.status).not.toBe(unsynced.status);

    const structuralGap = groundImplementation(); // {grounded: false, gap: true, ...}
    expect(structuralGap).toEqual(expect.objectContaining({ grounded: false, gap: true }));
    expect(flagged.status).not.toBe('grounded');
    expect(flagged.status).not.toBe('gap');
  });
});
