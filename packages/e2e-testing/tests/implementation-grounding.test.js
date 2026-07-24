'use strict';

const { groundImplementation } = require('../lib/implementation-grounding');

/** Minimal tasksById fixture: one task satisfying REQ-002 with one target file. */
function trdWithTask({ id = 'TASK-002', satisfies = ['REQ-002'], targetFiles = ['lib/foo.js'] } = {}) {
  return { tasksById: { [id]: { id, satisfies, targetFiles } } };
}

describe('groundImplementation (AC-002-2: unmapped REQ reports a gap, not a guess)', () => {
  test('no task satisfies the REQ -> gap with a "no matching task" reason', () => {
    const parseTrd = jest.fn(() => trdWithTask({ satisfies: ['REQ-999'] }));
    const gitExec = jest.fn();
    const existsSync = jest.fn();

    const result = groundImplementation('REQ-002', 'docs/TRD/x.md', { parseTrd, gitExec, existsSync });

    expect(result.grounded).toBe(false);
    expect(result).toEqual(
      expect.objectContaining({ gap: true, reqId: 'REQ-002', trdPath: 'docs/TRD/x.md' })
    );
    expect(result.reason).toMatch(/no task .* satisfies/i);
    // No guess: git/fs must never be consulted once the REQ is unmapped.
    expect(gitExec).not.toHaveBeenCalled();
    expect(existsSync).not.toHaveBeenCalled();
  });

  test('empty tasksById -> gap (same "no matching task" path)', () => {
    const parseTrd = jest.fn(() => ({ tasksById: {} }));
    const result = groundImplementation('REQ-002', 'docs/TRD/x.md', { parseTrd, gitExec: jest.fn() });
    expect(result).toEqual(expect.objectContaining({ grounded: false, gap: true }));
    expect(result.reason).toMatch(/no task .* satisfies/i);
  });
});

describe('groundImplementation (missing arguments -> gap)', () => {
  test('missing reqId -> gap', () => {
    const result = groundImplementation(undefined, 'docs/TRD/x.md', {});
    expect(result).toEqual(
      expect.objectContaining({ grounded: false, gap: true, trdPath: 'docs/TRD/x.md' })
    );
    expect(result.reason).toMatch(/no req id/i);
  });

  test('missing trdPath -> gap', () => {
    const result = groundImplementation('REQ-002', undefined, {});
    expect(result).toEqual(expect.objectContaining({ grounded: false, gap: true, reqId: 'REQ-002' }));
    expect(result.reason).toMatch(/no trd path/i);
  });
});

describe('groundImplementation (unparseable TRD -> gap)', () => {
  test('parseTrd throws -> gap, error surfaced in reason, never propagated', () => {
    const parseTrd = jest.fn(() => {
      throw new Error('Unknown TRD format');
    });

    expect(() =>
      groundImplementation('REQ-002', 'docs/TRD/x.md', { parseTrd, gitExec: jest.fn() })
    ).not.toThrow();

    const result = groundImplementation('REQ-002', 'docs/TRD/x.md', { parseTrd, gitExec: jest.fn() });
    expect(result).toEqual(expect.objectContaining({ grounded: false, gap: true }));
    expect(result.reason).toMatch(/failed to parse trd/i);
    expect(result.reason).toMatch(/unknown trd format/i);
  });
});

describe('groundImplementation (task matches but declares no Target Files -> gap)', () => {
  test('matching task with empty targetFiles -> gap', () => {
    const parseTrd = jest.fn(() => trdWithTask({ targetFiles: [] }));
    const result = groundImplementation('REQ-002', 'docs/TRD/x.md', { parseTrd, gitExec: jest.fn() });
    expect(result).toEqual(expect.objectContaining({ grounded: false, gap: true }));
    expect(result.reason).toMatch(/target files/i);
  });

  test('matching task with no targetFiles property at all -> gap', () => {
    const parseTrd = jest.fn(() => ({
      tasksById: { 'TASK-002': { id: 'TASK-002', satisfies: ['REQ-002'] } },
    }));
    const result = groundImplementation('REQ-002', 'docs/TRD/x.md', { parseTrd, gitExec: jest.fn() });
    expect(result).toEqual(expect.objectContaining({ grounded: false, gap: true }));
    expect(result.reason).toMatch(/target files/i);
  });
});

describe('groundImplementation (merge-base unresolvable -> gap)', () => {
  test('gitExec fails for every base branch candidate -> gap', () => {
    const parseTrd = jest.fn(() => trdWithTask());
    const gitExec = jest.fn(() => {
      throw new Error('fatal: not a valid object name');
    });
    const existsSync = jest.fn();

    const result = groundImplementation('REQ-002', 'docs/TRD/x.md', { parseTrd, gitExec, existsSync });

    expect(result).toEqual(expect.objectContaining({ grounded: false, gap: true }));
    expect(result.reason).toMatch(/merge-base/i);
    // Never falls through to diffing files once the merge-base can't be found.
    expect(existsSync).not.toHaveBeenCalled();
  });
});

describe('groundImplementation (all target files missing on disk -> gap)', () => {
  test('existsSync false for every target file -> gap listing them as not found', () => {
    const parseTrd = jest.fn(() => trdWithTask({ targetFiles: ['lib/foo.js', 'lib/bar.js'] }));
    const gitExec = jest.fn(() => 'deadbeef\n');
    const existsSync = jest.fn(() => false);

    const result = groundImplementation('REQ-002', 'docs/TRD/x.md', { parseTrd, gitExec, existsSync });

    expect(result).toEqual(expect.objectContaining({ grounded: false, gap: true }));
    expect(result.reason).toMatch(/lib\/foo\.js/);
    expect(result.reason).toMatch(/lib\/bar\.js/);
    expect(result.reason).toMatch(/not found on disk/i);
  });
});

describe('groundImplementation (happy path baseline — not a gap)', () => {
  test('matching task, resolvable merge-base, existing file with a real diff -> grounded: true', () => {
    const parseTrd = jest.fn(() => trdWithTask({ targetFiles: ['lib/foo.js'] }));
    const gitExec = jest.fn((args) => {
      if (args[0] === 'merge-base') return 'deadbeef\n';
      if (args[0] === 'diff') return '+++ added a line\n';
      throw new Error(`unexpected git invocation: ${args.join(' ')}`);
    });
    const existsSync = jest.fn(() => true);

    const result = groundImplementation('REQ-002', 'docs/TRD/x.md', { parseTrd, gitExec, existsSync });

    expect(result.grounded).toBe(true);
    expect(result.gap).toBeUndefined();
    expect(result.reqId).toBe('REQ-002');
    expect(result.files).toEqual(['lib/foo.js']);
    expect(result.diffs).toEqual([{ file: 'lib/foo.js', diff: '+++ added a line\n' }]);
    expect(result.partialGaps).toEqual([]);
    expect(gitExec).toHaveBeenCalledWith(['merge-base', 'HEAD', 'main']);
    expect(gitExec).toHaveBeenCalledWith(['diff', 'deadbeef', 'HEAD', '--', 'lib/foo.js']);
  });
});
