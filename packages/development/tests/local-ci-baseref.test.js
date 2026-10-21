'use strict';

/**
 * The trusted config is the PR's BASE-BRANCH ref, read with git (`git show <baseRef>:...`),
 * never the maintainer's working tree. Real temp git repos, the real CLI handlers, a fake
 * GitHub fetch and an injected runner result (no Node download, no network).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const cli = require('../lib/local-ci-cli');
const { buildRecord } = require('../lib/local-ci-record');
const { makeBaseRepo, cleanupBaseRepos } = require('./helpers/local-ci-base-repo');

afterAll(cleanupBaseRepos);

const major = Number(process.versions.node.split('.')[0]);
const cfg = (steps, extra = '') =>
  `workflows:\n  - file: .github/workflows/ci.yml\n    jobs:\n      - id: ci\n        matrix:\n          node-version: [${major}]\nsteps:\n${steps}\nstatus_context: x/local-ci\napp_id: 1\n${extra}`;
const WF = (run) => `name: ci\non: [push]\njobs:\n  ci:\n    runs-on: ubuntu-latest\n    steps:\n      - run: ${run}\n`;
const STRICT = cfg('  - name: real-check\n    cmd: exit 1');
const WEAK = cfg('  - name: real-check\n    cmd: "true"');
const CTX = 'x/local-ci';

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const CREDENTIAL = { credential: { appId: '1', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) } };

function fakeFetch() {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, body: init.body ? JSON.parse(init.body) : null });
    const reply = (o) => ({ status: 200, json: async () => o });
    if (url.endsWith('/installation')) return reply({ id: 7 });
    if (url.endsWith('/access_tokens')) return reply({ token: 'ghs_' + 'x'.repeat(36) });
    return reply({ id: 99 });
  };
  fn.statuses = () => calls.filter((c) => /\/statuses\//.test(c.url));
  fn.calls = calls;
  return fn;
}

const passing = (options) => ({ ok: true, sha: options.headSha, failures: [], unmirrored: [], nodes: [{ node: major, ok: true, steps: [] }] });

function deps(over = {}) {
  const fetch = fakeFetch();
  const runGate = jest.fn(passing);
  return { d: { ...cli.defaultDeps(), fetch, runGate, loadCredential: () => CREDENTIAL, env: {}, ...over }, fetch, runGate };
}

/** Base: strict config; head (checked out): rewrites config + workflow so the required command is `true`. */
const weakenedHead = () =>
  makeBaseRepo({
    config: STRICT,
    files: { '.github/workflows/ci.yml': WF('exit 1') },
    headFiles: { '.ensemble/local-ci.yaml': WEAK, '.github/workflows/ci.yml': WF('"true"') },
  });

const blobAt = (repo, ref) => repo.git('rev-parse', `${ref}:.ensemble/local-ci.yaml`);
const payload = (repo, extra = {}) => ({ repoRoot: repo.dir, headSha: repo.headSha, baseRef: repo.baseRef, repo: 'o/r', ...extra });

