'use strict';

/**
 * Driver fixture for scripts/tests/toolchain-runner-timeout-containment.test.js (TRD-2026-
 * 8d825f54 TRD-011, reviewer round 3, P2): runs `runCapability` against the
 * spawn-detached-grandchild-and-hang fixture in a FRESH node process whose `PATH` is set
 * entirely by the parent test's `execFileSync` `env` option at spawn time -- never by mutating
 * a running process's `process.env` after the fact. Confirmed by direct experiment: under this
 * repo's jest runner, assigning `process.env.PATH = ...` inside an already-running test does
 * NOT reliably change which executable `child_process`'s own PATH-based resolution finds for a
 * later `execFileSync('ps', ...)`/`execFileSync('mycustomcmd', ...)` call in that SAME process
 * (a plain `node -e` script with the identical assignment does observe it) -- a brand new
 * process whose env is correct from birth sidesteps this entirely.
 *
 * Also monkey-patches `ChildProcess.prototype.kill` to record every call this process makes, so
 * the parent test can observe whether `runner.js`'s `child.kill('SIGKILL')` fallback actually
 * ran, not just the final pid liveness outcome (which stays the same whether or not that
 * fallback runs, since `execFile`'s own `timeout`/`killSignal` option already reaps the direct
 * child independently).
 *
 * argv: [runnerModulePath, hangScriptPath, outFile, timeoutMs, resultFile]. Writes
 * `{result, killCalls}` as JSON to `resultFile` once `runCapability` resolves (or
 * `{error: String(error)}` with a non-zero exit code if it rejects, which it never should).
 */

const fs = require('fs');
const cp = require('child_process');

const [, , runnerModulePath, hangScriptPath, outFile, timeoutMsRaw, resultFile] = process.argv;
const timeoutMs = Number(timeoutMsRaw);

const killCalls = [];
const originalKill = cp.ChildProcess.prototype.kill;
cp.ChildProcess.prototype.kill = function patchedKill(...args) {
  killCalls.push(args[0]);
  return originalKill.apply(this, args);
};

// eslint-disable-next-line global-require, import/no-dynamic-require
const runner = require(runnerModulePath);

function hangAdapter() {
  return {
    adapter: 'fixture-hang-tracker',
    binaries: [process.execPath],
    allowlist: [{ bin: process.execPath, sub: [hangScriptPath] }],
    capabilities: {
      'tracker.show': { run: [process.execPath, hangScriptPath, '${outFile}'] }
    }
  };
}

runner
  .runCapability(hangAdapter(), 'tracker.show', { outFile }, { timeoutMs })
  .then((result) => {
    fs.writeFileSync(resultFile, JSON.stringify({ result, killCalls }));
  })
  .catch((error) => {
    fs.writeFileSync(resultFile, JSON.stringify({ error: String(error && error.stack) }));
    process.exitCode = 1;
  });
