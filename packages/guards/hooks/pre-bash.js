#!/usr/bin/env node
'use strict';
// PreToolUse(Bash): exit 2 + stderr blocks. An unrelated internal error fails open, but never
// for text that mentions `git ... push`: that fails closed (no verdict must not mean "allowed").
let g;
let command;
try {
  g = require('../lib/guards');
  if (!g.disabled()) {
    const input = g.readInput();
    command = input && input.tool_input && input.tool_input.command;
    if (typeof command === 'string' && command) {
      const cwd = input.cwd || process.cwd();
      const res = g.checkBash(command, g.loadConfig(g.projectDir(input)), cwd);
      if (res) { process.stderr.write(res.message + '\n'); process.exit(2); }
    }
  }
} catch {
  if (g && !g.disabled() && typeof command === 'string' && g.mentionsGitPush(command)) {
    process.stderr.write('ensemble-guards [protected-branch]: internal error while analyzing a command that mentions git push; blocked (fail closed). Run the git command directly.\n');
    process.exit(2);
  }
}
process.exit(0);
