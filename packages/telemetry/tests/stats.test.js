'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const STATS = path.join(__dirname, '..', 'bin', 'ensemble-stats.js');
let root;
const write = (rel, text) => {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
};
const stats = (...args) => spawnSync('node', [STATS, '--dir', root, ...args], { encoding: 'utf8' });

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'stats-'));
  const rec = (kind, name) => JSON.stringify({ ts: 't', session_id: 's', kind, name });
  write('.ensemble/telemetry/usage.jsonl', [
    rec('command', 'ensemble:alpha'), rec('command', 'alpha'), rec('command', 'beta'),
    'garbage line', rec('skill', 'sk1'), rec('agent', 'ag1'), rec('agent', 'ag1'),
    rec('command', 'ghost-not-in-inventory'),
  ].join('\n') + '\n');
  write('packages/a/commands/alpha.yaml', 'metadata:\n  name: ensemble:alpha\n');
  write('packages/a/commands/beta.yaml', 'metadata:\n  name: ensemble:beta\n');
  write('packages/a/commands/gamma.yaml', 'metadata:\n  name: ensemble:gamma\n');
  write('packages/a/agents/ag1.yaml', 'metadata:\n  name: ag1\n');
  write('packages/a/agents/ag2.yaml', 'metadata:\n  name: ag2\n');
  write('packages/a/skills/sk1/SKILL.md', '---\nname: sk1\ndescription: x\n---\n');
  write('packages/a/skills/nested/sk2/SKILL.md', '---\nname: sk2\ndescription: x\n---\n');
  write('packages/full/skills/dup/SKILL.md', '---\nname: dup\n---\n');
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

test('ranks usage per kind, merging namespaced names and skipping bad lines', () => {
  const out = JSON.parse(stats('--json').stdout);
  expect(out.zeroUse).toBeNull();
  expect(out.usage.command).toEqual([
    { name: 'alpha', count: 2 }, { name: 'beta', count: 1 }, { name: 'ghost-not-in-inventory', count: 1 },
  ]);
  expect(out.usage.agent).toEqual([{ name: 'ag1', count: 2 }]);
});

test('--inventory lists zero-use components per kind', () => {
  const out = JSON.parse(stats('--inventory', '--json').stdout);
  expect(out.zeroUse).toEqual({ command: ['gamma'], skill: ['sk2'], agent: ['ag2'] });
});

test('human output shows ranking and zero-use sections', () => {
  const r = stats('--inventory');
  expect(r.status).toBe(0);
  expect(r.stdout).toMatch(/2\s+alpha/);
  expect(r.stdout).toMatch(/zero-use commands \(1\):\n\s+gamma/);
});

test('no usage file yields empty report; bad repo errors', () => {
  fs.rmSync(path.join(root, '.ensemble'), { recursive: true });
  expect(JSON.parse(stats('--json').stdout).usage.command).toEqual([]);
  const r = spawnSync('node', [STATS, '--dir', root, '--inventory', '--repo', path.join(root, 'nope')], { encoding: 'utf8' });
  expect(r.status).toBe(1);
});
