'use strict';

/**
 * Real-process fixture for scripts/tests/toolchain-ledger-real-process.test.js
 * (TRD-015-TEST, br-31eh, PRD REQ-014, AC-014-1/AC-014-2/AC-014-3).
 *
 * Invoked for real (via `node fail.js <counterPath>`) by `runner.js#runCapability` through
 * `ledger.js#runSequence`, standing in for a side-effecting tool call that fails -- simulating
 * "an adapter failing after a branch and a work item were created" (AC-014-1's own wording).
 * Still appends one line to the counter file named by argv[2] before failing, so a step that
 * fails after a real side effect is counted as attempted the same way a succeeding step is.
 *
 * Sets `process.exitCode` rather than calling `process.exit()`: letting the process complete
 * naturally keeps the stderr write below from being truncated by Node's documented
 * async-pipe-write-then-forced-exit race, while the eventual exit code (1) is still reported
 * to the parent's `execFile` call once the event loop drains -- deterministic, not flaky.
 */

const fs = require('fs');

const counterPath = process.argv[2];
fs.appendFileSync(counterPath, 'fail\n');
process.stderr.write('fixture-ledger-fail: simulated adapter failure after prior side effects\n');
process.exitCode = 1;
