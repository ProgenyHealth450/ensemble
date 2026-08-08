'use strict';

// TRD-019-TEST: Jest coverage for ado-sync-resilience.js's retry/flag
// decision logic (REQ-008). AC references:
//   - AC-008-1: ADO sync failure NEVER rolls back the already-landed local
//     test file -- the adversarial "never rollback" proof below is the
//     critical section of this file.
//   - AC-008-2: retry before the session ends, then flag unsynced with a
//     remediation note once MAX_SYNC_ATTEMPTS is exhausted.

const {
  MAX_SYNC_ATTEMPTS,
  VALID_DECISIONS,
  recordSyncAttempt,
  flagUnsynced,
} = require('../lib/ado-sync-resilience');
const { scanConfirmedAcs } = require('../lib/resume-scan');
const { groundImplementation } = require('../lib/implementation-grounding');
const { markManual } = require('../lib/manual-ac-tracker');

describe('recordSyncAttempt (AC-008-2: retry before session end, cap at MAX_SYNC_ATTEMPTS)', () => {
  test('exact attempt-count boundary: retry at attempts 1 and 2, flag-unsynced only at attempt 3', () => {
    expect(MAX_SYNC_ATTEMPTS).toBe(3);

    let result = recordSyncAttempt(null, { success: false, error: 'ECONNRESET' });
    expect(result.decision).toBe('retry');
    expect(result.state).toEqual({ attempts: 1, errors: ['ECONNRESET'] });

    result = recordSyncAttempt(result.state, { success: false, error: '401 Unauthorized' });
    expect(result.decision).toBe('retry'); // still 'retry' at attempt 2, not 'flag-unsynced'
    expect(result.state).toEqual({ attempts: 2, errors: ['ECONNRESET', '401 Unauthorized'] });

    result = recordSyncAttempt(result.state, { success: false, error: '500 Internal Server Error' });
    expect(result.decision).toBe('flag-unsynced'); // exactly at attempt 3 (the cap), not still 'retry'
    expect(result.state).toEqual({
      attempts: 3,
      errors: ['ECONNRESET', '401 Unauthorized', '500 Internal Server Error'],
    });
    expect(result.note).toBeUndefined(); // no retry-troubleshooting note once exhausted
  });

  test('recovery: a failure followed by a success reports "synced", keeping prior error history in state', () => {
    const failed = recordSyncAttempt(null, { success: false, error: 'ECONNRESET' });
    expect(failed.decision).toBe('retry');

    const recovered = recordSyncAttempt(failed.state, { success: true });
    expect(recovered).toEqual({ state: { attempts: 2, errors: ['ECONNRESET'] }, decision: 'synced' });
  });

  test('first attempt succeeds outright: attempts: 1, no error history, no note', () => {
    expect(recordSyncAttempt(null, { success: true })).toEqual({
      state: { attempts: 1, errors: [] },
      decision: 'synced',
    });
  });
});

describe('flagUnsynced', () => {
  const exhausted = () => {
    let state = null;
    for (const error of ['ECONNRESET', '401 Unauthorized', '500 Internal Server Error']) {
      state = recordSyncAttempt(state, { success: false, error }).state;
    }
    return state; // {attempts: 3, errors: [...]}
  };

  test('produces {acId, status: "unsynced", attempts, lastError, note} from an exhausted state', () => {
    expect(flagUnsynced('AC-008-1', exhausted())).toEqual({
      acId: 'AC-008-1',
      status: 'unsynced',
      attempts: 3,
      lastError: '500 Internal Server Error', // the most recent error, not the first
      note: expect.stringContaining('NOT rolled back'),
    });
  });

  test('throws when called on a state with no recorded failures', () => {
    expect(() => flagUnsynced('AC-008-1', { attempts: 0, errors: [] })).toThrow(
      /state\.errors must contain at least one recorded failure/
    );
  });

  test.each([
    ['null', null],
    ['undefined', undefined],
  ])('throws when state is %s', (_label, state) => {
    expect(() => flagUnsynced('AC-008-1', state)).toThrow(
      /state must be the object returned by recordSyncAttempt after at least one failed attempt/
    );
  });

  test.each([
    ['missing', undefined],
    ['blank', '   '],
  ])('throws given a %s acId', (_label, acId) => {
    expect(() => flagUnsynced(acId, exhausted())).toThrow(/acId must be a non-empty string/);
  });
});

