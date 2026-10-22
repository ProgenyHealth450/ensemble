'use strict';

/**
 * TRD-006-TEST: the local CI gate can both FAIL and PASS through the real code
 * path. A real git repo is built in a temp dir with a base commit, a deliberately
 * failing commit F and a fixing commit P, under ONE unchanged configuration.
 * Real: git clone, the trusted command run by the runner (bash -c), non-zero exit, runGate,
 * runGateFlow, postStatus (RS256 JWT signing with a throwaway in-memory key),
 * loadCredential (env), runMerge. Fake: only the network (`fetch`).
 * Not exercised: npm ci, Node downloads, the repo's real suites, real GitHub.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const { runGateFlow, runMerge, defaultDeps } = require('../lib/local-ci-cli');
const { makeBaseRepo, cleanupBaseRepos, prInfoFor, PR } = require('./helpers/local-ci-base-repo');
const { runGate } = require('../lib/local-ci-runner');
const { redact, loadCredential, postStatus } = require('../lib/local-ci-app');

const NODE_MAJOR = Number(process.versions.node.split('.')[0]);
const NODE_BIN_DIR = path.dirname(process.execPath);
const CONTEXT = 'ensemble/local-ci';
const REPO = 'example-org/example-repo';
const WORKFLOW = '.github/workflows/proof.yml';
const PROOF = path.join(__dirname, '..', 'skills', 'local-ci-gate', 'PROOF.md');

const CONFIG_YAML = `workflows:
  - file: ${WORKFLOW}
    jobs:
      - id: proof
        matrix:
          node-version: [${NODE_MAJOR}]
steps:
  - name: unit-check
    cmd: node scripts/unit-check.js
status_context: ${CONTEXT}
app_id: 12345
`;

const WORKFLOW_YAML = `name: proof
on: [push]
jobs:
  proof:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: node scripts/unit-check.js
`;

const UNIT_FAILING = `'use strict';
const assert = require('assert');
assert.strictEqual(2 + 2, 5, 'deliberately failing test');
`;
const UNIT_PASSING = `'use strict';
const assert = require('assert');
assert.strictEqual(2 + 2, 4);
`;

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=Proof', '-c', 'user.email=proof@example.invalid', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function write(root, rel, text) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}

function commit(root, message, files) {
  for (const [rel, text] of Object.entries(files)) write(root, rel, text);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', message);
  return git(root, 'rev-parse', 'HEAD');
}

/** In-memory fake of the GitHub API: records every status post. */
function fakeGitHub() {
  const posts = [];
  const fetch = async (url, init) => {
    const method = (init && init.method) || 'GET';
    const reply = (status, body) => ({ status, json: async () => body });
    if (method === 'GET' && /\/installation$/.test(url)) return reply(200, { id: 7 });
    if (method === 'POST' && /\/access_tokens$/.test(url)) return reply(201, { token: 'installation-token-for-test' });
    const m = /\/repos\/([^/]+\/[^/]+)\/statuses\/([0-9a-f]+)$/.exec(url);
    if (method === 'POST' && m) {
      const body = JSON.parse(init.body);
      posts.push({ repo: m[1], sha: m[2], state: body.state, context: body.context, description: body.description });
      return reply(201, { id: posts.length });
    }
    return reply(404, {});
  };
  return { fetch, posts };
}

