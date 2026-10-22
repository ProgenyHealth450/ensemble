'use strict';

/**
 * Gate end to end (TRD-005-TEST). Real local-ci-* modules, a real signed App
 * JWT (throwaway RSA key) and a fake fetch; the runner result is injected
 * because running CI needs Node downloads. No network, no real credential.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const cli = require('../lib/local-ci-cli');
const { validateConfig } = require('../lib/local-ci-config');
const { buildRecord, verifyRecord } = require('../lib/local-ci-record');
const { makeBaseRepo, cleanupBaseRepos, prInfoFor, fakeGhDir, PR } = require('./helpers/local-ci-base-repo');

const CLI_PATH = path.join(__dirname, '..', 'lib', 'local-ci-cli.js');
const REPO_CONFIG = path.join(__dirname, '..', '..', '..', '.ensemble', 'local-ci.yaml');
const CONFIG = validateConfig(fs.readFileSync(REPO_CONFIG, 'utf8'));
const WORKFLOW_SET = CONFIG.approvalSet.workflows.map((w) => w.file);
const CONTEXT = CONFIG.approvalSet.statusContext;
if (typeof CONTEXT !== 'string' || CONTEXT === '') throw new Error('fixture config has no status context');
const OTHER = 'b'.repeat(40);

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });
const CREDENTIAL = { credential: { appId: '12345', privateKey: PEM } };

/** Fake GitHub API: records every call, answers the three the App client makes. */
function fakeFetch() {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : null });
    const reply = (obj) => ({ status: 200, json: async () => obj });
    if (url.endsWith('/installation')) return reply({ id: 7 });
    if (url.endsWith('/access_tokens')) return reply({ token: 'ghs_' + 'x'.repeat(36) });
    return reply({ id: 99 });
  };
  fn.calls = calls;
  fn.statuses = () => calls.filter((c) => /\/statuses\//.test(c.url));
  return fn;
}

/** A repo whose base ref carries the trusted config (`config` overrides its text, null omits it); the head is checked out. */
function tempRepo({ config } = {}) {
  return makeBaseRepo({ config: config === undefined ? fs.readFileSync(REPO_CONFIG, 'utf8') : config });
}

const passingRun = (sha) => ({ ok: true, sha, failures: [], unmirrored: [], nodes: [{ node: 22, ok: true, steps: [] }, { node: 24, ok: true, steps: [] }] });

function makeDeps(overrides = {}) {
  const fetch = fakeFetch();
  const runGate = jest.fn((options) => passingRun(options.headSha));
  const deps = {
    ...cli.defaultDeps(),
    fetch,
    runGate,
    loadCredential: () => CREDENTIAL,
    env: {},
    ...overrides,
  };
  return { deps, fetch, runGate };
}

function gatePayload(repo, extra = {}) {
  return { repoRoot: repo.dir, headSha: repo.sha, baseRef: repo.baseRef, repo: 'owner/name', pr: PR, ...extra };
}

afterAll(cleanupBaseRepos);
const repoWith = (opts) => tempRepo(opts);

