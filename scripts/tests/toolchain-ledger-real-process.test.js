'use strict';
/**
 * Real-process coverage for TRD-2026-8d825f54 TRD-015 (PR 3 Runner): `runSequence` in
 * packages/development/lib/toolchain/ledger.js, proving br-31eh's (TRD-015-TEST) Test AC
 * scenarios against the REAL production path (PRD REQ-014, AC-014-1/AC-014-2/AC-014-3).
 *
 * `child_process` is never mocked anywhere in this file -- deliberately a separate file from
 * scripts/tests/toolchain-ledger.test.js, whose file-level `jest.mock('child_process')` would
 * otherwise apply (via Jest's mock hoisting) to any describe block added to that same file.
 * Every step below spawns a genuine `node <fixture script>.js <counterPath>` child process
 * through the real `runner.js#runCapability` (`execFile`, `shell:false`, no scripted
 * callback). Each fixture script (scripts/tests/fixtures/toolchain/real-ledger-steps/
 * {succeed,fail}.js) appends one line to a shared counter file every time it is actually
 * invoked, so the exact number of real spawns can be asserted directly -- proving AC-014-3 (no
 * retry, no resume) from an observed OS-level fact, not by inspecting a mock's call count.
 *
 * `loadContracts()` is never mocked either: the capability ids below (`worktree.create`,
 * `tracker.create`, `host.change-request-create`, `tracker.close`) are real capabilities
 * already declared by the real packages/development/toolchain/categories/
 * {worktree,tracker,host}.yaml contracts in this repo, each `sideEffect: true`, so
 * `capabilityHasSideEffect`'s real contract lookup is exercised too, not stubbed.
 * `worktree.create` + `tracker.create` succeeding before `host.change-request-create` fails
 * mirrors AC-014-1's own wording verbatim: "a branch and a work item were created" before the
 * adapter fails.
 *
 * Every temp path is created via `fs.mkdtempSync(path.join(os.tmpdir(), ...))` and removed in
 * `afterEach`; this file never reads or writes the real repo's own `.ensemble/state/`.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { runSequence } = require('../../packages/development/lib/toolchain/ledger');

const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'toolchain', 'real-ledger-steps');
const SUCCEED_SCRIPT = path.join(FIXTURES_DIR, 'succeed.js');
const FAIL_SCRIPT = path.join(FIXTURES_DIR, 'fail.js');

let tmpDirs;

beforeEach(() => {
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

/** A fresh tmp file path (inside its own fresh tmp dir) for fixture scripts to append to. */
function makeCounterPath() {
  return path.join(makeTmpDir('ledger-real-counter-'), 'counter.txt');
}

/** Number of real fixture-script invocations recorded in `counterPath` so far. */
function countInvocations(counterPath) {
  if (!fs.existsSync(counterPath)) return 0;
  return fs
    .readFileSync(counterPath, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0).length;
}

/**
 * Capability ids recorded, in order, in the real on-disk `ledger-<runId>.jsonl` file --
 * independent evidence of which side-effecting capabilities actually completed, written by
 * `recordSideEffect` as each one finishes. Used to verify the returned envelope's and the
 * failure record's `completedSideEffects` against real evidence instead of a hardcoded
 * literal that merely happens to match what the code is expected to produce.
 */
function readLedgerCapabilities(projectRoot, runId) {
  const ledgerPath = path.join(projectRoot, '.ensemble', 'state', 'toolchain', `ledger-${runId}.jsonl`);
  return fs
    .readFileSync(ledgerPath, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line).capability);
}

/**
 * Minimal real adapter manifest (module-local, matching the shape `runCapability`/
 * `good-adapter` already use): every capability really spawns
 * `node <fixture script>.js <counterPath>` via `${counterPath}` -> `{counterPath}` manifest
 * placeholder translation (the same translation a loaded `adapter.yaml`'s `run` template goes
 * through), substituted by the real `buildArgv`. `worktree.create`/`tracker.create`/
 * `host.change-request-create` mirror AC-014-1's wording; `tracker.close` stands in for a
 * step that must never be reached once `host.change-request-create` fails.
 */
function realLedgerAdapter() {
  return {
    adapter: 'real-ledger-adapter',
    binaries: [process.execPath],
    allowlist: [{ bin: process.execPath, sub: [SUCCEED_SCRIPT, FAIL_SCRIPT] }],
    capabilities: {
      'worktree.create': { run: [process.execPath, SUCCEED_SCRIPT, '${counterPath}'] },
      'tracker.create': { run: [process.execPath, SUCCEED_SCRIPT, '${counterPath}'] },
      'host.change-request-create': { run: [process.execPath, FAIL_SCRIPT, '${counterPath}'] },
      'tracker.close': { run: [process.execPath, SUCCEED_SCRIPT, '${counterPath}'] }
    }
  };
}

