#!/usr/bin/env node
'use strict';
// Stop/SubagentStop: opt-in DoD gate. Exit 2 + stderr keeps the model working. Fails open.
try {
  const g = require('../lib/guards');
  if (!g.disabled()) {
    const input = g.readInput();
    if (input) {
      const dir = g.projectDir(input);
      const res = g.checkStop(input, g.loadConfig(dir), dir);
      if (res) { process.stderr.write(res.message + '\n'); process.exit(2); }
    }
  }
} catch { /* fail open */ }
process.exit(0);