describe('merge readiness', () => {
  const fixture = repoWith();
  const HEAD = fixture.sha;
  const trustedBlob = fixture.git('rev-parse', `${fixture.baseRef}:.ensemble/local-ci.yaml`);
  const record = buildRecord({ runnerBlobSha: trustedBlob, workflowSet: WORKFLOW_SET, log: 'run' });
  const status = (over = {}) => ({ context: CONTEXT, state: 'success', description: record.description, sha: HEAD, ...over });
  const merge = (statuses, extra = {}) => cli.runMerge({ headSha: HEAD, statuses, repoRoot: fixture.dir, baseRef: fixture.baseRef, repo: 'owner/name', pr: PR, ...extra }, { ...cli.defaultDeps(), prInfo: prInfoFor(fixture) });

  it('passing run merges: a verified status bound to the exact head is ready without hosted CI', () => {
    const r = merge([status()]);
    expect(r).toMatchObject({ ok: true, mergeReady: true, headSha: HEAD, hostedCiWaitRequired: false });
    expect(verifyRecord({ description: record.description, statusCommitSha: HEAD, headSha: HEAD, runnerBlobSha: trustedBlob, workflowSet: WORKFLOW_SET }).ok).toBe(true);
  });

  it('no run refuses and reports the missing run', () => {
    const r = merge([{ ...status(), context: 'some/other-check' }]);
    expect(r.mergeReady).toBe(false);
    expect(r.missingRun).toBe(true);
    expect(r.reason).toContain(HEAD);
  });

  it('a status on an older commit refuses, naming both SHAs', () => {
    const r = merge([status({ sha: OTHER })]);
    expect(r.mergeReady).toBe(false);
    expect(r.headMoved).toBe(true);
    expect(r.reason).toContain(OTHER);
    expect(r.reason).toContain(HEAD);
  });

  it('a failure status, a record for a different workflow set, or a blocking review refuses', () => {
    expect(merge([status({ state: 'failure' })]).mergeReady).toBe(false);
    const other = buildRecord({ runnerBlobSha: trustedBlob, workflowSet: ['.github/workflows/other.yml'], log: 'run' });
    expect(merge([status({ description: other.description })]).mergeReady).toBe(false);
    const blocked = merge([status()], {
      reviews: [{ author: { login: 'alice', type: 'User' }, state: 'CHANGES_REQUESTED', submittedAt: '2026-01-01T00:00:00Z' }],
    });
    expect(blocked.mergeReady).toBe(false);
    expect(blocked.reason).toMatch(/alice/);
  });

  it('an unusable config refuses rather than guessing', () => {
    const bad = repoWith({ config: 'not: [valid' });
    const r = cli.runMerge({ headSha: bad.sha, statuses: [status({ sha: bad.sha })], repoRoot: bad.dir, baseRef: bad.baseRef, repo: 'owner/name', pr: PR }, { ...cli.defaultDeps(), prInfo: prInfoFor(bad) });
    expect(r.mergeReady).toBe(false);
    expect(r.reason).toMatch(/config invalid/);
    const none = repoWith({ config: null });
    expect(cli.runMerge({ headSha: none.sha, statuses: [status({ sha: none.sha })], repoRoot: none.dir, baseRef: none.baseRef, repo: 'owner/name', pr: PR }, { ...cli.defaultDeps(), prInfo: prInfoFor(none) }).mergeReady).toBe(false);
  });
});