describe('(a) a head that rewrites its own config is graded by the BASE config, with the head checked out', () => {
  it('gate hands the runner the base steps (exit 1), not the head rewrite, and the record carries the base blob', async () => {
    const repo = weakenedHead();
    expect(repo.git('rev-parse', 'HEAD')).toBe(repo.headSha); // maintainer's working tree IS the head
    expect(fs.readFileSync(path.join(repo.dir, '.ensemble/local-ci.yaml'), 'utf8')).toBe(WEAK);
    const { d, fetch, runGate } = deps();
    const r = await cli.runGateFlow(payload(repo), d);
    expect(runGate).toHaveBeenCalledTimes(1);
    expect(runGate.mock.calls[0][0].approvalSet.steps.map((s) => s.cmd || s.run || JSON.stringify(s))).toEqual(
      expect.arrayContaining([expect.stringContaining('exit 1')])
    );
    expect(JSON.stringify(runGate.mock.calls[0][0].approvalSet.steps)).not.toContain('"true"');
    expect(r.ok).toBe(true);
    const desc = fetch.statuses()[0].body.description;
    expect(desc.startsWith(`ci-local ${blobAt(repo, repo.baseRef).slice(0, 8)} `)).toBe(true);
    expect(desc.startsWith(`ci-local ${blobAt(repo, 'HEAD').slice(0, 8)} `)).toBe(false);
  });

  it('merge refuses a record produced under the head-rewritten config', () => {
    const repo = weakenedHead();
    const forged = buildRecord({ runnerBlobSha: blobAt(repo, 'HEAD'), workflowSet: ['.github/workflows/ci.yml'], log: 'x' });
    const r = cli.runMerge(
      { headSha: repo.headSha, repoRoot: repo.dir, baseRef: repo.baseRef, statuses: [{ context: CTX, state: 'success', description: forged.description, sha: repo.headSha }] },
      cli.defaultDeps()
    );
    expect(r.mergeReady).toBe(false);
    expect(r.reason).toContain(blobAt(repo, 'HEAD').slice(0, 8));
    expect(r.reason).toContain(blobAt(repo, repo.baseRef).slice(0, 8));
  });

  it('through the real runner: the weakened head fails the base `exit 1` step and is not merge-ready', async () => {
    const repo = weakenedHead();
    fs.writeFileSync(path.join(repo.dir, 'package.json'), '{}');
    repo.git('add', '-A');
    repo.git('commit', '-qm', 'pkg');
    const head = repo.git('rev-parse', 'HEAD');
    const d = {
      ...cli.defaultDeps(),
      loadCredential: () => CREDENTIAL,
      fetch: fakeFetch(),
      runnerDeps: { resolveNodeBinDir: () => path.dirname(process.execPath) },
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
    };
    const r = await cli.runGateFlow({ repoRoot: repo.dir, headSha: head, baseRef: repo.baseRef, repo: 'o/r', dryRun: true }, d);
    expect(r.mergeReady).toBe(false);
  });
});

describe('(b) an uncommitted local edit to the config is ignored', () => {
  it('the base config is used even when the working-tree file is changed or deleted', async () => {
    const repo = makeBaseRepo({ config: STRICT });
    fs.writeFileSync(path.join(repo.dir, '.ensemble/local-ci.yaml'), WEAK);
    let c = cli.runConfig({ repoRoot: repo.dir, baseRef: repo.baseRef }, cli.defaultDeps());
    expect(c.ok).toBe(true);
    expect(JSON.stringify(c.approvalSet.steps)).toContain('exit 1');
    expect(c.configBlobSha).toBe(blobAt(repo, repo.baseRef));
    fs.rmSync(path.join(repo.dir, '.ensemble/local-ci.yaml'));
    c = cli.runConfig({ repoRoot: repo.dir, baseRef: repo.baseRef }, cli.defaultDeps());
    expect(c.ok).toBe(true);
    expect(JSON.stringify(c.approvalSet.steps)).toContain('exit 1');
  });

  it('config never reads the working tree through deps.readFile', () => {
    const repo = makeBaseRepo({ config: STRICT });
    const readFile = jest.fn(() => WEAK);
    const c = cli.runConfig({ repoRoot: repo.dir, baseRef: repo.baseRef }, { ...cli.defaultDeps(), readFile });
    expect(c.ok).toBe(true);
    expect(readFile).not.toHaveBeenCalled();
  });
});

