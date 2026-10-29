'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RECORD = path.join(__dirname, '..', 'hooks', 'record.js');
let proj;
beforeEach(() => { proj = fs.mkdtempSync(path.join(os.tmpdir(), 'tele-')); });
afterEach(() => { fs.rmSync(proj, { recursive: true, force: true }); });

function run(input, env = {}) {
  const clean = { ...process.env };
  delete clean.ENSEMBLE_TELEMETRY;
  return spawnSync('node', [RECORD], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    env: { ...clean, CLAUDE_PROJECT_DIR: proj, ...env },
    encoding: 'utf8',
  });
}
const usage = () => path.join(proj, '.ensemble', 'telemetry', 'usage.jsonl');
const lines = () => fs.readFileSync(usage(), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const prompt = (p) => ({ hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: p });

test('opt-out writes nothing', () => {
  const r = run(prompt('/ensemble:create-prd foo'));
  expect(r.status).toBe(0);
  expect(fs.existsSync(path.join(proj, '.ensemble'))).toBe(false);
});

test('env opt-in records a command line', () => {
  const r = run(prompt('/ensemble:create-prd secret text'), { ENSEMBLE_TELEMETRY: '1' });
  expect(r.status).toBe(0);
  expect(r.stdout).toBe('');
  const [rec] = lines();
  expect(rec).toEqual({ ts: expect.any(String), session_id: 's1', kind: 'command', name: 'ensemble:create-prd' });
  expect(Number.isNaN(Date.parse(rec.ts))).toBe(false);
});

test('enabled file opts in; skill and agent tools recorded', () => {
  fs.mkdirSync(path.join(proj, '.ensemble', 'telemetry'), { recursive: true });
  fs.writeFileSync(path.join(proj, '.ensemble', 'telemetry', 'enabled'), '');
  run({ hook_event_name: 'PostToolUse', session_id: 's', tool_name: 'Skill', tool_input: { skill: 'pytest' } });
  run({ hook_event_name: 'PostToolUse', session_id: 's', tool_name: 'Agent', tool_input: { subagent_type: 'architect', prompt: 'x' } });
  run({ hook_event_name: 'PostToolUse', session_id: 's', tool_name: 'Task', tool_input: { subagent_type: 'plan' } });
  expect(lines().map((l) => [l.kind, l.name])).toEqual([['skill', 'pytest'], ['agent', 'architect'], ['agent', 'plan']]);
});

test('malformed / empty stdin exits 0 and writes nothing', () => {
  for (const bad of ['{not json', '', 'null', '"str"', '[1]']) {
    const r = run(bad, { ENSEMBLE_TELEMETRY: '1' });
    expect(r.status).toBe(0);
  }
  expect(fs.existsSync(usage())).toBe(false);
});

test('non-command prompts and other tools are ignored', () => {
  run(prompt('please /etc/passwd help'), { ENSEMBLE_TELEMETRY: '1' });
  run({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }, { ENSEMBLE_TELEMETRY: '1' });
  expect(fs.existsSync(usage())).toBe(false);
});

test('path-like or hostile command names are rejected', () => {
  run(prompt('/Users/me/secret/file.txt'), { ENSEMBLE_TELEMETRY: '1' });
  expect(fs.existsSync(usage())).toBe(false);
});

test('no leakage of prompt text, tool input or output', () => {
  const env = { ENSEMBLE_TELEMETRY: '1' };
  run(prompt('/deploy hunter2 me@example.com /home/u/secret'), env);
  run({
    hook_event_name: 'PostToolUse', session_id: 's', tool_name: 'Agent',
    tool_input: { subagent_type: 'plan', prompt: 'TOPSECRET me@example.com' },
    tool_response: { content: 'LEAKED-OUTPUT', totalTokens: 99999 },
  }, env);
  const raw = fs.readFileSync(usage(), 'utf8');
  for (const s of ['hunter2', 'example.com', '/home/u', 'TOPSECRET', 'LEAKED', '99999']) expect(raw).not.toContain(s);
  for (const rec of lines()) expect(Object.keys(rec).sort()).toEqual(['kind', 'name', 'session_id', 'ts']);
});
