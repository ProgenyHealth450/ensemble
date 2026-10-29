'use strict';

/**
 * Real-process fixture for scripts/tests/toolchain-runner-timeout-containment.test.js
 * (TRD-2026-8d825f54 TRD-011, reviewer round 3, P3): like
 * `spawn-detached-grandchild-and-hang.js`, but delays spawning the detached grandchild by
 * `delayMs` (argv[3]) instead of spawning it immediately. This lets a test place the spawn
 * AFTER the last periodic `PROCESS_TREE_POLL_MS` poll tick `runner.js#runCapability` took
 * before the timeout fires, so only its final pre-kill snapshot (never the periodic poll) can
 * discover the grandchild in time.
 *
 * `invoked via `node spawn-detached-grandchild-after-delay-and-hang.js <outFile> <delayMs>`.
 * Writes its own pid (`process.pid`) to `outFile` immediately, then -- after `delayMs` -- spawns
 * the detached grandchild and appends its pid as the second line (the grandchild's pid is
 * known synchronously right after `spawn()` returns; no need to wait for the grandchild's own
 * startup, since `ps` reflects a freshly-forked pid immediately).
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const outFile = process.argv[2];
const delayMs = Number(process.argv[3]);
const sleepScript = path.join(__dirname, 'sleep-forever.js');

fs.writeFileSync(outFile, `${process.pid}\n`);

setTimeout(() => {
  const grandchild = spawn(process.execPath, [sleepScript], { detached: true, stdio: 'ignore' });
  fs.appendFileSync(outFile, `${grandchild.pid}\n`);
  grandchild.unref();
}, delayMs);

// Hang far longer than any test's configured timeoutMs, so the runner's own timeout always
// fires first.
setTimeout(() => {}, 5 * 60 * 1000);
