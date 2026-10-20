#!/usr/bin/env node
'use strict';
// PreToolUse(Bash): exit 2 + stderr blocks. Any internal error fails open.
try {
  const g = require('../lib/guards');
  if (!g.disabled()) {
    const input = g.readInput();
    const command = input && input.tool_input && input.tool_input.command;
    if (typeof command === 'string' && command) {
      const cwd = input.cwd || process.cwd();
      const res = g.checkBash(command, g.loadConfig(g.projectDir(input)), cwd);
      if (res) { process.stderr.write(res.message + '\n'); process.exit(2); }
    }
  }
} catch { /* fail open */ }
process.exit(0);
