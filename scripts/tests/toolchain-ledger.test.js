'use strict';
/**
 * Tests for TRD-2026-8d825f54 TRD-015 (PR 3 Runner): `recordSideEffect`, `recordFailure` and
 * `runSequence` in packages/development/lib/toolchain/ledger.js (PRD REQ-014,
 * AC-014-1/AC-014-2/AC-014-3).
 *
 * `child_process` is mocked throughout (same pattern as toolchain-runner.test.js) so no real
 * process is ever spawned and the exact spawn call count can be asserted. Every test uses an
 * `os.tmpdir()`-scoped `projectRoot` (and, where relevant, a separate tmp dir for
 * `FOREMAN_ARTIFACT_PATH`) -- never the real repo tree -- and removes it in `afterEach`.
 */

jest.mock('child_process');

jest.mock('../../packages/development/lib/toolchain/contracts', () => {
  const actual = jest.requireActual('../../packages/development/lib/toolchain/contracts');
  return { ...actual, loadContracts: jest.fn(actual.loadContracts) };
});

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const { recordSideEffect, recordFailure, runSequence } = require('../../packages/development/lib/toolchain/ledger');
const { loadContracts } = require('../../packages/development/lib/toolchain/contracts');

const SECRET_TOKEN = `ghp_${'x'.repeat(36)}`;
const AWS_SECRET_TOKEN = 'AKIAIOSFODNN7EXAMPLE';

function fixtureAdapter() {
  return {
    adapter: 'fixture-ledger-adapter',
    binaries: ['fixture-tool'],
    allowlist: [
      { bin: 'fixture-tool', sub: ['worktree-create', 'tracker-create', 'host-open-cr', 'tracker-close', 'noop'] }
    ],
    capabilities: {
      'worktree.create': { run: ['fixture-tool', 'worktree-create'] },
      'tracker.create': { run: ['fixture-tool', 'tracker-create'] },
      'tracker.show': { run: ['fixture-tool', 'noop'] },
      'tracker.close': { run: ['fixture-tool', 'tracker-close'] },
      'host.change-request-create': { run: ['fixture-tool', 'host-open-cr'] },
      'unmapped.op': { run: ['fixture-tool', 'noop'] }
    }
  };
}

let tmpDirs;

beforeEach(() => {
  execFile.mockReset();
  tmpDirs = [];
});