describe('(c) baseRef is required and cannot inject git options', () => {
  const repo = makeBaseRepo({ config: STRICT });
  const base = { repoRoot: repo.dir, headSha: repo.headSha };
  const handlers = {
    config: (p) => cli.runConfig({ repoRoot: repo.dir, ...p }, cli.defaultDeps()),
    run: (p) => cli.runRun({ ...base, ...p }, deps().d),
    merge: (p) => cli.runMerge({ ...base, statuses: [], ...p }, cli.defaultDeps()),
    gate: (p) => cli.runGateFlow({ ...base, repo: 'o/r', dryRun: true, ...p }, deps().d),
  };

  it.each(['config', 'run', 'merge', 'gate'])('%s rejects a missing, blank, non-text or leading-dash baseRef at the boundary', async (name) => {
    for (const bad of [undefined, '', '   ', 5, null, '-x', '--output=/tmp/x']) {
      const p = bad === undefined ? {} : { baseRef: bad };
      await expect(Promise.resolve().then(() => handlers[name](p))).rejects.toThrow(/baseRef/);
    }
  });

  it('an unknown ref is refused (no fallback to the working tree)', async () => {
    const r = handlers.config({ baseRef: 'no-such-ref' });
    expect(r.ok).toBe(false);
    expect(r.problems.join(' ')).toMatch(/does not resolve/);
    const g = await handlers.gate({ baseRef: 'no-such-ref' });
    expect(g.ok).toBe(false);
    expect(g.stage).toBe('config');
  });

  it('a ref named like a git option is passed as data: git is never told --output and creates no file', async () => {
    const out = `/tmp/local-ci-baseref-inject-${process.pid}`;
    fs.rmSync(out, { force: true });
    const ref = `--output=${out}`;
    repo.git('branch', '--', 'safe');
    // reaches loadTrustedConfig only through direct calls (boundary already rejects it); also via a CLI process
    const spawned = spawnSync(process.execPath, [path.join(__dirname, '..', 'lib', 'local-ci-cli.js'), 'config'], {
      input: JSON.stringify({ repoRoot: repo.dir, baseRef: ref }),
      encoding: 'utf8',
    });
    expect(spawned.status).toBe(1);
    expect(JSON.parse(spawned.stdout).error).toMatch(/baseRef/);
    // and a ref that merely CONTAINS the option text after a safe prefix is still just an unknown ref
    const r = cli.runConfig({ repoRoot: repo.dir, baseRef: `safe..${ref}` }, cli.defaultDeps());
    expect(r.ok).toBe(false);
    expect(fs.existsSync(out)).toBe(false);
  });
});

describe('(d) the head is not its own base', () => {
  it('baseRef resolving to the head SHA is refused by gate, run and merge, naming both', async () => {
    const repo = makeBaseRepo({ config: STRICT });
    const asHead = { ...payload(repo), baseRef: repo.headSha };
    const { d, runGate, fetch } = deps();
    const g = await cli.runGateFlow(asHead, d);
    expect(g).toMatchObject({ ok: false, mergeReady: false, stage: 'config' });
    expect(g.error).toMatch(/own base/);
    expect(g.error).toContain(repo.headSha);
    expect(runGate).not.toHaveBeenCalled();
    expect(fetch.calls).toHaveLength(0);
    expect(cli.runRun({ repoRoot: repo.dir, headSha: repo.headSha, baseRef: repo.headSha }, d).ok).toBe(false);
    const m = cli.runMerge({ headSha: repo.headSha, repoRoot: repo.dir, baseRef: 'HEAD', statuses: [] }, cli.defaultDeps());
    expect(m.mergeReady).toBe(false);
    expect(m.reason).toMatch(/own base/);
  });
});

describe('(e) no shared history is refused', () => {
  it('an orphan head with no merge-base is refused; a diverged base that shares history is accepted', async () => {
    const repo = makeBaseRepo({ config: STRICT });
    repo.git('checkout', '-q', '--orphan', 'orphan');
    repo.git('rm', '-rfq', '.');
    fs.writeFileSync(path.join(repo.dir, 'other.txt'), 'unrelated\n');
    repo.git('add', '-A');
    repo.git('commit', '-qm', 'unrelated root');
    const orphan = repo.git('rev-parse', 'HEAD');
    const { d, runGate } = deps();
    const g = await cli.runGateFlow({ repoRoot: repo.dir, headSha: orphan, baseRef: repo.baseRef, repo: 'o/r', dryRun: true }, d);
    expect(g).toMatchObject({ ok: false, stage: 'config' });
    expect(g.error).toMatch(/no history|merge-base/);
    expect(runGate).not.toHaveBeenCalled();

    // base advanced past the merge point: not an ancestor, but a merge-base exists
    repo.git('checkout', '-q', repo.baseRef);
    fs.writeFileSync(path.join(repo.dir, 'advance.txt'), 'a\n');
    repo.git('add', '-A');
    repo.git('commit', '-qm', 'base advances');
    const ok = await cli.runGateFlow({ repoRoot: repo.dir, headSha: repo.headSha, baseRef: repo.baseRef, repo: 'o/r', dryRun: true }, deps().d);
    expect(ok.ok).toBe(true);
  });
});