describe('gate flow', () => {
  it('a missing or invalid maintainer config stops at the config stage, never runs or posts', async () => {
    for (const config of [null, 'not: [valid', 'workflows: []\n']) {
      const repo = repoWith({ config });
      const { deps, fetch, runGate } = makeDeps({ prInfo: prInfoFor(repo) });
      const r = await cli.runGateFlow(gatePayload(repo), deps);
      expect(r).toMatchObject({ ok: false, mergeReady: false, posted: false, stage: 'config' });
      expect(r.error).toMatch(/config invalid/);
      expect(runGate).not.toHaveBeenCalled();
      expect(fetch.calls).toHaveLength(0);
    }
  });

  it.each([
    ['node', { node: () => ({ status: 127, stdout: '', stderr: 'not found' }) }],
    ['git', { git: () => ({ status: 127, stdout: '', stderr: 'not found' }) }],
  ])('missing %s stops naming it, never runs or posts', async (name, override) => {
    const repo = repoWith();
    const { deps, fetch, runGate } = makeDeps({ ...override, prInfo: prInfoFor(repo) });
    const r = await cli.runGateFlow(gatePayload(repo), deps);
    expect(r).toMatchObject({ ok: false, mergeReady: false, posted: false, prerequisite: name });
    expect(runGate).not.toHaveBeenCalled();
    expect(fetch.calls).toHaveLength(0);
  });

  it('dry run reports readiness and posts nothing', async () => {
    const repo = repoWith();
    const { deps, fetch } = makeDeps({ prInfo: prInfoFor(repo) });
    const r = await cli.runGateFlow(gatePayload(repo, { dryRun: true }), deps);
    expect(r).toMatchObject({ ok: true, dryRun: true, mergeReady: true, posted: false, wouldPost: true });
    expect(fetch.calls).toHaveLength(0);
  });

  it('dry run without a credential is not ready: cannot attest', async () => {
    const repo = repoWith();
    const { deps, fetch } = makeDeps({ loadCredential: () => ({ credential: null, reason: 'cannot attest' }), prInfo: prInfoFor(repo) });
    const r = await cli.runGateFlow(gatePayload(repo, { dryRun: true }), deps);
    expect(r).toMatchObject({ ok: false, mergeReady: false, posted: false, cannotAttest: true });
    expect(fetch.calls).toHaveLength(0);
  });

  it('no credential publishes nothing and refuses the merge', async () => {
    const repo = repoWith();
    const { deps, fetch } = makeDeps({ loadCredential: () => ({ credential: null, reason: 'cannot attest' }), prInfo: prInfoFor(repo) });
    const r = await cli.runGateFlow(gatePayload(repo), deps);
    expect(r).toMatchObject({ ok: false, mergeReady: false, posted: false, cannotAttest: true });
    expect(r.error).toContain('cannot attest');
    expect(fetch.calls).toHaveLength(0);
  });

  it('a passing run posts one success status on the exact head that then verifies as merge-ready', async () => {
    const repo = repoWith();
    const { deps, fetch, runGate } = makeDeps({ prInfo: prInfoFor(repo) });
    const r = await cli.runGateFlow(gatePayload(repo), deps);
    expect(runGate).toHaveBeenCalledTimes(1);
    expect(runGate.mock.calls[0][0]).toMatchObject({ headSha: repo.sha, repoRoot: path.resolve(repo.dir) });
    // the approval set and command list handed to the runner are the maintainer file's
    expect(runGate.mock.calls[0][0].approvalSet).toEqual(CONFIG.approvalSet);
    expect(r).toMatchObject({ ok: true, posted: true, mergeReady: true });

    const posted = fetch.statuses();
    expect(posted).toHaveLength(1);
    expect(posted[0].url).toContain(`/statuses/${repo.sha}`);
    expect(posted[0].body).toMatchObject({ state: 'success', context: CONTEXT });

    const ready = cli.runMerge(
      { headSha: repo.sha, repoRoot: repo.dir, baseRef: repo.baseRef, repo: 'owner/name', pr: PR, statuses: [{ context: CONTEXT, state: 'success', description: posted[0].body.description, sha: repo.sha }] },
      deps
    );
    expect(ready.mergeReady).toBe(true);
    // The same status no longer counts once the head moves (a real new commit on the PR branch).
    fs.writeFileSync(path.join(repo.dir, 'later.txt'), 'later\n');
    repo.git('add', '-A');
    repo.git('commit', '-qm', 'head moves');
    const movedHead = repo.git('rev-parse', 'HEAD');
    const moved = cli.runMerge(
      { headSha: movedHead, repoRoot: repo.dir, baseRef: repo.baseRef, repo: 'owner/name', pr: PR, statuses: [{ context: CONTEXT, state: 'success', description: posted[0].body.description, sha: repo.sha }] },
      { ...deps, prInfo: prInfoFor(repo, { headRefOid: movedHead }) }
    );
    expect(moved.mergeReady).toBe(false);
    expect(moved.headMoved).toBe(true);
  });

  it('a failing step is reported with workflow, job, step and head SHA, and never posts success', async () => {
    const repo = repoWith();
    const runGate = jest.fn(() => ({
      ok: false,
      sha: repo.sha,
      failures: [{ kind: 'step-failed', step: 'test', node: 22, sha: repo.sha, message: `required step "test" failed on Node 22 at ${repo.sha}` }],
      unmirrored: [],
      nodes: [{ node: 22, ok: false, steps: [{ name: 'test', status: 'FAIL' }] }],
    }));
    const { deps, fetch } = makeDeps({ runGate, prInfo: prInfoFor(repo) });
    const r = await cli.runGateFlow(gatePayload(repo), deps);
    expect(r.ok).toBe(false);
    expect(r.mergeReady).toBe(false);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toMatchObject({ step: 'test', sha: repo.sha, job: 'node 22' });
    expect(r.failures[0].workflow).toBeTruthy();
    const posted = fetch.statuses();
    expect(posted.map((p) => p.body.state)).toEqual(['failure']);
    expect(posted[0].body.description).toContain('test');
  });

  it('an unsupported step names workflow, job, step and SHA and never becomes success', async () => {
    const repo = repoWith();
    const runGate = jest.fn(() => ({
      ok: false,
      sha: repo.sha,
      failures: [{ kind: 'unmirrored-step', step: 'Deploy', node: null, sha: repo.sha, message: 'x' }],
      unmirrored: [{ workflow: '.github/workflows/test.yml', job: 'test', step: 'Deploy', reason: 'no configured step mirrors it' }],
      nodes: [],
    }));
    const { deps, fetch } = makeDeps({ runGate, prInfo: prInfoFor(repo) });
    const r = await cli.runGateFlow(gatePayload(repo), deps);
    expect(r.mergeReady).toBe(false);
    expect(r.failures[0]).toMatchObject({ kind: 'unsupported-step', workflow: '.github/workflows/test.yml', job: 'test', step: 'Deploy', sha: repo.sha });
    expect(fetch.statuses().every((p) => p.body.state !== 'success')).toBe(true);
  });

  it.each([
    ['unfetchable head', { kind: 'unfetchable-head', message: 'cannot fetch' }],
    ['unprovidable Node', { kind: 'node-version', message: 'required Node 22 cannot be provided' }],
    ['runner error', { kind: 'runner-error', message: 'boom' }],
  ])('runner failure (%s) never becomes success and posts nothing', async (_n, failure) => {
    const repo = repoWith();
    const runGate = jest.fn(() => ({ ok: false, sha: repo.sha, error: failure.message, failures: [{ ...failure, step: null, node: null, sha: repo.sha }], unmirrored: [], nodes: [] }));
    const { deps, fetch } = makeDeps({ runGate, prInfo: prInfoFor(repo) });
    const r = await cli.runGateFlow(gatePayload(repo), deps);
    expect(r).toMatchObject({ ok: false, mergeReady: false, posted: false });
    expect(fetch.calls).toHaveLength(0);
  });

  it('a runner claiming ok with zero nodes or failures present is not success', async () => {
    const repo = repoWith();
    for (const result of [
      { ok: true, sha: repo.sha, failures: [], unmirrored: [], nodes: [] },
      { ok: true, sha: repo.sha, failures: [{ kind: 'step-failed', step: 's', node: 22, sha: repo.sha, message: 'm' }], unmirrored: [], nodes: [{ node: 22, ok: true }] },
    ]) {
      const { deps, fetch } = makeDeps({ runGate: () => result, prInfo: prInfoFor(repo) });
      const r = await cli.runGateFlow(gatePayload(repo), deps);
      expect(r.mergeReady).toBe(false);
      expect(fetch.statuses().every((p) => p.body.state !== 'success')).toBe(true);
    }
  });
});

