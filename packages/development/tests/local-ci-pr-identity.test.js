'use strict';

/**
 * Which branch a PR targets, and which commit is its head, is GitHub's answer, never the caller's. Without that, any
 * remote-tracking branch a contributor can push would be accepted as the "base", and the .ensemble/local-ci.yaml committed
 * on it would grade the PR (it can simply omit the failing step). These tests drive the real CLI flows against real
 * temp git repos; only GitHub's answer is faked, through the `prInfo` seam.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const yaml = require('js-yaml');

const cli = require('../lib/local-ci-cli');
const { makeBaseRepo, cleanupBaseRepos, prInfoFor, fakeGhDir, PR, REPO } = require('./helpers/local-ci-base-repo');

afterAll(cleanupBaseRepos);

const WORKFLOW = '.github/workflows/ci.yml';
const MAJOR = Number(process.versions.node.split('.')[0]);
const wf = (cmds) => yaml.dump({ name: 'ci', on: ['push'], jobs: { ci: { 'runs-on': 'ubuntu-latest', strategy: { matrix: { 'node-version': [MAJOR] } }, steps: cmds.map((run) => ({ run })) } } });
const cfg = (steps) => yaml.dump({ workflows: [{ file: WORKFLOW, jobs: [{ id: 'ci', matrix: { 'node-version': [MAJOR] } }] }], steps, status_context: 'x/local-ci' });
const STRICT = cfg([{ name: 'Build', cmd: 'node scripts/build.js' }, { name: 'Test', cmd: 'node scripts/test.js' }]);

const noNetwork = { postStatus: () => ({ published: true }) };
const stub = (extra) => ({ ...cli.defaultDeps(), ...noNetwork, runGate: () => ({ ok: true, failures: [], unmirrored: [], nodes: [{ node: MAJOR, ok: true, steps: [] }] }), ...extra });
const gatePayload = (fx, over) => ({ repoRoot: fx.dir, headSha: fx.headSha, baseRef: fx.baseRef, repo: REPO, pr: PR, dryRun: true, ...over });
const mergePayload = (fx, over) => ({ repoRoot: fx.dir, headSha: fx.headSha, baseRef: fx.baseRef, repo: REPO, pr: PR, statuses: [], ...over });

describe('the PR identity comes from GitHub and is checked before any config is read', () => {
  const fx = makeBaseRepo({ config: STRICT });
  // A branch the "contributor" pushed: same history, its own (weaker) config.
  fx.git('update-ref', 'refs/remotes/origin/feature-x', fx.baseSha);

  it('control: the honest answer lets the gate go on to run', async () => {
    const r = await cli.runGateFlow(gatePayload(fx), stub({ prInfo: prInfoFor(fx) }));
    // Past the identity check: the config was read and the (stubbed) run happened. Any later stage is not under test here.
    expect(r.stage).not.toBe('config');
    expect(r.error || '').not.toMatch(/base branch|current head|not OPEN|cannot verify/);
  });

  it("refuses a base that is not the branch the PR targets, even though it is a perfectly valid remote-tracking ref", async () => {
    const prInfo = prInfoFor(fx); // GitHub: the PR targets trusted-base
    const r = await cli.runGateFlow(gatePayload(fx, { baseRef: 'origin/feature-x' }), stub({ prInfo }));
    expect(r.stage).toBe('config');
    expect(r.mergeReady).toBe(false);
    expect(r.error).toMatch(/not the base branch of pull request #7/);
    expect(r.error).toContain('trusted-base');
    expect(prInfo.calls).toEqual([{ repo: REPO, pr: PR }]);
  });

  it('the same refusal applies to merge, which must not approve on a base the author chose', () => {
    const r = cli.runMerge(mergePayload(fx, { baseRef: 'origin/feature-x' }), { ...cli.defaultDeps(), prInfo: prInfoFor(fx) });
    expect(r.mergeReady).toBe(false);
    expect(r.reason).toMatch(/not the base branch/);
  });

  it('refuses a head that is not the PR\'s current head (a stale or swapped commit)', async () => {
    const other = 'f'.repeat(40);
    const g = await cli.runGateFlow(gatePayload(fx), stub({ prInfo: prInfoFor(fx, { headRefOid: other }) }));
    expect(g.stage).toBe('config');
    expect(g.error).toMatch(/not the current head of pull request #7/);
    const m = cli.runMerge(mergePayload(fx), { ...cli.defaultDeps(), prInfo: prInfoFor(fx, { headRefOid: other }) });
    expect(m.mergeReady).toBe(false);
    expect(m.reason).toMatch(/not the current head/);
  });

  it('a head SHA that differs only in letter case is the same commit', async () => {
    const r = await cli.runGateFlow(gatePayload(fx), stub({ prInfo: prInfoFor(fx, { headRefOid: fx.headSha.toUpperCase() }) }));
    expect(r.stage).not.toBe('config');
  });

  it.each([
    ['MERGED', { state: 'MERGED' }],
    ['CLOSED', { state: 'CLOSED' }],
    ['missing', { state: undefined }],
  ])('refuses a pull request that is %s', async (_n, answer) => {
    const r = await cli.runGateFlow(gatePayload(fx), stub({ prInfo: prInfoFor(fx, answer) }));
    expect(r.stage).toBe('config');
    expect(r.error).toMatch(/not OPEN/);
  });

  it.each([
    ['a lookup error', { error: 'HTTP 404' }],
    ['no base branch', { baseRefName: undefined }],
    ['a base name with a shell metacharacter', { baseRefName: 'x;rm -rf' }],
    ['a base name with a space', { baseRefName: 'a b' }],
    ['a head that is not a 40-hex sha', { headRefOid: 'abc' }],
    ['no head', { headRefOid: undefined }],
  ])('fails closed on %s', async (_n, answer) => {
    const r = await cli.runGateFlow(gatePayload(fx), stub({ prInfo: prInfoFor(fx, answer) }));
    expect(r.stage).toBe('config');
    expect(r.mergeReady).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it('fails closed when no lookup is available at all (never "no answer, so fine")', async () => {
    const deps = { ...stub(), prInfo: undefined };
    const r = await cli.runGateFlow(gatePayload(fx), deps);
    expect(r.stage).toBe('config');
    expect(r.error).toMatch(/no GitHub lookup is available/);
  });

  it('a lookup that returns a non-object, or throws nothing useful, is a refusal', async () => {
    for (const bad of [undefined, null, 5, 'ok', { ok: true }, { ok: true, info: null }, { ok: true, info: [] }]) {
      const r = await cli.runGateFlow(gatePayload(fx), stub({ prInfo: () => bad }));
      expect(r.stage).toBe('config');
      expect(r.mergeReady).toBe(false);
    }
  });

  it('applies to a dry run too, and never reads the config of an unverified base', async () => {
    const deps = stub({ prInfo: prInfoFor(fx, { baseRefName: 'something-else' }) });
    const git = jest.fn(deps.git);
    const r = await cli.runGateFlow(gatePayload(fx, { dryRun: true }), { ...deps, git });
    expect(r.stage).toBe('config');
    const readConfig = git.mock.calls.filter(([args]) => args[0] === 'show' && String(args[1]).includes('.ensemble/local-ci.yaml'));
    expect(readConfig).toEqual([]);
  });

  it.each([
    ['pr missing', { pr: undefined }],
    ['pr zero', { pr: 0 }],
    ['pr negative', { pr: -3 }],
    ['pr a string', { pr: '7' }],
    ['pr a float', { pr: 7.5 }],
    ['pr too large', { pr: 2 ** 40 }],
    ['repo missing', { repo: undefined }],
    ['repo without a slash', { repo: 'norepo' }],
    ['repo option-shaped', { repo: '--help/x' }],
    ['repo with a path escape', { repo: 'a/../b' }],
    ['repo with a space', { repo: 'a b/c' }],
  ])('rejects a malformed payload before any lookup: %s', async (_n, over) => {
    const prInfo = jest.fn(() => ({ ok: true, info: {} }));
    await expect(cli.runGateFlow(gatePayload(fx, over), stub({ prInfo }))).rejects.toThrow(/missing or malformed/);
    expect(() => cli.runMerge(mergePayload(fx, over), { ...cli.defaultDeps(), prInfo })).toThrow(/missing or malformed/);
    expect(prInfo).not.toHaveBeenCalled();
  });
});

describe('the sibling-base attack, end to end through the real runner', () => {
  // The reviewer's reproduction: the contributor pushes origin/feature-x whose config omits the Test step and whose
  // workflow matches. The PR head's real Test fails. Naming the sibling as the base used to approve it.
  function attackRepo() {
    const fx = makeBaseRepo({
      config: STRICT,
      files: { [WORKFLOW]: wf(['node scripts/build.js', 'node scripts/test.js']), 'scripts/build.js': 'process.exit(0)\n', 'scripts/test.js': 'process.exit(0)\n' },
    });
    const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(fx.dir, rel)), { recursive: true }); fs.writeFileSync(path.join(fx.dir, rel), text); };
    // sibling branch, forked from the real base, with a weaker config
    fx.git('checkout', '-q', '-b', 'attacker', fx.baseSha);
    put(WORKFLOW, wf(['node scripts/build.js']));
    put('.ensemble/local-ci.yaml', cfg([{ name: 'Build', cmd: 'node scripts/build.js' }]));
    fx.git('add', '-A');
    fx.git('commit', '-qm', 'attacker config');
    fx.git('update-ref', 'refs/remotes/origin/feature-x', fx.git('rev-parse', 'HEAD'));
    // the PR head, forked from the real base, whose Test really fails
    fx.git('checkout', '-q', '-b', 'pr-head', fx.baseSha);
    put('scripts/test.js', 'console.error("REAL CHECK FAILS");process.exit(1)\n');
    fx.git('add', '-A');
    fx.git('commit', '-qm', 'pr head');
    return { ...fx, headSha: fx.git('rev-parse', 'HEAD') };
  }

  const real = () => ({ ...cli.defaultDeps(), ...noNetwork, runnerDeps: { resolveNodeBinDir: () => path.dirname(process.execPath) } });

  it('control: graded by the real base, the failing Test fails the gate', async () => {
    const fx = attackRepo();
    const r = await cli.runGateFlow(gatePayload(fx), { ...real(), prInfo: prInfoFor(fx) });
    expect(r.stage).toBe('run');
    expect(r.ok).toBe(false);
    expect(r.mergeReady).toBe(false);
  });

  it('naming the contributor-pushed sibling as the base is refused instead of approving the failing head', async () => {
    const fx = attackRepo();
    const r = await cli.runGateFlow(gatePayload(fx, { baseRef: 'origin/feature-x' }), { ...real(), prInfo: prInfoFor(fx) });
    expect(r.stage).toBe('config');
    expect(r.ok).toBe(false);
    expect(r.mergeReady).toBe(false);
    expect(r.error).toMatch(/not the base branch/);
  });
});

describe('through a real process, with a gh that answers on PATH', () => {
  const CLI_PATH = path.join(__dirname, '..', 'lib', 'local-ci-cli.js');
  const run = (sub, payload, ghDir) =>
    spawnSync(process.execPath, [CLI_PATH, sub], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      env: { ...process.env, PATH: `${ghDir}${path.delimiter}${process.env.PATH}` },
    });

  it('the default lookup shells out to `gh pr view` and a mismatching answer refuses the merge', () => {
    const fx = makeBaseRepo({ config: STRICT });
    fx.git('update-ref', 'refs/remotes/origin/feature-x', fx.baseSha);
    const ghDir = fakeGhDir({ baseRefName: 'trusted-base', headRefOid: fx.headSha, state: 'OPEN' });
    const refused = run('merge', mergePayload(fx, { baseRef: 'origin/feature-x' }), ghDir);
    expect(refused.status).toBe(1);
    expect(JSON.parse(refused.stdout)).toMatchObject({ mergeReady: false });
    expect(JSON.parse(refused.stdout).reason).toMatch(/not the base branch/);
    // and the honest base is not refused for identity (it then reports there is simply no status yet)
    const honest = run('merge', mergePayload(fx), ghDir);
    expect(JSON.parse(honest.stdout).reason || '').not.toMatch(/base branch|current head|cannot verify/);
  });

  it('a gh that fails is a refusal, not a pass', () => {
    const fx = makeBaseRepo({ config: STRICT });
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'local-ci-badgh-'));
    fs.writeFileSync(path.join(d, 'gh'), '#!/bin/sh\necho "gh: not logged in" >&2\nexit 4\n', { mode: 0o755 });
    try {
      const r = run('merge', mergePayload(fx), d);
      expect(r.status).toBe(1);
      expect(JSON.parse(r.stdout).reason).toMatch(/cannot verify pull request #7/);
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it('passes repo and the PR number to gh as separate argv elements, never through a shell', () => {
    const fx = makeBaseRepo({ config: STRICT });
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'local-ci-argvgh-'));
    const log = path.join(d, 'argv.log');
    fs.writeFileSync(path.join(d, 'gh'), `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> ${JSON.stringify(log)}; done\nprintf '%s' '{"baseRefName":"trusted-base","headRefOid":"${fx.headSha}","state":"OPEN"}'\n`, { mode: 0o755 });
    try {
      run('merge', mergePayload(fx), d);
      expect(fs.readFileSync(log, 'utf8').trim().split('\n')).toEqual(['pr', 'view', '7', '--repo', REPO, '--json', 'baseRefName,headRefOid,state']);
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });
});
