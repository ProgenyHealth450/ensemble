'use strict';

/**
 * Tests for `trd-cli resolve-bdd` (lib/trd-cli.js), the subcommand create-trd and
 * implement-trd-beads run to learn whether the Reqnroll/BDD path is on.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { runResolveBdd } = require('../lib/trd-cli');

const CLI = path.join(__dirname, '..', 'lib', 'trd-cli.js');
const REQNROLL_CSPROJ = '<Project><ItemGroup><PackageReference Include="Reqnroll.xUnit" /></ItemGroup></Project>\n';

const roots = [];
function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-bdd-'));
  roots.push(dir);
  return dir;
}
function reqnrollRepo() {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'T.csproj'), REQNROLL_CSPROJ);
  return root;
}
// A child process must not inherit the developer's own ENSEMBLE_BDD.
function cleanEnv(extra) {
  const env = { ...process.env, ...extra };
  if (!extra || !('ENSEMBLE_BDD' in extra)) delete env.ENSEMBLE_BDD;
  return env;
}
function cli(args, env) {
  const res = spawnSync('node', [CLI, 'resolve-bdd', ...args], { encoding: 'utf8', env: cleanEnv(env) });
  return { status: res.status, json: JSON.parse(res.stdout.trim()) };
}

afterAll(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

describe('runResolveBdd (handler)', () => {
  test('--bdd and --no-bdd map to the flag source', () => {
    expect(runResolveBdd(['--repo', tmp(), '--bdd'], {})).toMatchObject({ ok: true, enabled: true, source: 'flag' });
    expect(runResolveBdd(['--repo', tmp(), '--no-bdd'], { ENSEMBLE_BDD: '1' })).toMatchObject({ ok: true, enabled: false, source: 'flag' });
  });

  test('both flags together is an error, not a silent pick', () => {
    expect(() => runResolveBdd(['--bdd', '--no-bdd'], {})).toThrow(/mutually exclusive/);
  });

  test('reads ENSEMBLE_BDD from the env it is given, not from process.env', () => {
    const repo = reqnrollRepo();
    expect(runResolveBdd(['--repo', repo], { ENSEMBLE_BDD: 'off' })).toMatchObject({ enabled: false, source: 'env' });
    expect(runResolveBdd(['--repo', repo], {})).toMatchObject({ enabled: true, source: 'detected' });
  });

  test('--repo selects where detection looks; a repo without Reqnroll is off (the BT3 case)', () => {
    expect(runResolveBdd(['--repo', tmp()], {})).toEqual({
      ok: true,
      enabled: false,
      source: 'default',
      message: 'Test approach: standard [default]',
    });
  });

  test('--trd feeds the TRD stamp into the resolution', () => {
    const root = tmp();
    const trd = path.join(root, 'TRD.md');
    fs.writeFileSync(trd, '---\ntest_approach: bdd-reqnroll\n---\n# TRD\n');
    expect(runResolveBdd(['--trd', trd, '--repo', root], {})).toMatchObject({ enabled: true, source: 'trd' });
  });
});

describe('trd-cli resolve-bdd (process)', () => {
  test('prints one JSON object and exits 0', () => {
    const { status, json } = cli(['--repo', reqnrollRepo()]);
    expect(status).toBe(0);
    expect(json).toEqual({
      ok: true,
      enabled: true,
      source: 'detected',
      evidence: 'src/T.csproj',
      message: 'Test approach: BDD (Reqnroll) [detected: src/T.csproj]',
    });
  });

  test('ENSEMBLE_BDD in the process environment is honoured', () => {
    expect(cli(['--repo', reqnrollRepo()], { ENSEMBLE_BDD: '0' }).json).toMatchObject({ enabled: false, source: 'env' });
  });

  test('conflicting flags print {error} and exit 1', () => {
    const { status, json } = cli(['--bdd', '--no-bdd']);
    expect(status).toBe(1);
    expect(json.error).toMatch(/mutually exclusive/);
  });

  test('is listed in the usage line, so a caller can discover it', () => {
    const res = spawnSync('node', [CLI], { encoding: 'utf8' });
    expect(JSON.parse(res.stdout).error).toContain('resolve-bdd');
  });
});
