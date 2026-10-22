'use strict';

/**
 * Real temp git repo for the local CI gate tests. The trusted config
 * (.ensemble/local-ci.yaml) is committed at a BASE commit, exposed as the REMOTE-TRACKING ref
 * `origin/trusted-base` (refs/remotes/origin/trusted-base, which only a fetch populates, exactly
 * what the gate requires of a baseRef; a local branch of that name would be refused);
 * the PR head is a descendant commit and is left CHECKED OUT, which is exactly the
 * situation that used to let a PR grade itself. Optional `headFiles` are committed
 * on the head only (path -> text, null deletes).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const BASE_BRANCH = 'trusted-base';
const BASE_REF = `origin/${BASE_BRANCH}`;
const CONFIG_PATH = '.ensemble/local-ci.yaml';
const roots = [];

function makeBaseRepo({ config, files = {}, headFiles = {}, baseRef = BASE_REF } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-ci-base-'));
  roots.push(dir);
  const git = (...args) => String(execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, stdio: 'pipe' })).trim();
  const put = (rel, text) => {
    const abs = path.join(dir, rel);
    if (text === null) return fs.rmSync(abs, { force: true });
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  };
  git('init', '-q', '-b', 'main');
  if (config !== null && config !== undefined) put(CONFIG_PATH, config);
  put('README.md', 'x\n');
  for (const [rel, text] of Object.entries(files)) put(rel, text);
  git('add', '-A');
  git('commit', '-qm', 'base');
  const baseSha = git('rev-parse', 'HEAD');
  // A remote-tracking ref, as a fetch of the PR's base branch would leave it (no remote needed for the ref to exist).
  git('update-ref', `refs/remotes/${baseRef}`, baseSha);
  put('head.txt', 'pr head\n');
  for (const [rel, text] of Object.entries(headFiles)) put(rel, text);
  git('add', '-A');
  git('commit', '-qm', 'head');
  const headSha = git('rev-parse', 'HEAD');
  return { dir, baseSha, headSha, sha: headSha, baseRef, git };
}

function cleanupBaseRepos() {
  for (const d of roots.splice(0)) fs.rmSync(d, { recursive: true, force: true });
}

/** The PR number and repository the tests pretend to be gating. */
const PR = 7;
const REPO = 'o/r';

/**
 * A `prInfo` dependency standing in for `gh pr view`: GitHub's answer for the PR under test. The default is the honest
 * one (the PR targets `trusted-base` and its head is the repo's head commit); a test states an attack by overriding a
 * field, e.g. { baseRefName: 'main' } or { headRefOid: '<other sha>' }. `calls` records every lookup.
 */
function prInfoFor(fx, answer = {}) {
  const calls = [];
  const prInfo = (args) => {
    calls.push(args);
    if (answer.error) return { ok: false, error: answer.error };
    return { ok: true, info: { baseRefName: BASE_BRANCH, headRefOid: fx.headSha, state: 'OPEN', ...answer } };
  };
  prInfo.calls = calls;
  return prInfo;
}

/**
 * A real `gh` executable in a temp dir, for tests that spawn the CLI as a process. It answers `gh pr view` with the
 * given JSON and exits non-zero for anything else. Returns the directory to put first on PATH.
 */
function fakeGhDir(info) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'local-ci-fakegh-'));
  roots.push(d);
  const script = `#!/bin/sh\nif [ "$1" = "pr" ] && [ "$2" = "view" ]; then printf '%s' '${JSON.stringify(info)}'; exit 0; fi\necho "unexpected gh call: $*" >&2\nexit 2\n`;
  fs.writeFileSync(path.join(d, 'gh'), script, { mode: 0o755 });
  return d;
}

module.exports = { makeBaseRepo, cleanupBaseRepos, prInfoFor, fakeGhDir, PR, REPO, BASE_REF, BASE_BRANCH, CONFIG_PATH };
