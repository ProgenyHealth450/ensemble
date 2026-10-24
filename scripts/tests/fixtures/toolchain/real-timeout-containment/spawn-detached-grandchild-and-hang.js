'use strict';

/**
 * Real-process fixture for scripts/tests/toolchain-runner-timeout-containment.test.js
 * (TRD-2026-8d825f54 TRD-011, reviewer Finding 3 reproduction): invoked for real (via
 * `node spawn-detached-grandchild-and-hang.js <outFile>`) by `runner.js#runCapability`, this
 * stands in for an adapter binary that itself spawns a detached background process
 * (`spawn(cmd, {detached:true}).unref()`, a real pattern some CLIs use to launch a daemon) and
 * then hangs -- exactly the reproduction the independent review recorded: "allowlisted script
 * spawns detached `node sleep.js 300` and unrefs; TIMEOUT returned, grandchild lived on PPID
 * 1". Writes TWO lines to `outFile`: its own pid (`process.pid`, the direct child
 * `runCapability` spawned) first, then the detached grandchild's pid -- so a test can verify,
 * after the direct child is killed on timeout, whether the grandchild is also gone (and, for
 * the ps-unavailable fallback proof, that the direct child itself is still reliably killed via
 * its Node-tracked handle even when the grandchild cannot be reached).
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const outFile = process.argv[2];
const sleepScript = path.join(__dirname, 'sleep-forever.js');

const grandchild = spawn(process.execPath, [sleepScript], { detached: true, stdio: 'ignore' });
fs.writeFileSync(outFile, `${process.pid}\n${grandchild.pid}\n`);
grandchild.unref();

// Hang far longer than any test's configured timeoutMs, so the runner's own timeout always
// fires first.
setTimeout(() => {}, 5 * 60 * 1000);
