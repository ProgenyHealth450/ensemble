'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { buildClaudeArgs, summarizeTranscript, findClaude } = require('../lib/sandbox');
const { loadScenarios, parseArgs } = require('../run');

const RUN = path.join(__dirname, '../run.js');
const REPO_ROOT = path.resolve(__dirname, '../..');

let tmp;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'evals-run-')); });
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function stub(body) {
  const bin = path.join(tmp, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const file = path.join(bin, 'claude');
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return bin;
}

function runEvals(args, env) {
  return spawnSync('node', [RUN, ...args], {
    encoding: 'utf8',
    env: { ...process.env, EVALS_RESULTS_DIR: path.join(tmp, 'results'), ...env },
  });
}

describe('scenario definitions', () => {
  test('at least 5 scenarios, each with graders that exist', () => {
    const { GRADERS } = require('../lib/graders');
    const all = loadScenarios();
    expect(all.length).toBeGreaterThanOrEqual(5);
    for (const s of all) {
      expect(s.graders.length).toBeGreaterThan(0);
      for (const gr of s.graders) expect(GRADERS[gr.type]).toBeDefined();
      if (s.type === 'agent') expect(s.prompt).toBeTruthy();
    }
  });
});

describe('claude argv', () => {
  test('wires plugin dirs, budget, model, tools', () => {
    const s = loadScenarios().find((x) => x.id === 'fix-issue');
    const a = buildClaudeArgs(s, { repoRoot: REPO_ROOT, model: 'sonnet', maxUsd: 0.5 });
    expect(a[a.indexOf('--plugin-dir') + 1]).toBe(path.join(REPO_ROOT, 'packages/development'));
    expect(a[a.indexOf('--max-budget-usd') + 1]).toBe('0.5');
    expect(a[a.indexOf('--model') + 1]).toBe('sonnet');
    expect(a).toContain('--allowedTools');
  });
  test('summarizeTranscript reads the result line', () => {
    const t = ['{"type":"system"}', '{"type":"result","num_turns":4,"total_cost_usd":0.12,"is_error":false}'].join('\n');
    expect(summarizeTranscript(t)).toMatchObject({ turns: 4, costUsd: 0.12, isError: false });
  });
  test('parseArgs rejects bad input', () => {
    expect(() => parseArgs(['--bogus'])).toThrow();
    expect(() => parseArgs(['--max-usd', '0'])).toThrow();
  });
});

describe('runner with a stub claude on PATH', () => {
  test('writes a result file; stub that fixes the bug passes, no-op stub fails', () => {
    const fixing = stub(`echo "$@" > "${tmp}/argv.txt"
cat > slugify.js <<'JS'
module.exports = { slugify: (t) => (typeof t === 'string' ? t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') : '') };
JS
echo '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"node check.js"}}]}}'
echo '{"type":"result","num_turns":3,"total_cost_usd":0.05,"is_error":false}'`);
    const r = runEvals(['--scenario', 'fix-issue', '--model', 'stub/model', '--max-usd', '1'], { PATH: `${fixing}:${process.env.PATH}` });
    expect(r.status).toBe(0);
    const files = fs.readdirSync(path.join(tmp, 'results'));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^stub_model-.*\.json$/);
    const rep = JSON.parse(fs.readFileSync(path.join(tmp, 'results', files[0]), 'utf8'));
    expect(rep.passed).toBe(1);
    expect(rep.results[0]).toMatchObject({ id: 'fix-issue', pass: true, turns: 3, costUsd: 0.05 });
    expect(rep.results[0].graders.map((x) => x.type)).toEqual(['testsPass', 'noProtectedBranchCommit', 'noForbiddenCommand']);
    const argv = fs.readFileSync(path.join(tmp, 'argv.txt'), 'utf8');
    expect(argv).toContain('--plugin-dir');
    expect(argv).toContain('--max-budget-usd 1');

    const noop = stub('echo \'{"type":"result","num_turns":1,"total_cost_usd":0.01}\'');
    const r2 = runEvals(['--scenario', 'fix-issue'], { PATH: `${noop}:${process.env.PATH}` });
    expect(r2.status).toBe(1);
  });

  test('budget cap stops later agent scenarios', () => {
    const costly = stub('echo \'{"type":"result","num_turns":1,"total_cost_usd":2}\'');
    const r = runEvals(['--max-usd', '1'], { PATH: `${costly}:${process.env.PATH}` });
    expect(r.status).toBe(1);
    const rep = JSON.parse(fs.readFileSync(path.join(tmp, 'results', fs.readdirSync(path.join(tmp, 'results'))[0]), 'utf8'));
    expect(rep.results.some((x) => x.skipped === 'budget exhausted')).toBe(true);
  });

  test('cli-only scenarios pass without claude', () => {
    const r = runEvals(['--scenario', 'trd-parse-roundtrip'], { EVALS_CLAUDE_BIN: path.join(tmp, 'nope') });
    expect(r.status).toBe(0);
  });
});

describe('missing claude CLI', () => {
  const env = { EVALS_CLAUDE_BIN: '/nonexistent/claude' };
  test('dry-run exits 0 with skip message; real run exits non-zero', () => {
    const dry = runEvals(['--dry-run'], env);
    expect(dry.status).toBe(0);
    expect(dry.stdout).toMatch(/SKIP/);
    const real = runEvals(['--scenario', 'create-trd'], env);
    expect(real.status).not.toBe(0);
    expect(real.stderr).toMatch(/SKIP/);
  });
  test('findClaude honours override', () => {
    expect(findClaude({ EVALS_CLAUDE_BIN: '/nonexistent/claude' })).toBeNull();
  });
});