describe('local CI gate can fail and can pass (TRD-006)', () => {
  let tmp;
  let repoRoot;
  let shaBase;
  let baseRef;
  let shaF;
  let shaP;
  let gh;
  let deps;
  let failedReport;
  let passedReport;
  let failedPosts;

  const payloadFor = (headSha) => ({ repoRoot, headSha, repo: REPO, pr: PR, baseRef });
  const mergePayload = (headSha) => ({ repoRoot, headSha, repo: REPO, pr: PR, baseRef });
  // Honest PR identity per head: the PR's head is whichever commit is being gated/merged.
  const depsFor = (headSha) => ({ ...deps, prInfo: prInfoFor({ headSha }) });

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'local-ci-can-fail-'));
    // Config + passing stand-in committed at the trusted base; F and P descend from it.
    const fixture = makeBaseRepo({
      config: CONFIG_YAML,
      files: {
        'scripts/unit-check.js': UNIT_PASSING,
        [WORKFLOW]: WORKFLOW_YAML,
        '.gitignore': '.ensemble/local-ci-runs/\n',
      },
      headFiles: { 'scripts/unit-check.js': UNIT_FAILING },
    });
    repoRoot = fixture.dir;
    baseRef = fixture.baseRef;
    shaBase = fixture.baseSha;
    shaF = fixture.headSha;
    shaP = commit(repoRoot, 'P: fix the unit check', { 'scripts/unit-check.js': UNIT_PASSING });

    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    gh = fakeGitHub();
    deps = {
      ...defaultDeps(),
      env: { ...process.env, LOCAL_CI_APP_ID: '12345', LOCAL_CI_APP_PRIVATE_KEY: pem },
      fetch: gh.fetch,
      runGate,
      runnerDeps: { resolveNodeBinDir: () => NODE_BIN_DIR },
    };

    failedReport = await runGateFlow(payloadFor(shaF), depsFor(shaF));
    failedPosts = gh.posts.slice();
    passedReport = await runGateFlow(payloadFor(shaP), depsFor(shaP));
  });

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    cleanupBaseRepos();
  });

  test('the fixture is a real repo whose three commits are distinct', () => {
    expect(new Set([shaBase, shaF, shaP]).size).toBe(3);
    expect(git(repoRoot, 'rev-parse', 'HEAD')).toBe(shaP);
    expect(shaF).toMatch(/^[0-9a-f]{40}$/);
  });

  test('failing test blocks: failure naming the step and exact head, only a failure status posted', () => {
    expect(failedReport.ok).toBe(false);
    expect(failedReport.mergeReady).toBe(false);
    expect(failedReport.headSha).toBe(shaF);
    const named = failedReport.failures.filter((f) => f.kind === 'step-failed');
    expect(named).toHaveLength(1);
    expect(named[0].step).toBe('unit-check');
    expect(named[0].sha).toBe(shaF);

    expect(failedPosts).toHaveLength(1);
    expect(failedPosts[0]).toMatchObject({ repo: REPO, sha: shaF, state: 'failure', context: CONTEXT });
    expect(failedPosts.some((p) => p.state === 'success')).toBe(false);
    expect(failedReport.posted).toBe(true);
  });

  test('a failure status never satisfies the merge check for the failing head', () => {
    const verdict = runMerge({ ...mergePayload(shaF), statuses: failedPosts }, depsFor(shaF));
    expect(verdict.ok).toBe(false);
    expect(verdict.mergeReady).toBe(false);
  });

  test('fixed branch passes: same config, success posted on the fixed head', () => {
    expect(passedReport.ok).toBe(true);
    expect(passedReport.mergeReady).toBe(true);
    expect(passedReport.headSha).toBe(shaP);
    expect(passedReport.failures).toEqual([]);
    const successes = gh.posts.filter((p) => p.state === 'success');
    expect(successes).toHaveLength(1);
    expect(successes[0]).toMatchObject({ repo: REPO, sha: shaP, context: CONTEXT });
    // exactly one failure (for F) and one success (for P): nothing else was ever posted
    expect(gh.posts.map((p) => `${p.state}@${p.sha}`)).toEqual([`failure@${shaF}`, `success@${shaP}`]);
  });

  test('runMerge accepts the success record for P and refuses it for F', () => {
    const accepted = runMerge({ ...mergePayload(shaP), statuses: gh.posts }, depsFor(shaP));
    expect(accepted.ok).toBe(true);
    expect(accepted.mergeReady).toBe(true);
    expect(accepted.hostedCiWaitRequired).toBe(false);

    const successOnly = gh.posts.filter((p) => p.state === 'success');
    const refused = runMerge({ ...mergePayload(shaF), statuses: successOnly }, depsFor(shaF));
    expect(refused.ok).toBe(false);
    expect(refused.mergeReady).toBe(false);
  });

  test('without a credential the gate cannot attest success for P (cannot fake a pass)', async () => {
    const before = gh.posts.length;
    const noKey = { ...depsFor(shaP), env: { PATH: process.env.PATH }, loadCredential };
    const r = await runGateFlow(payloadFor(shaP), noKey);
    expect(r.mergeReady).toBe(false);
    expect(gh.posts).toHaveLength(before);
  });

  test('the transport used by the proof is the real postStatus', () => {
    expect(deps.postStatus).toBe(postStatus);
  });
});

describe('PROOF.md (TRD-006 proof note)', () => {
  const text = fs.readFileSync(PROOF, 'utf8');

  test('lists both outcomes and the date', () => {
    expect(text).toMatch(/\b20\d{2}-\d{2}-\d{2}\b/);
    expect(text).toMatch(/^#{2,3} .*Outcome.*fail/im);
    expect(text).toMatch(/^#{2,3} .*Outcome.*pass/im);
    expect(text).toMatch(/\bfailure\b/);
    expect(text).toMatch(/\bsuccess\b/);
  });

  test('has a Not proven section naming the real run and the real status post', () => {
    const m = /^#{2,3} Not proven\s*$([\s\S]*?)(?=^#{1,3} |\s*$(?![\s\S]))/im.exec(text);
    expect(m).not.toBeNull();
    const body = m[1];
    expect(body).toMatch(/npm ci/);
    expect(body).toMatch(/Node 22/);
    expect(body).toMatch(/Node 24/);
    expect(body).toMatch(/GitHub/);
  });

  test('contains no credential: nothing in it is token- or PEM-shaped', () => {
    expect(redact(text)).toBe(text);
    expect(text).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/);
  });

  test('the redact oracle can fail: it flags a token-shaped string', () => {
    const tainted = `${text}\nghp_${'a'.repeat(36)}\n`;
    expect(redact(tainted)).not.toBe(tainted);
  });
});