describe('CLI boundary and output', () => {
  const run = (args, input) => spawnSync(process.execPath, [CLI_PATH, ...args], { input, encoding: 'utf8' });

  it('rejects malformed JSON with exit 1 and {error}', () => {
    const r = run(['config'], '{not json');
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stdout).error).toMatch(/invalid JSON/);
  });

  it('rejects oversized payloads before parsing, with no side effects', () => {
    const big = JSON.stringify({ reviews: [], pad: 'x'.repeat(cli.MAX_STDIN_BYTES) });
    const r = run(['review'], big);
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stdout).error).toMatch(/exceeds/);
  });

  it('rejects unknown and prototype-named subcommands', () => {
    for (const name of ['nope', 'constructor', '__proto__', 'toString']) {
      const r = run([name], '{}');
      expect(r.status).toBe(1);
      expect(JSON.parse(r.stdout).error).toMatch(/Unknown subcommand/);
    }
    expect(run([], '{}').status).toBe(1);
  });

  it('a gate refusal exits 1; a ready merge exits 0, through the real process', () => {
    const fx = repoWith();
    const blob = fx.git('rev-parse', `${fx.baseRef}:.ensemble/local-ci.yaml`);
    const record = buildRecord({ runnerBlobSha: blob, workflowSet: WORKFLOW_SET, log: 'run' });
    const fakeDir = fakeGhDir({ baseRefName: 'trusted-base', headRefOid: fx.sha, state: 'OPEN' });
    const env = { ...process.env, PATH: fakeDir + path.delimiter + process.env.PATH };
    const runGh = (args, input) => spawnSync(process.execPath, [CLI_PATH, ...args], { input, encoding: 'utf8', env });
    const ok = runGh(['merge'], JSON.stringify({ headSha: fx.sha, repoRoot: fx.dir, baseRef: fx.baseRef, repo: 'owner/name', pr: PR, statuses: [{ context: CONTEXT, state: 'success', description: record.description, sha: fx.sha }] }));
    expect(ok.status).toBe(0);
    expect(JSON.parse(ok.stdout).mergeReady).toBe(true);
    const no = runGh(['merge'], JSON.stringify({ headSha: fx.sha, repoRoot: fx.dir, baseRef: fx.baseRef, repo: 'owner/name', pr: PR, statuses: [] }));
    expect(no.status).toBe(1);
    expect(JSON.parse(no.stdout).mergeReady).toBe(false);
  });

  it('redacts secrets in everything it emits', async () => {
    const token = 'ghp_' + 'A'.repeat(36);
    const repo = repoWith();
    const runGate = () => ({
      ok: false,
      sha: repo.sha,
      error: `clone failed with ${token}`,
      failures: [{ kind: 'step-failed', step: 'test', node: 22, sha: repo.sha, message: `leaked ${token}` }],
      unmirrored: [],
      nodes: [],
    });
    const { deps } = makeDeps({ runGate, prInfo: prInfoFor(repo) });
    let out = '';
    const code = await cli.main(['gate'], { ...deps, io: { readJson: () => gatePayload(repo), write: (s) => (out += s) } });
    expect(code).toBe(1);
    expect(out).not.toContain(token);
    expect(out).toContain('[REDACTED]');
  });

  it('delegating subcommands return the module verdicts verbatim', async () => {
    const call = async (sub, payload) => {
      let out = '';
      const code = await cli.main([sub], { ...cli.defaultDeps(), io: { readJson: () => payload, write: (s) => (out += s) } });
      return { code, body: JSON.parse(out) };
    };
    const fx = repoWith();
    expect((await call('config', { repoRoot: fx.dir, baseRef: fx.baseRef })).body.approvalSet.statusContext).toBe(CONTEXT);
    const built = await call('record', { action: 'build', input: { runnerBlobSha: 'c0ffee123456', workflowSet: WORKFLOW_SET, log: 'l' } });
    expect(built.body.ok).toBe(true);
    expect((await call('record', { action: 'parse', input: built.body.description })).body.fields).toEqual(built.body.fields);
    expect((await call('record', { action: 'parse', input: 'garbage' })).code).toBe(1);
    expect((await call('review', { action: 'decide', reviews: 'nope' })).body.blocked).toBe(true);
    expect((await call('sweep', { facts: { findings: [{ prNumber: 1, commentId: 2 }], failures: [] }, trackedKeys: [] })).body.findings).toHaveLength(1);
    expect((await call('timing', { action: 'verdict', input: { localMs: 10, hostedMs: 20, toleranceMs: 1 } })).body.verdict).toBe('faster');
    expect((await call('timing', { action: 'ready', input: { note: '' } })).code).toBe(1);
    expect((await call('record', { action: 'constructor', input: {} })).code).toBe(1);
  });

  it('post without a credential publishes nothing: cannot attest', async () => {
    const fetch = fakeFetch();
    const r = await cli.runPost(
      { input: { repo: 'owner/name', sha: OTHER, state: 'success', context: CONTEXT, description: 'd' } },
      { ...cli.defaultDeps(), fetch, loadCredential: () => ({ credential: null, reason: 'cannot attest' }) }
    );
    expect(r.published).toBe(false);
    expect(r.reason).toBe('cannot attest');
    expect(fetch.calls).toHaveLength(0);
  });
});
