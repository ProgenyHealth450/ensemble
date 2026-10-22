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
const { execFileSync } = require('child_process');

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

const DELAYED_HANG_SCRIPT = path.join(
  __dirname,
  'fixtures',
  'toolchain',
  'real-timeout-containment',
  'spawn-detached-grandchild-after-delay-and-hang.js'
);

const RUN_HANG_CAPABILITY_DRIVER = path.join(
  __dirname,
  'fixtures',
  'toolchain',
  'real-timeout-containment',
  'run-hang-capability.js'
);

const REAL_RUNNER_MODULE_PATH = path.join(
  __dirname,
  '..',
  '..',
  'packages',
  'development',
  'lib',
  'toolchain',
  'runner.js'
);

const FAKE_PS_NO_LSTART_DIR = path.join(
  __dirname,
  'fixtures',
  'toolchain',
  'real-timeout-containment',
  'fake-ps-bin'
);

const FAKE_PS_VANISHING_DIR = path.join(
  __dirname,
  'fixtures',
  'toolchain',
  'real-timeout-containment',
  'fake-ps-vanishing-bin'
);

/**
 * Runs the hang-and-spawn-a-grandchild capability in a FRESH node subprocess (see
 * `run-hang-capability.js`'s own header for why: a live `process.env.PATH` mutation inside an
 * already-running jest test process does not reliably change PATH-based executable resolution
 * under this repo's test runner). `runnerModulePath` lets a mutation test point at a mutated
 * copy instead of the real module. `extraPathDir`, when given, is prepended to the subprocess's
 * OWN `PATH` from birth.
 *
 * @returns {{result: unknown, killCalls: unknown[]}}
 */
function runHangCapabilityInSubprocess({ runnerModulePath, outFile, timeoutMs, extraPathDir, extraEnv }) {
  const resultFile = `${outFile}.result.json`;
  const env = { ...process.env, ...extraEnv };
  if (extraPathDir) {
    env.PATH = `${extraPathDir}${path.delimiter}${env.PATH}`;
  }
  execFileSync(
    process.execPath,
    [RUN_HANG_CAPABILITY_DRIVER, runnerModulePath, HANG_SCRIPT, outFile, String(timeoutMs), resultFile],
    { env, timeout: timeoutMs + 8000 }
  );
  return JSON.parse(fs.readFileSync(resultFile, 'utf8'));
}

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

/** Like `hangAdapter`, but the grandchild spawn is delayed by `delayMs`. */
function delayedHangAdapter(delayMs) {
  return {
    adapter: 'fixture-delayed-hang-tracker',
    binaries: [process.execPath],
    allowlist: [{ bin: process.execPath, sub: [DELAYED_HANG_SCRIPT] }],
    capabilities: {
      'tracker.show': { run: [process.execPath, DELAYED_HANG_SCRIPT, '${outFile}', String(delayMs)] }
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
    const result = await runCapability(hangAdapter(), 'tracker.show', { outFile }, { timeoutMs: 3000 });
    const elapsed = Date.now() - started;

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('TIMEOUT');
    expect(elapsed).toBeLessThan(5000);

    const [directPid, grandchildPid] = readPidFile(outFile);
    expect(Number.isInteger(grandchildPid)).toBe(true);
    livePidsToCleanUp.push(grandchildPid);

    const stillAlive = await waitUntilDead(grandchildPid, 6000);
    expect(stillAlive).toBe(false);
    expect(isAlive(directPid)).toBe(false);
  }, 15000);
});