/** Steps: two real successes, then a real failure, then one more step that must never run. */
function stepsThroughFailure(counterPath) {
  return [
    { capability: 'worktree.create', args: { counterPath } },
    { capability: 'tracker.create', args: { counterPath } },
    { capability: 'host.change-request-create', args: { counterPath } },
    // Must never be reached: proves no retry/resume past the real failure (AC-014-3).
    { capability: 'tracker.close', args: { counterPath } }
  ];
}

const EXPECTED_FAILURE_MESSAGE =
  "real-ledger-adapter: capability 'host.change-request-create' failed: " +
  'fixture-ledger-fail: simulated adapter failure after prior side effects';

describe('Scenario 1 (AC-014-1): output lists side effects from a real failing sequence', () => {
  test('a branch and a work item are really created, then the adapter really fails: the returned envelope lists both and stops', async () => {
    const projectRoot = makeTmpDir('ledger-real-seq-');
    const counterPath = makeCounterPath();

    const result = await runSequence(
      realLedgerAdapter(),
      stepsThroughFailure(counterPath),
      { runId: 'real-run-ac1' },
      { projectRoot, env: {} }
    );

    expect(result.ok).toBe(false);
    // Independent evidence: the real on-disk ledger-<runId>.jsonl file, written by
    // `recordSideEffect` as each side-effecting capability actually completed, must agree
    // with the envelope's `completedSideEffects` -- not merely match a hardcoded literal that
    // happens to equal what the code is expected to produce.
    const ledgerCapabilities = readLedgerCapabilities(projectRoot, 'real-run-ac1');
    expect(ledgerCapabilities).toEqual(['worktree.create', 'tracker.create']);
    expect(result.completedSideEffects).toEqual(ledgerCapabilities);
    expect(result.failedCapability).toBe('host.change-request-create');
    expect(result.error).toEqual({ code: 'TOOL_FAILED', message: EXPECTED_FAILURE_MESSAGE });

    // Real OS-level proof the command actually stopped: only the 3 attempted steps really
    // spawned a process; tracker.close (the 4th step) never ran.
    expect(countInvocations(counterPath)).toBe(3);
  });
});

describe('Scenario 2 (AC-014-2): the real failure record is machine-readable', () => {
  test('failure-<runId>.json parses as JSON and names the real adapter, failed capability and completed side effects', async () => {
    const projectRoot = makeTmpDir('ledger-real-failure-');
    const counterPath = makeCounterPath();

    await runSequence(
      realLedgerAdapter(),
      stepsThroughFailure(counterPath),
      { runId: 'real-run-ac2' },
      { projectRoot, env: {} }
    );

    const failurePath = path.join(projectRoot, '.ensemble', 'state', 'toolchain', 'failure-real-run-ac2.json');
    expect(fs.existsSync(failurePath)).toBe(true);

    const raw = fs.readFileSync(failurePath, 'utf8');
    const record = JSON.parse(raw); // throws if the file is not machine-readable JSON

    expect(record.adapter).toBe('real-ledger-adapter');
    expect(record.capability).toBe('host.change-request-create');
    // Independent evidence, same as AC-014-1: compare against the real on-disk ledger file's
    // own capability list, not a hardcoded literal that happens to match recordFailure's
    // expected argument -- a stale/wrong/hardcoded completedSideEffects passed into
    // recordFailure would then disagree with this and fail.
    const ledgerCapabilities = readLedgerCapabilities(projectRoot, 'real-run-ac2');
    expect(ledgerCapabilities).toEqual(['worktree.create', 'tracker.create']);
    expect(record.completedSideEffects).toEqual(ledgerCapabilities);
    expect(record.error).toEqual({ code: 'TOOL_FAILED', message: EXPECTED_FAILURE_MESSAGE });
    expect(typeof record.timestamp).toBe('string');
    expect(Number.isNaN(Date.parse(record.timestamp))).toBe(false);
  });
});