describe('(f) a status produced under a different config blob is refused by merge', () => {
  it('names both short hashes; the same status under the matching config is accepted', () => {
    const repo = makeBaseRepo({ config: STRICT, files: { '.github/workflows/ci.yml': WF('exit 1') } });
    const trusted = blobAt(repo, repo.baseRef);
    const foreign = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    const mk = (blob) => buildRecord({ runnerBlobSha: blob, workflowSet: ['.github/workflows/ci.yml'], log: 'x' }).description;
    const merge = (blob) =>
      cli.runMerge({ headSha: repo.headSha, repoRoot: repo.dir, baseRef: repo.baseRef, statuses: [{ context: CTX, state: 'success', description: mk(blob), sha: repo.headSha }] }, cli.defaultDeps());
    const bad = merge(foreign);
    expect(bad.mergeReady).toBe(false);
    expect(bad.reason).toContain('deadbeef');
    expect(bad.reason).toContain(trusted.slice(0, 8));
    expect(merge(trusted).mergeReady).toBe(true);
  });
});

describe('(g) gate -> merge round trip', () => {
  it('the posted record carries the trusted blob and merge accepts it for the same base config only', async () => {
    const repo = makeBaseRepo({ config: STRICT });
    const { d, fetch } = deps();
    const r = await cli.runGateFlow(payload(repo), d);
    expect(r).toMatchObject({ ok: true, posted: true, mergeReady: true });
    const post = fetch.statuses()[0];
    expect(post.url).toContain(`/statuses/${repo.headSha}`);
    expect(post.body.description.startsWith(`ci-local ${blobAt(repo, repo.baseRef).slice(0, 8)} `)).toBe(true);
    const status = { context: CTX, state: 'success', description: post.body.description, sha: repo.headSha };
    const merge = () => cli.runMerge({ headSha: repo.headSha, repoRoot: repo.dir, baseRef: repo.baseRef, statuses: [status] }, cli.defaultDeps());
    expect(merge().mergeReady).toBe(true);

    // the base branch's config changes (a different blob): the old status no longer counts
    repo.git('checkout', '-q', repo.baseRef);
    fs.writeFileSync(path.join(repo.dir, '.ensemble/local-ci.yaml'), cfg('  - name: real-check\n    cmd: exit 2'));
    repo.git('commit', '-qam', 'base changes the gate');
    repo.git('checkout', '-q', repo.headSha);
    const stale = merge();
    expect(stale.mergeReady).toBe(false);
    expect(stale.reason).toMatch(/differs from trusted config/);
  });
});

describe('(h) a PR that edits the config is graded by the OLD config', () => {
  it('its added required step is not enforced and its removed step is not honoured', async () => {
    const twoSteps = cfg('  - name: lint\n    cmd: exit 1\n  - name: unit\n    cmd: exit 1');
    const edited = cfg('  - name: only-new\n    cmd: "true"');
    const repo = makeBaseRepo({ config: twoSteps, headFiles: { '.ensemble/local-ci.yaml': edited } });
    const { d, runGate } = deps();
    await cli.runGateFlow(payload(repo, { dryRun: true }), d);
    const names = runGate.mock.calls[0][0].approvalSet.steps.map((s) => s.name);
    expect(names).toEqual(['lint', 'unit']);
    expect(names).not.toContain('only-new');
  });
});

describe('the runner never reads a config from the clone', () => {
  it("the head's own .ensemble/local-ci.yaml is not consulted by runGate: only the handed approvalSet matters", () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'local-ci-runner.js'), 'utf8');
    expect(src).not.toMatch(/local-ci\.yaml/);
    expect(src).not.toMatch(/require\(['"]\.\/local-ci-config['"]\)/);
    expect(src).not.toMatch(/\bvalidateConfig\(/);
  });
});