afterEach(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function readJsonLines(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  return content
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

/**
 * Mocks execFile to succeed on the first `succeedCount` calls, then fail on the next call with
 * `failureStderr`, then succeed on any further call (so a bug that keeps invoking steps past
 * the failure is observable via an unexpectedly high call count rather than hidden by an error).
 */
function mockSucceedThenFail(succeedCount, failureStderr) {
  let calls = 0;
  execFile.mockImplementation((file, cmdArgs, options, callback) => {
    calls += 1;
    if (calls <= succeedCount) {
      setImmediate(() => callback(null, '{}', ''));
    } else if (calls === succeedCount + 1) {
      setImmediate(() => callback(new Error('fixture-tool exited 1'), '', failureStderr));
    } else {
      setImmediate(() => callback(null, '{}', ''));
    }
  });
}

describe('runSequence: report-only failure policy (Implementation AC scenario 1 and 6)', () => {
  test('lists completed side effects and the failed capability; stops immediately, no retry, no later step', async () => {
    mockSucceedThenFail(2, 'fixture-tool: denied by host\n');
    const projectRoot = makeTmpDir('ledger-seq-');

    const steps = [
      { capability: 'worktree.create', args: { branch: 'b1' } },
      { capability: 'tracker.create', args: { title: 't1' } },
      { capability: 'host.change-request-create', args: {} },
      // Must never be reached: proves no retry/resume past the failing step.
      { capability: 'tracker.close', args: { id: 'A-1' } }
    ];

    const result = await runSequence(fixtureAdapter(), steps, { runId: 'run-1' }, { projectRoot, env: {} });

    expect(result.ok).toBe(false);
    expect(result.completedSideEffects).toEqual(['worktree.create', 'tracker.create']);
    expect(result.failedCapability).toBe('host.change-request-create');
    expect(result.error).toBeDefined();

    // Exactly 3 execFile calls: the 2 successes plus the 1 failure. The 4th step
    // (tracker.close) is never invoked.
    expect(execFile).toHaveBeenCalledTimes(3);
  });

  test('a fully successful sequence records every side-effecting step and none is skipped', async () => {
    mockSucceedThenFail(99, 'unused');
    const projectRoot = makeTmpDir('ledger-seq-ok-');

    const steps = [
      { capability: 'worktree.create', args: {} },
      { capability: 'tracker.create', args: {} }
    ];

    const result = await runSequence(fixtureAdapter(), steps, { runId: 'run-ok' }, { projectRoot, env: {} });

    expect(result.ok).toBe(true);
    expect(result.completedSideEffects).toEqual(['worktree.create', 'tracker.create']);
    expect(execFile).toHaveBeenCalledTimes(2);
  });

  test('a successful non-side-effecting capability (sideEffect:false) is not recorded as completed', async () => {
    mockSucceedThenFail(99, 'unused');
    const projectRoot = makeTmpDir('ledger-seq-noeffect-');

    const result = await runSequence(
      fixtureAdapter(),
      [{ capability: 'tracker.show', args: { id: 'A-1' } }],
      { runId: 'run-noeffect' },
      { projectRoot, env: {} }
    );

    expect(result.ok).toBe(true);
    expect(result.completedSideEffects).toEqual([]);
    // No ledger file should exist: nothing with a side effect was ever recorded.
    const ledgerPath = path.join(projectRoot, '.ensemble', 'state', 'toolchain', 'ledger-run-noeffect.jsonl');
    expect(fs.existsSync(ledgerPath)).toBe(false);
  });

  test('a successful capability with no matching category contract is not recorded as completed', async () => {
    mockSucceedThenFail(99, 'unused');
    const projectRoot = makeTmpDir('ledger-seq-unmapped-');

    const result = await runSequence(
      fixtureAdapter(),
      [{ capability: 'unmapped.op', args: {} }],
      { runId: 'run-unmapped' },
      { projectRoot, env: {} }
    );

    expect(result.ok).toBe(true);
    expect(result.completedSideEffects).toEqual([]);
  });
});

describe('runSequence + recordFailure: failure-<runId>.json shape (Implementation AC scenario 2)', () => {
  test('parses as JSON with non-empty adapter, capability and a completedSideEffects array of length 2', async () => {
    mockSucceedThenFail(2, 'fixture-tool: denied by host\n');
    const projectRoot = makeTmpDir('ledger-failure-shape-');

    await runSequence(
      fixtureAdapter(),
      [
        { capability: 'worktree.create', args: {} },
        { capability: 'tracker.create', args: {} },
        { capability: 'host.change-request-create', args: {} }
      ],
      { runId: 'run-shape' },
      { projectRoot, env: {} }
    );

    const failurePath = path.join(projectRoot, '.ensemble', 'state', 'toolchain', 'failure-run-shape.json');
    const record = JSON.parse(fs.readFileSync(failurePath, 'utf8'));

    expect(typeof record.adapter).toBe('string');
    expect(record.adapter.length).toBeGreaterThan(0);
    expect(typeof record.capability).toBe('string');
    expect(record.capability.length).toBeGreaterThan(0);
    expect(Array.isArray(record.completedSideEffects)).toBe(true);
    expect(record.completedSideEffects).toHaveLength(2);
  });

  test('with FOREMAN_ARTIFACT_PATH set, an identical file exists there too', async () => {
    mockSucceedThenFail(2, 'fixture-tool: denied by host\n');
    const projectRoot = makeTmpDir('ledger-failure-artifact-');
    const artifactDir = makeTmpDir('ledger-artifact-');
    const artifactPath = path.join(artifactDir, 'failure.json');

    await runSequence(
      fixtureAdapter(),
      [
        { capability: 'worktree.create', args: {} },
        { capability: 'tracker.create', args: {} },
        { capability: 'host.change-request-create', args: {} }
      ],
      { runId: 'run-artifact' },
      { projectRoot, env: { FOREMAN_ARTIFACT_PATH: artifactPath } }
    );

    const failurePath = path.join(projectRoot, '.ensemble', 'state', 'toolchain', 'failure-run-artifact.json');
    expect(fs.existsSync(artifactPath)).toBe(true);
    expect(fs.readFileSync(artifactPath, 'utf8')).toBe(fs.readFileSync(failurePath, 'utf8'));
  });

  test('without FOREMAN_ARTIFACT_PATH set, no artifact mirror is written', async () => {
    mockSucceedThenFail(2, 'fixture-tool: denied by host\n');
    const projectRoot = makeTmpDir('ledger-failure-noartifact-');

    const outcome = recordFailure(
      'run-no-artifact',
      { adapter: 'a', capability: 'c', completedSideEffects: [], error: { code: 'X', message: 'm' } },
      { projectRoot, env: {} }
    );

    expect(outcome.artifactPath).toBeNull();
  });

  test("the written error object matches the runner's real {code, message} for the injected failure, not just typeof checks", async () => {
    mockSucceedThenFail(2, 'fixture-tool: denied by host\n');
    const projectRoot = makeTmpDir('ledger-failure-error-value-');

    await runSequence(
      fixtureAdapter(),
      [
        { capability: 'worktree.create', args: {} },
        { capability: 'tracker.create', args: {} },
        { capability: 'host.change-request-create', args: {} }
      ],
      { runId: 'run-error-value' },
      { projectRoot, env: {} }
    );

    const failurePath = path.join(projectRoot, '.ensemble', 'state', 'toolchain', 'failure-run-error-value.json');
    const record = JSON.parse(fs.readFileSync(failurePath, 'utf8'));

    expect(record.error).toEqual({
      code: 'TOOL_FAILED',
      message: "fixture-ledger-adapter: capability 'host.change-request-create' failed: fixture-tool: denied by host"
    });
  });
});

describe('recordFailure: secret redaction (Implementation AC scenario 3)', () => {
  test('a ghp_ token present in the failing capability stderr never appears in the written failure file', async () => {
    mockSucceedThenFail(2, `fixture-tool: denied, saw credential ${SECRET_TOKEN}\n`);
    const projectRoot = makeTmpDir('ledger-redact-');

    await runSequence(
      fixtureAdapter(),
      [
        { capability: 'worktree.create', args: {} },
        { capability: 'tracker.create', args: {} },
        { capability: 'host.change-request-create', args: {} }
      ],
      { runId: 'run-redact' },
      { projectRoot, env: {} }
    );

    const failurePath = path.join(projectRoot, '.ensemble', 'state', 'toolchain', 'failure-run-redact.json');
    const raw = fs.readFileSync(failurePath, 'utf8');

    expect(raw).not.toContain(SECRET_TOKEN);
    expect(raw).toContain('REDACTED');
  });

  test('a differently-shaped secret (AWS-access-key style, not ghp_/36-char) is also redacted, proving redaction is not hardcoded to one token shape', () => {
    const projectRoot = makeTmpDir('ledger-redact-shape2-');

    recordSideEffect(
      'run-redact-shape2',
      { capability: 'worktree.create', adapter: 'fixture-ledger-adapter', args: { branch: `feature/${AWS_SECRET_TOKEN}` } },
      { projectRoot }
    );

    const ledgerPath = path.join(projectRoot, '.ensemble', 'state', 'toolchain', 'ledger-run-redact-shape2.jsonl');
    const raw = fs.readFileSync(ledgerPath, 'utf8');

    expect(raw).not.toContain(AWS_SECRET_TOKEN);
    expect(raw).toContain('REDACTED');
  });

  test('ledger.js reuses complexity-analyzer#redactSecrets rather than defining its own secret-pattern list', () => {
    const ledgerSource = fs.readFileSync(
      path.join(__dirname, '..', '..', 'packages', 'development', 'lib', 'toolchain', 'ledger.js'),
      'utf8'
    );

    expect(ledgerSource).toContain("require('../complexity-analyzer')");
    expect(ledgerSource.includes('AKIA[')).toBe(false);
    expect(ledgerSource.includes('SECRET_PATTERNS')).toBe(false);
    expect(ledgerSource.includes('gh[pousr]_')).toBe(false);
    expect(ledgerSource.includes('new RegExp')).toBe(false);
  });
});

describe('.gitignore: .ensemble/state/ is ignored (Implementation AC scenario 4)', () => {
  test('the repo .gitignore contains a .ensemble/state/ entry', () => {
    const gitignorePath = path.join(__dirname, '..', '..', '.gitignore');
    const content = fs.readFileSync(gitignorePath, 'utf8');
    const lines = content.split('\n').map((line) => line.trim());
    expect(lines).toContain('.ensemble/state/');
  });
});

describe('recordSideEffect: no interleaved records across concurrent run ids (Implementation AC scenario 5)', () => {
  test('two run ids appending ledger lines in rapid succession each parse line-by-line as valid JSON', () => {
    const projectRoot = makeTmpDir('ledger-concurrent-');

    for (let i = 0; i < 5; i += 1) {
      recordSideEffect('run-a', { capability: 'worktree.create', adapter: 'x', seq: i }, { projectRoot });
      recordSideEffect('run-b', { capability: 'tracker.create', adapter: 'y', seq: i }, { projectRoot });
    }

    const dir = path.join(projectRoot, '.ensemble', 'state', 'toolchain');
    const linesA = readJsonLines(path.join(dir, 'ledger-run-a.jsonl'));
    const linesB = readJsonLines(path.join(dir, 'ledger-run-b.jsonl'));

    expect(linesA).toHaveLength(5);
    expect(linesB).toHaveLength(5);
    expect(linesA.map((l) => l.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(linesB.map((l) => l.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(linesA.every((l) => l.capability === 'worktree.create')).toBe(true);
    expect(linesB.every((l) => l.capability === 'tracker.create')).toBe(true);
  });
});

describe('path-traversal guard on runId (fail closed)', () => {
  test('recordSideEffect rejects a runId containing "/"', () => {
    const projectRoot = makeTmpDir('ledger-traversal-slash-');
    expect(() => recordSideEffect('a/b', { capability: 'x' }, { projectRoot })).toThrow(/runId/);
  });

  test('recordSideEffect rejects a runId containing "\\\\"', () => {
    const projectRoot = makeTmpDir('ledger-traversal-backslash-');
    expect(() => recordSideEffect('a\\b', { capability: 'x' }, { projectRoot })).toThrow(/runId/);
  });

  test('recordFailure rejects a runId containing ".."', () => {
    const projectRoot = makeTmpDir('ledger-traversal-dotdot-');
    expect(() =>
      recordFailure('../escape', { adapter: 'a', capability: 'c', completedSideEffects: [], error: {} }, { projectRoot })
    ).toThrow(/runId/);
  });

  test('runSequence rejects a missing/non-string runId before spawning anything', async () => {
    mockSucceedThenFail(99, 'unused');
    const projectRoot = makeTmpDir('ledger-traversal-missing-');
    await expect(
      runSequence(fixtureAdapter(), [{ capability: 'worktree.create', args: {} }], {}, { projectRoot, env: {} })
    ).rejects.toThrow(/runId/);
    expect(execFile).not.toHaveBeenCalled();
  });

  test('runSequence rejects a runId containing path-traversal characters before spawning or writing anything to disk', async () => {
    mockSucceedThenFail(99, 'unused');
    const projectRoot = makeTmpDir('ledger-traversal-runsequence-');

    await expect(
      runSequence(
        fixtureAdapter(),
        [{ capability: 'worktree.create', args: {} }],
        { runId: '../escape' },
        { projectRoot, env: {} }
      )
    ).rejects.toThrow(/runId/);

    expect(execFile).not.toHaveBeenCalled();
    // Nothing written anywhere: not at the unsafe path, not at a silently-substituted safe
    // id, not even the state directory itself.
    const stateDir = path.join(projectRoot, '.ensemble', 'state', 'toolchain');
    expect(fs.existsSync(stateDir)).toBe(false);
  });

  test('a valid runId is accepted and writes under the expected state directory', () => {
    const projectRoot = makeTmpDir('ledger-traversal-valid-');
    const filePath = recordSideEffect('run-valid-123', { capability: 'x' }, { projectRoot });
    expect(filePath).toBe(path.join(projectRoot, '.ensemble', 'state', 'toolchain', 'ledger-run-valid-123.jsonl'));
    expect(fs.existsSync(filePath)).toBe(true);
  });
});

describe('capabilityHasSideEffect: classification comes from the loaded category contract, not a hardcoded capability name', () => {
  test("the same capability id is recorded or skipped depending only on its contract's sideEffect flag", async () => {
    mockSucceedThenFail(99, 'unused');
    const projectRoot = makeTmpDir('ledger-contract-sideeffect-');
    const adapter = fixtureAdapter();
    adapter.capabilities['fixture.op'] = { run: ['fixture-tool', 'noop'] };

    const actualContracts = jest.requireActual('../../packages/development/lib/toolchain/contracts');

    const trueDir = makeTmpDir('ledger-contract-true-');
    fs.writeFileSync(path.join(trueDir, 'fixture.yaml'), 'capabilities:\n  fixture.op:\n    sideEffect: true\n');
    loadContracts.mockImplementationOnce(() => actualContracts.loadContracts(trueDir));

    const resultTrue = await runSequence(
      adapter,
      [{ capability: 'fixture.op', args: {} }],
      { runId: 'run-contract-true' },
      { projectRoot, env: {} }
    );

    expect(resultTrue.completedSideEffects).toEqual(['fixture.op']);
    expect(
      fs.existsSync(path.join(projectRoot, '.ensemble', 'state', 'toolchain', 'ledger-run-contract-true.jsonl'))
    ).toBe(true);

    const falseDir = makeTmpDir('ledger-contract-false-');
    fs.writeFileSync(path.join(falseDir, 'fixture.yaml'), 'capabilities:\n  fixture.op:\n    sideEffect: false\n');
    loadContracts.mockImplementationOnce(() => actualContracts.loadContracts(falseDir));

    const resultFalse = await runSequence(
      adapter,
      [{ capability: 'fixture.op', args: {} }],
      { runId: 'run-contract-false' },
      { projectRoot, env: {} }
    );

    expect(resultFalse.completedSideEffects).toEqual([]);
    expect(
      fs.existsSync(path.join(projectRoot, '.ensemble', 'state', 'toolchain', 'ledger-run-contract-false.jsonl'))
    ).toBe(false);
  });
});

describe('ledger line shape and step order: {capability, adapter, args, timestamp} and real execFile call order', () => {
  test('each ledger line matches exactly what was passed for its step, with a real recent timestamp, and execFile is invoked in step order', async () => {
    mockSucceedThenFail(99, 'unused');
    const projectRoot = makeTmpDir('ledger-line-fields-');
    const before = Date.now();

    const steps = [
      { capability: 'worktree.create', args: { branch: 'feature-a' } },
      { capability: 'tracker.create', args: { title: 'ticket title' } }
    ];

    const result = await runSequence(fixtureAdapter(), steps, { runId: 'run-line-fields' }, { projectRoot, env: {} });
    const after = Date.now();

    expect(result.ok).toBe(true);

    const ledgerPath = path.join(projectRoot, '.ensemble', 'state', 'toolchain', 'ledger-run-line-fields.jsonl');
    const lines = readJsonLines(ledgerPath);
    expect(lines).toHaveLength(2);

    expect(lines[0]).toMatchObject({
      capability: 'worktree.create',
      adapter: 'fixture-ledger-adapter',
      args: { branch: 'feature-a' }
    });
    expect(lines[1]).toMatchObject({
      capability: 'tracker.create',
      adapter: 'fixture-ledger-adapter',
      args: { title: 'ticket title' }
    });

    for (const line of lines) {
      expect(typeof line.timestamp).toBe('string');
      const ts = Date.parse(line.timestamp);
      expect(Number.isNaN(ts)).toBe(false);
      expect(ts).toBeGreaterThanOrEqual(before);
      expect(ts).toBeLessThanOrEqual(after);
    }

    // Step order asserted directly from execFile's own call arguments (binary + subcommand),
    // not only inferred from the resulting completedSideEffects array shape.
    expect(execFile).toHaveBeenCalledTimes(2);
    expect(execFile.mock.calls[0][0]).toBe('fixture-tool');
    expect(execFile.mock.calls[0][1]).toEqual(['worktree-create']);
    expect(execFile.mock.calls[1][0]).toBe('fixture-tool');
    expect(execFile.mock.calls[1][1]).toEqual(['tracker-create']);
  });
});