describe('AC-014-1/AC-014-2 mutation resistance: completedSideEffects tracks the real run, not a fixed guess', () => {
  test('a differently-shaped real run (one side effect, not two, before failure) proves completedSideEffects is derived from this run\'s own evidence', async () => {
    const projectRoot = makeTmpDir('ledger-real-shortrun-');
    const counterPath = makeCounterPath();

    // Deliberately only one real side effect before the real failure -- a different shape
    // than every other scenario in this file, which all produce the same two-entry list. A
    // `completedSideEffects` that is hardcoded or stale to that canonical two-entry value
    // (instead of genuinely derived from this run's own accumulated side effects) is
    // observably wrong here, not merely coincidentally correct as it would be against a
    // scenario that happens to share the same two real side effects.
    const result = await runSequence(
      realLedgerAdapter(),
      [
        { capability: 'worktree.create', args: { counterPath } },
        { capability: 'host.change-request-create', args: { counterPath } }
      ],
      { runId: 'real-run-ac-short' },
      { projectRoot, env: {} }
    );

    expect(result.ok).toBe(false);

    const ledgerCapabilities = readLedgerCapabilities(projectRoot, 'real-run-ac-short');
    expect(ledgerCapabilities).toEqual(['worktree.create']);
    expect(result.completedSideEffects).toEqual(ledgerCapabilities);

    const failurePath = path.join(
      projectRoot,
      '.ensemble',
      'state',
      'toolchain',
      'failure-real-run-ac-short.json'
    );
    const record = JSON.parse(fs.readFileSync(failurePath, 'utf8'));
    expect(record.completedSideEffects).toEqual(ledgerCapabilities);
  });
});

describe('Scenario 3 (AC-014-3): no retry or resume after a real failure', () => {
  test('the real invocation counter shows exactly the steps attempted (2 successes + 1 failure), never the 4th step', async () => {
    const projectRoot = makeTmpDir('ledger-real-noretry-');
    const counterPath = makeCounterPath();

    const result = await runSequence(
      realLedgerAdapter(),
      stepsThroughFailure(counterPath),
      { runId: 'real-run-ac3' },
      { projectRoot, env: {} }
    );

    expect(result.ok).toBe(false);
    // Exactly 3 real child processes (worktree.create, tracker.create, host.change-request-create)
    // -- no retry of the failing step, and tracker.close (the 4th step) is never spawned.
    expect(countInvocations(counterPath)).toBe(3);
  });

  test('a second runSequence call with the same failing steps and a new runId is a fresh, independent run, not a resume of the first', async () => {
    const projectRoot = makeTmpDir('ledger-real-freshrun-');
    const counterPath = makeCounterPath();

    const first = await runSequence(
      realLedgerAdapter(),
      stepsThroughFailure(counterPath),
      { runId: 'real-run-ac3-first' },
      { projectRoot, env: {} }
    );
    expect(first.ok).toBe(false);
    expect(countInvocations(counterPath)).toBe(3);

    const second = await runSequence(
      realLedgerAdapter(),
      stepsThroughFailure(counterPath),
      { runId: 'real-run-ac3-second' },
      { projectRoot, env: {} }
    );

    // A fresh run really re-attempts its own 3 steps from the top (6 total): `runSequence` has
    // no notion of "resuming" `real-run-ac3-first` partway through, and does not skip steps
    // already completed under a different run id.
    expect(second.ok).toBe(false);
    expect(second.completedSideEffects).toEqual(['worktree.create', 'tracker.create']);
    expect(second.failedCapability).toBe('host.change-request-create');
    expect(countInvocations(counterPath)).toBe(6);

    // Two independent, real failure records exist side by side under their own run ids.
    const dir = path.join(projectRoot, '.ensemble', 'state', 'toolchain');
    expect(fs.existsSync(path.join(dir, 'failure-real-run-ac3-first.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'failure-real-run-ac3-second.json'))).toBe(true);
  });
});

describe('Real-process confirmatory coverage: a fully successful real sequence', () => {
  test('both real steps succeed: ok true, both side effects recorded, ledger file has exactly 2 real lines', async () => {
    const projectRoot = makeTmpDir('ledger-real-ok-');
    const counterPath = makeCounterPath();

    const result = await runSequence(
      realLedgerAdapter(),
      [
        { capability: 'worktree.create', args: { counterPath } },
        { capability: 'tracker.create', args: { counterPath } }
      ],
      { runId: 'real-run-ok' },
      { projectRoot, env: {} }
    );

    expect(result.ok).toBe(true);
    expect(result.completedSideEffects).toEqual(['worktree.create', 'tracker.create']);
    expect(countInvocations(counterPath)).toBe(2);

    const ledgerPath = path.join(projectRoot, '.ensemble', 'state', 'toolchain', 'ledger-real-run-ok.jsonl');
    const lines = fs
      .readFileSync(ledgerPath, 'utf8')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));

    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ capability: 'worktree.create', adapter: 'real-ledger-adapter' });
    expect(lines[1]).toMatchObject({ capability: 'tracker.create', adapter: 'real-ledger-adapter' });
  });
});