describe('AC-008-1: sync failure NEVER rolls back the local test file (adversarial "never rollback" proof)', () => {
  const FORBIDDEN_KEYS = ['rollback', 'delete', 'revert', 'undo', 'remove'];

  /** Recursively collect every own key name appearing anywhere in `value`. */
  function collectKeys(value, found = new Set()) {
    if (Array.isArray(value)) {
      value.forEach((entry) => collectKeys(entry, found));
    } else if (value && typeof value === 'object') {
      for (const key of Object.keys(value)) {
        found.add(key);
        collectKeys(value[key], found);
      }
    }
    return found;
  }

  test('no forbidden key ever appears in any return value, even when the caller injects them into state and outcome across a full retry-to-exhaustion sequence', () => {
    const injectedErrors = ['ECONNRESET', '401 Unauthorized', '500 Internal Server Error'];
    let state = null;
    const returnValues = [];

    injectedErrors.forEach((error) => {
      // Adversarially poison both the state fed back in (as if a broken
      // orchestrator tried to smuggle a rollback instruction through the
      // accumulator) and the outcome argument itself.
      const poisonedState =
        state === null
          ? null
          : { ...state, rollback: true, delete: 'spec.ts', revert: () => {}, undo: [1, 2, 3], remove: { file: 'spec.ts' } };
      const poisonedOutcome = {
        success: false,
        error,
        rollback: true,
        delete: true,
        revert: 'yes',
        undo: 'now',
        remove: 'file',
      };

      const result = recordSyncAttempt(poisonedState, poisonedOutcome);
      returnValues.push(result);
      state = result.state; // only the legitimate {attempts, errors} shape carries forward
      expect(Object.keys(state).sort()).toEqual(['attempts', 'errors']);
    });

    expect(returnValues[returnValues.length - 1].decision).toBe('flag-unsynced');

    // flagUnsynced, also fed a poisoned (but otherwise-exhausted) state
    const poisonedExhaustedState = { ...state, rollback: true, delete: true, revert: true, undo: true, remove: true };
    returnValues.push(flagUnsynced('AC-008-1', poisonedExhaustedState));

    for (const returnValue of returnValues) {
      const keysFound = collectKeys(returnValue);
      for (const forbidden of FORBIDDEN_KEYS) {
        expect(keysFound.has(forbidden)).toBe(false);
      }
    }
  });

  test('VALID_DECISIONS never contains anything resembling a rollback/delete/undo action', () => {
    expect(VALID_DECISIONS).toEqual(['synced', 'retry', 'flag-unsynced']);
    for (const decision of VALID_DECISIONS) {
      expect(decision).not.toMatch(/rollback|delete|revert|undo|remove/i);
    }
  });
});

describe('recordSyncAttempt input validation', () => {
  test.each([
    ['a string', 'not an object'],
    ['a number', 42],
    ['non-integer attempts', { attempts: 1.5, errors: [] }],
    ['negative attempts', { attempts: -1, errors: [] }],
    ['non-array errors', { attempts: 1, errors: 'not-an-array' }],
    ['errors with non-string entries', { attempts: 1, errors: ['ok', 42] }],
  ])('rejects a malformed state (%s)', (_label, state) => {
    expect(() => recordSyncAttempt(state, { success: true })).toThrow(/Invalid recordSyncAttempt input/);
  });

  test('rejects success: true with an error present', () => {
    expect(() => recordSyncAttempt(null, { success: true, error: 'should not be here' })).toThrow(
      /outcome\.error must not be provided when outcome\.success is true/
    );
  });

  test('rejects success: false with no error', () => {
    expect(() => recordSyncAttempt(null, { success: false })).toThrow(
      /outcome\.error must be a non-empty string when outcome\.success is false/
    );
  });

  test.each([
    ['missing outcome', undefined],
    ['outcome without success', {}],
    ['non-boolean success', { success: 'yes' }],
  ])('rejects a malformed outcome (%s)', (_label, outcome) => {
    expect(() => recordSyncAttempt(null, outcome)).toThrow(/outcome/);
  });
});

describe('flagUnsynced input validation', () => {
  test('throws given a null state', () => {
    expect(() => flagUnsynced('AC-008-1', null)).toThrow(
      /state must be the object returned by recordSyncAttempt after at least one failed attempt/
    );
  });

  test('throws given a non-exhausted state (attempts recorded but no failures)', () => {
    expect(() => flagUnsynced('AC-008-1', { attempts: 1, errors: [] })).toThrow(
      /state\.errors must contain at least one recorded failure/
    );
  });
});

describe('status cross-check: "unsynced" never collides with the package\'s other per-AC outcome vocabularies', () => {
  test('distinct from resume-scan.js confirmed/pending, implementation-grounding.js grounded/gap, and manual-ac-tracker.js manual', () => {
    const exhausted = recordSyncAttempt(null, { success: false, error: 'x' }).state;
    const flagged = flagUnsynced('AC-008-1', exhausted);
    expect(flagged.status).toBe('unsynced');

    const scan = scanConfirmedAcs(['no tags here'], ['AC-001-1']);
    expect(Object.keys(scan).sort()).toEqual(['confirmed', 'pending']);
    expect(flagged.status).not.toBe('confirmed');
    expect(flagged.status).not.toBe('pending');

    const grounding = groundImplementation(); // no reqId/trdPath -> a real 'gap' result
    expect(grounding).toEqual(expect.objectContaining({ grounded: false, gap: true }));
    expect(flagged.status).not.toBe('grounded');
    expect(flagged.status).not.toBe('gap');

    const manual = markManual('AC-017-1');
    expect(flagged.status).not.toBe(manual.status);
  });
});