describe('mutation-restore proof: reviewer Finding 3 actually discriminates (real process)', () => {
  test('removing the supplemental descendant kill on timeout lets the detached grandchild survive', async () => {
    const mutantRoot = makeMutantToolchainRoot();
    try {
      const needle = 'const verified = !neverObservedRoot && killVerifiedPidsSafe(toVerify);';
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
      const needle = 'const verified = !neverObservedRoot && killVerifiedPidsSafe(toVerify);';
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

describe('reviewer round 3, P2: a ps that cannot report lstart never masks verification failure as success (real process)', () => {
  test('with PATH shadowed by a ps lacking lstart support, the root identity is never observed: TIMEOUT is still returned, the direct child is still dead, the handle fallback is actually attempted (not skipped as "nothing to check"), and the grandchild -- unreachable without a working process table -- survives as documented', () => {
    const outFile = mkTmpFile();

    const { result, killCalls } = runHangCapabilityInSubprocess({
      runnerModulePath: REAL_RUNNER_MODULE_PATH,
      outFile,
      timeoutMs: 1500,
      extraPathDir: FAKE_PS_NO_LSTART_DIR
    });

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('TIMEOUT');

    const [directPid, grandchildPid] = readPidFile(outFile);
    livePidsToCleanUp.push(grandchildPid);

    // `verified` must be reported false (never a vacuous true from an empty "nothing to
    // verify" map that was actually "never managed to observe anything"), so the handle
    // fallback is attempted -- even though the direct child is already reaped by execFile's
    // own timeout handling by the time this runs, making the call itself a safe no-op. Node's
    // own internal timeout-kill mechanism also calls `.kill()`, with the numeric signal value
    // (9) rather than the string this module always passes, so asserting on the STRING form is
    // what proves this specific call came from `runner.js`'s own fallback, not Node's.
    expect(killCalls).toContain('SIGKILL');
    expect(isAlive(directPid)).toBe(false);

    // Documented limitation (this file's module header, "Known limits"): without a working
    // `ps`, descendant containment degrades to direct-child-only; the grandchild cannot be
    // discovered at all and survives. This test is about `verified`'s own honesty, not about
    // reaching an unreachable descendant.
    expect(isAlive(grandchildPid)).toBe(true);
  }, 15000);
});

describe('mutation-restore proof: the never-observed-root guard actually discriminates (real process)', () => {
  test('removing the neverObservedRoot guard lets an empty (never-populated) identity map report a vacuous true, so the handle fallback is never even attempted', () => {
    const mutantRoot = makeMutantToolchainRoot();
    try {
      const needle =
        'const neverObservedRoot =\n' +
        '                rootPid !== null && process.platform !== \'win32\' && rootIdentity === null;\n' +
        '              const verified = !neverObservedRoot && killVerifiedPidsSafe(toVerify);';
      const replacement = '              const verified = killVerifiedPidsSafe(toVerify);';
      mutateAndRequire(mutantRoot.runnerPath, needle, replacement);

      const outFile = mkTmpFile();
      const { result, killCalls } = runHangCapabilityInSubprocess({
        runnerModulePath: mutantRoot.runnerPath,
        outFile,
        timeoutMs: 1500,
        extraPathDir: FAKE_PS_NO_LSTART_DIR
      });

      expect(result.ok).toBe(false);
      expect(result.error.code).toBe('TIMEOUT');

      const [, grandchildPid] = readPidFile(outFile);
      livePidsToCleanUp.push(grandchildPid);

      // With the guard removed, `killVerifiedPidsSafe(emptyMap)` hits its own "nothing to
      // verify" shortcut and reports a vacuous `true`, so the handle fallback is never even
      // attempted -- exactly what the real (unmutated) test above disproves (there, the
      // fallback IS attempted even though it finds nothing left to do).
      expect(killCalls).not.toContain('SIGKILL');
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
  }, 15000);
});

/**
 * Applies one or more mandatory string replacements to a mutant-root copy of `runner.js` and
 * `require()`s the result fresh, bypassing Node's module cache (`mutateAndRequire` only
 * supports a single replacement per call and does not clear the cache between calls, so it
 * cannot be called twice against the same path). Used below to combine the real
 * "disable periodic polling" test scaffold with an OPTIONAL second mutation under test, so
 * both share the exact same deterministic setup.
 */
function mutateManyAndRequire(filePath, replacements) {
  let content = fs.readFileSync(filePath, 'utf8');
  for (const { needle, replacement } of replacements) {
    if (!content.includes(needle)) {
      throw new Error(`mutateManyAndRequire: needle not found in ${filePath}: ${JSON.stringify(needle)}`);
    }
    content = content.replace(needle, replacement);
  }
  fs.writeFileSync(filePath, content);
  delete require.cache[require.resolve(filePath)];
  // eslint-disable-next-line global-require, import/no-dynamic-require
  return require(filePath);
}

const DISABLE_PERIODIC_POLL_NEEDLE = 'const PROCESS_TREE_POLL_MS = 100;';
// Effectively disables the REGULAR periodic poll within any test's short lifetime (it would
// still fire once, eventually, but never inside a run that times out in well under a minute),
// isolating the PROACTIVE pre-deadline poll (`FINAL_POLL_MARGIN_MS` before the timeout, see
// runner.js's header) as the ONLY mechanism that can discover a descendant spawned after the
// immediate post-spawn read -- sidesteps real-clock timing fragility (measured on this
// machine: a single real `listProcessTable()` call alone takes ~20ms) by using a generous
// ~1-second margin instead of trying to land a spawn inside the real, narrow gap the proactive
// poll itself targets.
const DISABLE_PERIODIC_POLL_REPLACEMENT = 'const PROCESS_TREE_POLL_MS = 60000;';

const PROACTIVE_POLL_NEEDLE =
  '        const finalPollDelay = Math.max(0, timeoutMs - FINAL_POLL_MARGIN_MS);\n' +
  '        finalPollTimer = setTimeout(refreshIdentities, finalPollDelay);\n' +
  '        if (typeof finalPollTimer.unref === \'function\') finalPollTimer.unref();';
const PROACTIVE_POLL_REMOVED_REPLACEMENT = '        // proactive pre-deadline poll removed by mutation';

describe('reviewer round 3, P3: the proactive pre-deadline poll catches a descendant spawned after the last regular poll tick (real process)', () => {
  test('with regular periodic polling effectively disabled, a grandchild spawned well after the immediate post-spawn read (but well before the deadline) is still discovered and killed by the proactive poll alone', async () => {
    const mutantRoot = makeMutantToolchainRoot();
    try {
      const mutatedRunner = mutateManyAndRequire(mutantRoot.runnerPath, [
        { needle: DISABLE_PERIODIC_POLL_NEEDLE, replacement: DISABLE_PERIODIC_POLL_REPLACEMENT }
      ]);

      const outFile = mkTmpFile();
      const timeoutMs = 4000;
      // FINAL_POLL_MARGIN_MS is 500, so the proactive poll fires at ~3500ms -- spawning at
      // 1500ms leaves a comfortable ~2000ms margin before the proactive poll and ~500ms after
      // it before the deadline, no precise timing needed.
      const delayMs = 1500;

      const result = await mutatedRunner.runCapability(
        delayedHangAdapter(delayMs),
        'tracker.show',
        { outFile },
        { timeoutMs }
      );

      expect(result.ok).toBe(false);
      expect(result.error.code).toBe('TIMEOUT');

      const [directPid, grandchildPid] = readPidFile(outFile);
      expect(Number.isInteger(grandchildPid)).toBe(true);
      livePidsToCleanUp.push(grandchildPid);

      const stillAlive = await waitUntilDead(grandchildPid, 4000);
      expect(stillAlive).toBe(false);
      expect(isAlive(directPid)).toBe(false);
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
  }, 20000);
});

describe('mutation-restore proof: reviewer round 3, P3 (proactive pre-deadline poll) actually discriminates (real process)', () => {
  test('additionally removing the proactive poll lets that same late-spawned grandchild survive', async () => {
    const mutantRoot = makeMutantToolchainRoot();
    try {
      const mutatedRunner = mutateManyAndRequire(mutantRoot.runnerPath, [
        { needle: DISABLE_PERIODIC_POLL_NEEDLE, replacement: DISABLE_PERIODIC_POLL_REPLACEMENT },
        { needle: PROACTIVE_POLL_NEEDLE, replacement: PROACTIVE_POLL_REMOVED_REPLACEMENT }
      ]);

      const outFile = mkTmpFile();
      const timeoutMs = 2000;
      const delayMs = 1000;

      const result = await mutatedRunner.runCapability(
        delayedHangAdapter(delayMs),
        'tracker.show',
        { outFile },
        { timeoutMs }
      );
      expect(result.ok).toBe(false);
      expect(result.error.code).toBe('TIMEOUT');

      const [directPid, grandchildPid] = readPidFile(outFile);
      livePidsToCleanUp.push(grandchildPid);

      expect(isAlive(directPid)).toBe(false);
      // With BOTH regular periodic polling disabled AND the proactive poll removed, nothing
      // ever learns about this grandchild (the one-time immediate post-spawn read at t=0 ran
      // well before it was spawned) -- exactly what the real (unmutated, polling-disabled)
      // test above disproves.
      await new Promise((resolve) => setTimeout(resolve, 1500));
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
  }, 15000);
});

describe('reviewer round 4 follow-up: descendantIdentities survives a ppid-walk that transiently loses the relationship (real process)', () => {
  test('a grandchild discovered by early polls, then unreachable via collectDescendants on every later poll (its row still exists, just no longer ppid-linked to root -- the real race: a poll landing after the kernel reparents it away following the root\'s own death), is still discovered and killed', () => {
    const outFile = mkTmpFile();
    const counterFile = path.join(path.dirname(outFile), 'ps-call-count.txt');

    const { result } = runHangCapabilityInSubprocess({
      runnerModulePath: REAL_RUNNER_MODULE_PATH,
      outFile,
      timeoutMs: 3000,
      extraPathDir: FAKE_PS_VANISHING_DIR,
      extraEnv: { FAKE_PS_COUNTER_FILE: counterFile, FAKE_PS_VANISH_AFTER_CALLS: '6' }
    });

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('TIMEOUT');

    const [directPid, grandchildPid] = readPidFile(outFile);
    expect(Number.isInteger(grandchildPid)).toBe(true);
    livePidsToCleanUp.push(grandchildPid);

    // Node's own internal timeout-kill always reaches the direct child regardless. The
    // grandchild is only reachable at all if the EARLY (correct) observation of it survived
    // every later poll that could no longer re-derive it via the ppid walk -- proven below by
    // its actual death, not by `killCalls` (the verified-kill path uses the global
    // `process.kill(pid, signal)`, not the `ChildProcess.prototype.kill` this driver's
    // `killCalls` tracks, which only ever fires for the separate handle-fallback path).
    expect(isAlive(directPid)).toBe(false);
    return waitUntilDead(grandchildPid, 4000).then((stillAlive) => {
      expect(stillAlive).toBe(false);
    });
  }, 20000);
});

describe('mutation-restore proof: reviewer round 4 follow-up (descendantIdentities merge) actually discriminates (real process)', () => {
  test('reverting to an unconditional overwrite lets the later, ppid-walk-broken polls erase the earlier, correct observation, leaving the grandchild alive', async () => {
    const mutantRoot = makeMutantToolchainRoot();
    try {
      const needle =
        '          for (const [pid, startedAt] of collectDescendants(rootPid, rows)) {\n' +
        '            descendantIdentities.set(pid, startedAt);\n' +
        '          }';
      const replacement = '          descendantIdentities = collectDescendants(rootPid, rows);';
      mutateAndRequire(mutantRoot.runnerPath, needle, replacement);

      const outFile = mkTmpFile();
      const counterFile = path.join(path.dirname(outFile), 'ps-call-count.txt');

      const { result } = runHangCapabilityInSubprocess({
        runnerModulePath: mutantRoot.runnerPath,
        outFile,
        timeoutMs: 3000,
        extraPathDir: FAKE_PS_VANISHING_DIR,
        extraEnv: { FAKE_PS_COUNTER_FILE: counterFile, FAKE_PS_VANISH_AFTER_CALLS: '6' }
      });

      expect(result.ok).toBe(false);
      expect(result.error.code).toBe('TIMEOUT');

      const [directPid, grandchildPid] = readPidFile(outFile);
      livePidsToCleanUp.push(grandchildPid);

      expect(isAlive(directPid)).toBe(false);
      // With the overwrite restored, every poll after the ppid walk first breaks wipes the
      // earlier, correct observation -- exactly what the real (unmutated) test above disproves.
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
  }, 20000);
});
