'use strict';
/**
 * Real-process coverage for TRD-2026-8d825f54 TRD-011 (PR 3 Runner), reviewer Finding 3: on
 * timeout, `runner.js#runCapability` must kill not just the direct child `execFile` spawned but
 * also any descendant it spawned and detached before the timeout fired (reproduced by the
 * independent review: "allowlisted script spawns detached `node sleep.js 300` and unrefs;
 * TIMEOUT returned, grandchild lived on PPID 1"). `child_process` is never mocked in this file:
 * every process below is genuinely spawned, and liveness is checked with a real `kill(pid, 0)`.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { runCapability } = require('../../packages/development/lib/toolchain/runner');
const {
  makeMutantToolchainRoot,
  mutateAndRequire
} = require('./fixtures/toolchain/mutant-toolchain-copy');

const HANG_SCRIPT = path.join(
  __dirname,
  'fixtures',
  'toolchain',
  'real-timeout-containment',
  'spawn-detached-grandchild-and-hang.js'
);

const tempDirs = [];
const livePidsToCleanUp = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

afterAll(() => {
  // Best-effort final sweep: if an assertion above threw before a grandchild was confirmed
  // dead, make sure no straggler sleeper outlives this test file.
  while (livePidsToCleanUp.length > 0) {
    const pid = livePidsToCleanUp.pop();
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
});

function mkTmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toolchain-timeout-containment-'));
  tempDirs.push(dir);
  return path.join(dir, 'grandchild-pid.txt');
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Polls until `pid` is confirmed dead or `deadlineMs` elapses, returning final liveness. */
async function waitUntilDead(pid, deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  while (isAlive(pid) && Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop -- intentional poll loop, generous margins.
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return isAlive(pid);
}

function hangAdapter() {
  return {
    adapter: 'fixture-hang-tracker',
    binaries: [process.execPath],
    allowlist: [{ bin: process.execPath, sub: [HANG_SCRIPT] }],
    capabilities: {
      'tracker.show': { run: [process.execPath, HANG_SCRIPT, '${outFile}'] }
    }
  };
}

/** Reads the fixture's two-line output: `[directChildPid, grandchildPid]`. */
function readPidFile(outFile) {
  const lines = fs.readFileSync(outFile, 'utf8').split('\n').filter(Boolean);
  return [Number(lines[0]), Number(lines[1])];
}

describe('reviewer Finding 3: timeout kills the whole process tree, not just the direct child (real process)', () => {
  test('a grandchild the direct child spawned detached and unref-ed is also gone after the timeout', async () => {
    const outFile = mkTmpFile();

    const started = Date.now();
    const result = await runCapability(hangAdapter(), 'tracker.show', { outFile }, { timeoutMs: 1500 });
    const elapsed = Date.now() - started;

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('TIMEOUT');
    expect(elapsed).toBeLessThan(3000);

    const [directPid, grandchildPid] = readPidFile(outFile);
    expect(Number.isInteger(grandchildPid)).toBe(true);
    livePidsToCleanUp.push(grandchildPid);

    const stillAlive = await waitUntilDead(grandchildPid, 4000);
    expect(stillAlive).toBe(false);
    expect(isAlive(directPid)).toBe(false);
  }, 10000);
});

describe('mutation-restore proof: reviewer Finding 3 actually discriminates (real process)', () => {
  test('removing the supplemental descendant kill on timeout lets the detached grandchild survive', async () => {
    const mutantRoot = makeMutantToolchainRoot();
    try {
      const needle = 'const verified = killVerifiedPidsSafe(toVerify);';
      const replacement = 'const verified = true; /* supplemental kill removed by mutation */';
      const mutatedRunner = mutateAndRequire(mutantRoot.runnerPath, needle, replacement);

      const outFile = mkTmpFile();
      const result = await mutatedRunner.runCapability(
        hangAdapter(),
        'tracker.show',
        { outFile },
        { timeoutMs: 1500 }
      );
      expect(result.ok).toBe(false);
      expect(result.error.code).toBe('TIMEOUT');

      const [, grandchildPid] = readPidFile(outFile);
      livePidsToCleanUp.push(grandchildPid);

      // With the supplemental kill removed, only execFile's own direct-child kill runs, which
      // never reaches the detached grandchild -- exactly what the real (unmutated) test above
      // disproves. Give it the SAME generous window as the real test before asserting survival,
      // so this isn't just a race won by checking too early.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      expect(isAlive(grandchildPid)).toBe(true);
    } finally {
      // Always clean up the survivor this mutation test deliberately leaves alive.
      for (const pid of livePidsToCleanUp.splice(0)) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // already gone
        }
      }
      mutantRoot.cleanup();
    }
  }, 10000);

  test('when identity verification itself fails, the direct child is still killed via its tracked handle, even though the grandchild cannot be reached', async () => {
    const mutantRoot = makeMutantToolchainRoot();
    try {
      // Forces `killVerifiedPidsSafe` to never even run (as if a real `ps` failure had been
      // reported), proving the fallback path -- not the identity-verified path -- is what kills
      // the direct child here.
      const needle = 'const verified = killVerifiedPidsSafe(toVerify);';
      const replacement = 'const verified = false; /* forced verification failure */';
      const mutatedRunner = mutateAndRequire(mutantRoot.runnerPath, needle, replacement);

      const outFile = mkTmpFile();
      const result = await mutatedRunner.runCapability(
        hangAdapter(),
        'tracker.show',
        { outFile },
        { timeoutMs: 1500 }
      );
      expect(result.ok).toBe(false);
      expect(result.error.code).toBe('TIMEOUT');

      const [directPid, grandchildPid] = readPidFile(outFile);
      livePidsToCleanUp.push(grandchildPid);

      // The direct child is still reliably killed (via `child.kill('SIGKILL')`, the fallback --
      // not via the pid-identity path, which never ran).
      const directStillAlive = await waitUntilDead(directPid, 4000);
      expect(directStillAlive).toBe(false);

      // The grandchild, unreachable without a working process-table read, survives: the
      // fallback deliberately never signals an unverified raw pid.
      await new Promise((resolve) => setTimeout(resolve, 1000));
      expect(isAlive(grandchildPid)).toBe(true);
    } finally {
      for (const pid of livePidsToCleanUp.splice(0)) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // already gone
        }
      }
      mutantRoot.cleanup();
    }
  }, 10000);
});
