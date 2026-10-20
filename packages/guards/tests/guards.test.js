'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PRE = path.join(__dirname, '..', 'hooks', 'pre-bash.js');
const STOP = path.join(__dirname, '..', 'hooks', 'stop-gate.js');
let proj;

const git = (...a) => spawnSync('git', ['-C', proj, ...a], { encoding: 'utf8' });
beforeEach(() => {
  proj = fs.mkdtempSync(path.join(os.tmpdir(), 'guards-'));
  git('init', '-q', '-b', 'main');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'i');
});
afterEach(() => { fs.rmSync(proj, { recursive: true, force: true }); });

function run(script, input, env = {}) {
  const clean = { ...process.env };
  delete clean.ENSEMBLE_GUARDS;
  delete clean.CLAUDE_PROJECT_DIR;
  return spawnSync('node', [script], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    env: { ...clean, ...env },
    encoding: 'utf8',
    cwd: proj,
  });
}
const bash = (command, env) => run(PRE, { hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: proj, tool_input: { command } }, env);
const stop = (extra = {}, env) => run(STOP, { hook_event_name: 'Stop', cwd: proj, stop_hook_active: false, ...extra }, env);
const config = (c) => {
  fs.mkdirSync(path.join(proj, '.ensemble'), { recursive: true });
  fs.writeFileSync(path.join(proj, '.ensemble', 'guards.json'), JSON.stringify(c));
};

describe('git guards', () => {
  test('commit on main blocked with rule + override hint', () => {
    const r = bash('git commit -m x');
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/protected-branch/);
    expect(r.stderr).toMatch(/guards\.json/);
  });
  test('commit on feature branch allowed', () => {
    git('switch', '-q', '-c', 'feat/x');
    expect(bash('git commit -m x').status).toBe(0);
  });
  test('git -C dir and cd chains resolve the right repo', () => {
    git('switch', '-q', '-c', 'feat/x');
    expect(bash(`git -C ${proj} commit -m x`).status).toBe(0);
    const main = fs.mkdtempSync(path.join(os.tmpdir(), 'guards-m-'));
    spawnSync('git', ['-C', main, 'init', '-q', '-b', 'main']);
    try {
      expect(bash(`git -C ${main} commit -m x`).status).toBe(2);
      expect(bash(`cd ${main} && git commit -m x`).status).toBe(2);
      expect(bash(`FOO=1 git -C ${main} commit -m x`).status).toBe(2);
    } finally { fs.rmSync(main, { recursive: true, force: true }); }
  });
  test('chained and newline-separated commits are caught', () => {
    expect(bash('git add . && git commit -m x').status).toBe(2);
    expect(bash('echo hi\ngit commit -m x').status).toBe(2);
    expect(bash('true; git commit -m x').status).toBe(2);
  });
  test('push: default on main, explicit main, HEAD:main blocked; feature allowed', () => {
    expect(bash('git push').status).toBe(2);
    expect(bash('git push origin main').status).toBe(2);
    expect(bash('git push origin HEAD:refs/heads/master').status).toBe(2);
    git('switch', '-q', '-c', 'feat/x');
    expect(bash('git push origin feat/x').status).toBe(0);
    expect(bash('git push -u origin HEAD').status).toBe(0);
    expect(bash('git push origin main').status).toBe(2);
  });
  test('force push to protected reports force-push; feature force allowed', () => {
    const r = bash('git push --force origin main');
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/force-push/);
    git('switch', '-q', '-c', 'feat/x');
    expect(bash('git push --force-with-lease origin feat/x').status).toBe(0);
  });
  test('--no-verify and --no-gpg-sign blocked even on feature branch', () => {
    git('switch', '-q', '-c', 'feat/x');
    expect(bash('git commit --no-verify -m x').status).toBe(2);
    expect(bash('git commit -nm x').status).toBe(2);
    expect(bash('git commit --no-gpg-sign -m x').status).toBe(2);
    expect(bash('git push --no-verify origin feat/x').status).toBe(2);
  });
  test('quoted mentions do not trigger', () => {
    expect(bash('echo "git commit on main"').status).toBe(0);
    git('switch', '-q', '-c', 'feat/x');
    expect(bash('git commit -m "do not use --no-verify on main"').status).toBe(0);
    expect(bash("git commit -m 'git push origin main'").status).toBe(0);
    expect(bash('git log main').status).toBe(0);
  });
  test('config: custom protected branches and disabled rules', () => {
    config({ protectedBranches: ['release'] });
    expect(bash('git commit -m x').status).toBe(0);
    git('switch', '-q', '-c', 'release');
    expect(bash('git commit -m x').status).toBe(2);
    config({ disable: ['protected-branch'] });
    expect(bash('git commit -m x').status).toBe(0);
    expect(bash('git commit --no-verify -m x').status).toBe(2);
  });
});

describe('br close', () => {
  test('without reason blocked; empty reason blocked', () => {
    const r = bash('br close br-1');
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/br-close-reason/);
    expect(bash('br close br-1 --reason ""').status).toBe(2);
    expect(bash('br close br-1 --reason').status).toBe(2);
  });
  test('with reason allowed; other br commands allowed', () => {
    expect(bash('br close br-1 --reason "merged in abc123"').status).toBe(0);
    expect(bash('br close br-1 --reason=done').status).toBe(0);
    expect(bash('br close br-1 -r done').status).toBe(0);
    expect(bash('br list').status).toBe(0);
    expect(bash('echo "br close br-1"').status).toBe(0);
  });
});

describe('stop gate', () => {
  test('disabled by default', () => {
    expect(stop().status).toBe(0);
  });
  test('blocks on failing command with output tail', () => {
    config({ dod: { command: 'echo boom-marker; exit 3', timeoutSec: 20 } });
    const r = stop();
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/boom-marker/);
  });
  test('SubagentStop event also gated; passing command allows', () => {
    config({ dod: { command: 'exit 0' } });
    expect(stop({ hook_event_name: 'SubagentStop' }).status).toBe(0);
    config({ dod: { command: 'exit 1' } });
    expect(stop({ hook_event_name: 'SubagentStop' }).status).toBe(2);
  });
  test('allows when stop_hook_active', () => {
    config({ dod: { command: 'exit 1' } });
    expect(stop({ stop_hook_active: true }).status).toBe(0);
  });
  test('timeout blocks; dod rule can be disabled', () => {
    config({ dod: { command: 'sleep 5', timeoutSec: 1 } });
    expect(stop().status).toBe(2);
    config({ dod: { command: 'exit 1' }, disable: ['dod'] });
    expect(stop().status).toBe(0);
  });
});

describe('fail open / kill switch', () => {
  test('malformed stdin exits 0', () => {
    expect(run(PRE, 'not json{').status).toBe(0);
    expect(run(STOP, '').status).toBe(0);
    expect(run(PRE, { tool_input: { command: 42 } }).status).toBe(0);
  });
  test('malformed config fails open to defaults without crashing', () => {
    fs.mkdirSync(path.join(proj, '.ensemble'));
    fs.writeFileSync(path.join(proj, '.ensemble', 'guards.json'), '{bad');
    expect(bash('git commit -m x').status).toBe(2);
  });
  test('ENSEMBLE_GUARDS=0 disables everything', () => {
    config({ dod: { command: 'exit 1' } });
    expect(bash('git commit -m x', { ENSEMBLE_GUARDS: '0' }).status).toBe(0);
    expect(bash('br close x', { ENSEMBLE_GUARDS: '0' }).status).toBe(0);
    expect(stop({}, { ENSEMBLE_GUARDS: '0' }).status).toBe(0);
  });
});
