'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { STEPS, parseArgs, buildPlan, formatSummary, runCi } = require('../ci-local');

describe('buildPlan', () => {
  const names = (p) => p.steps.map((s) => s.name);

  it('includes install, validate, generate-validate, tests in CI order', () => {
    const n = names(buildPlan({}));
    const idx = ['install', 'validate', 'generate-validate', 'test'].map((x) => n.indexOf(x));
    expect(idx.every((i) => i >= 0)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
    expect(n).toContain('scripts-tests');
  });

  it('honors --steps (canonical order) and rejects unknown names', () => {
    const p = buildPlan(parseArgs(['--steps', 'validate,install']));
    expect(names(p)).toEqual(['install', 'validate']);
    expect(() => buildPlan({ steps: ['nope'] })).toThrow(/Unknown step/);
  });

  it('honors --fail-fast and defaults to continuing', () => {
    expect(buildPlan(parseArgs(['--fail-fast'])).failFast).toBe(true);
    expect(buildPlan(parseArgs([])).failFast).toBe(false);
    expect(parseArgs(['--list']).list).toBe(true);
  });

  it('every step is {name, cmd}', () => {
    STEPS.forEach((s) => expect(typeof s.cmd).toBe('string'));
  });
});

describe('formatSummary', () => {
  it('lists steps and reports failures', () => {
    const out = formatSummary([
      { name: 'a', status: 'PASS', seconds: 1.25 },
      { name: 'bb', status: 'FAIL', seconds: 2 },
    ]);
    expect(out).toMatch(/a\s+PASS\s+1\.3|a\s+PASS\s+1\.2/);
    expect(out).toMatch(/bb\s+FAIL\s+2\.0/);
    expect(out).toMatch(/1 step\(s\) FAILED/);
  });
});

describe('runCi clean-clone semantics', () => {
  let repo;
  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-local-fixture-'));
    const sh = (...a) => execFileSync('git', a, { cwd: repo, stdio: 'ignore' });
    sh('init', '-q');
    sh('config', 'user.email', 't@t');
    sh('config', 'user.name', 't');
    fs.writeFileSync(path.join(repo, '.gitignore'), 'dist/\n');
    fs.writeFileSync(path.join(repo, 'test.js'), "require('./dist/x.js');\n");
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'f', scripts: { test: 'node test.js' } }));
    sh('add', '.gitignore', 'test.js', 'package.json');
    sh('commit', '-qm', 'init');
    // gitignored build artifact, present only in the dirty working copy
    fs.mkdirSync(path.join(repo, 'dist'));
    fs.writeFileSync(path.join(repo, 'dist', 'x.js'), 'module.exports = 1;\n');
  });
  afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

  const quiet = { stdio: 'ignore', log: () => {} };

  it('plain npm test passes in the dirty working copy', () => {
    expect(() => execFileSync('npm', ['test'], { cwd: repo, stdio: 'ignore' })).not.toThrow();
  });

  it('fails in the clean clone because the ignored dist/ is absent', () => {
    const r = runCi({ repoRoot: repo, steps: [{ name: 'test', cmd: 'npm test' }], ...quiet });
    expect(r.code).toBe(1);
    expect(r.results[0].status).toBe('FAIL');
    expect(fs.existsSync(r.dir)).toBe(false); // temp clone cleaned
  });

  it('does not touch the working tree and keeps the clone with keep', () => {
    const r = runCi({ repoRoot: repo, steps: [{ name: 'ls', cmd: 'test ! -e dist' }], keep: true, ...quiet });
    try {
      expect(r.code).toBe(0);
      expect(fs.existsSync(path.join(r.dir, 'test.js'))).toBe(true);
      expect(fs.existsSync(path.join(repo, 'dist', 'x.js'))).toBe(true);
    } finally {
      fs.rmSync(r.dir, { recursive: true, force: true });
    }
  });

  it('continues past failures by default and stops with failFast', () => {
    const steps = [{ name: 'bad', cmd: 'exit 3' }, { name: 'good', cmd: 'true' }];
    expect(runCi({ repoRoot: repo, steps, ...quiet }).results.map((x) => x.status)).toEqual(['FAIL', 'PASS']);
    expect(runCi({ repoRoot: repo, steps, failFast: true, ...quiet }).results).toHaveLength(1);
  });
});
