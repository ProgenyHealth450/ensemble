'use strict';

/**
 * Real-process fixture for scripts/tests/toolchain-runner-timeout-containment.test.js
 * (TRD-2026-8d825f54 TRD-011, reviewer Finding 3). Simulates a detached grandchild process a
 * misbehaving (or merely background-daemon-launching) adapter tool spawned: it just sleeps far
 * longer than any test's timeout, so the test can prove whether `runner.js#runCapability`'s
 * timeout containment actually reaches it.
 */

setTimeout(() => {}, 5 * 60 * 1000);
