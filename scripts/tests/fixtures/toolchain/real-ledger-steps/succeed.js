'use strict';

/**
 * Real-process fixture for scripts/tests/toolchain-ledger-real-process.test.js
 * (TRD-015-TEST, br-31eh, PRD REQ-014, AC-014-1/AC-014-2/AC-014-3).
 *
 * Invoked for real (via `node succeed.js <counterPath>`) by `runner.js#runCapability` through
 * `ledger.js#runSequence`, standing in for a side-effecting tool call that succeeds. Every
 * real invocation appends one line to the counter file named by argv[2], so a test can assert
 * the exact number of real child processes `runSequence` actually spawned (proving AC-014-3:
 * no retry, no resume, nothing beyond the attempted steps).
 *
 * Exits without calling `process.exit()`: letting the process complete naturally (default exit
 * code 0) avoids Node's documented async-pipe-write-then-forced-exit race, where a stdout
 * write to a piped child can be truncated if the process is force-exited before the write
 * flushes -- this keeps the test deterministic rather than occasionally flaky.
 */

const fs = require('fs');

const counterPath = process.argv[2];
fs.appendFileSync(counterPath, 'succeed\n');
process.stdout.write('fixture-ledger-succeed: ok\n');
