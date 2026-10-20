#!/usr/bin/env node
'use strict';

/**
 * Ensemble telemetry recorder (local, opt-in).
 *
 * Reads a Claude Code hook payload on stdin and appends ONE line
 * {ts, session_id, kind, name} to <project>/.ensemble/telemetry/usage.jsonl.
 *
 * Enabled only when ENSEMBLE_TELEMETRY=1 or <project>/.ensemble/telemetry/enabled exists.
 * Records only the component name: never prompt text, tool input/output, paths or tokens.
 * Always exits 0 and never writes to stdout.
 */

const fs = require('fs');
const path = require('path');

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/;

function cleanName(value) {
  return typeof value === 'string' && NAME_RE.test(value) ? value : null;
}

function extract(payload) {
  const event = payload.hook_event_name;
  if (event === 'UserPromptSubmit') {
    const prompt = typeof payload.prompt === 'string' ? payload.prompt : '';
    const m = /^\s*\/([^\s]+)/.exec(prompt);
    const name = m && cleanName(m[1]);
    return name ? { kind: 'command', name } : null;
  }
  if (event === 'PostToolUse') {
    const input = payload.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input : {};
    if (payload.tool_name === 'Skill') {
      const name = cleanName(input.skill) || cleanName(input.name);
      return name ? { kind: 'skill', name } : null;
    }
    if (payload.tool_name === 'Task' || payload.tool_name === 'Agent') {
      const name = cleanName(input.subagent_type);
      return name ? { kind: 'agent', name } : null;
    }
  }
  return null;
}

function projectDir(payload) {
  const dir = process.env.CLAUDE_PROJECT_DIR || payload.cwd || process.cwd();
  return path.resolve(String(dir));
}

function main() {
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch (_) {
    return;
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (_) {
    return;
  }
  if (!payload || typeof payload !== 'object') return;

  const dir = projectDir(payload);
  const teleDir = path.join(dir, '.ensemble', 'telemetry');
  const enabled = process.env.ENSEMBLE_TELEMETRY === '1' || fs.existsSync(path.join(teleDir, 'enabled'));
  if (!enabled) return;

  const rec = extract(payload);
  if (!rec) return;

  const sid = typeof payload.session_id === 'string' ? payload.session_id.slice(0, 100) : '';
  const line = JSON.stringify({ ts: new Date().toISOString(), session_id: sid, kind: rec.kind, name: rec.name });
  fs.mkdirSync(teleDir, { recursive: true });
  fs.appendFileSync(path.join(teleDir, 'usage.jsonl'), line + '\n');
}

try {
  main();
} catch (_) {
  // never block the session
}
process.exit(0);
