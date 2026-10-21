'use strict';

/**
 * Adversarial coverage of the local CI gate: the PR head is hostile. Real runner,
 * real git clone, real `bash -c` of the maintainer's trusted commands in temp
 * repos; only Node provisioning is injected (the running Node), and the GitHub
 * network is faked. No `npm ci`, no download, no real credential.
 *
 * Invariant under test: PASS/FAIL comes ONLY from exit statuses of the trusted
 * commands the runner executed itself. Nothing in the head (scripts/ci-local.js,
 * a printed PASS table, its workflows, its own .ensemble/local-ci.yaml) can
 * supply a command, replace a verdict, or be loaded/executed by the runner.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const yaml = require('js-yaml');

const { runGate } = require('../lib/local-ci-runner');
const { validateConfig } = require('../lib/local-ci-config');
const cli = require('../lib/local-ci-cli');

const MAJOR = Number(process.versions.node.split('.')[0]);
const BIN_DIR = path.dirname(process.execPath);
const WORKFLOW = '.github/workflows/ci.yml';
const LINT = { name: 'lint', cmd: 'npm run lint' };
const TEST = { name: 'test', cmd: 'npm run test' };

const tmpRoots = [];
afterAll(() => tmpRoots.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@x.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function approvalFor(steps, equivalents) {
  const cfg = validateConfig({
    workflows: [{ file: WORKFLOW, jobs: [{ id: 'ci', matrix: { 'node-version': [MAJOR] } }] }],
    steps,
    ...(equivalents ? { equivalents } : {}),
    status_context: 'x/local-ci',
    app_id: 1,
  });
  if (!cfg.ok) throw new Error(cfg.problems.join('; '));
  return cfg.approvalSet;
}

const workflowText = (cmds) => yaml.dump({ name: 'ci', on: ['push'], jobs: { ci: { 'runs-on': 'ubuntu-latest', steps: [{ uses: 'actions/checkout@v4' }, ...cmds.map((run) => ({ run }))] } } });

/**
 * A repo with one commit (the hostile "PR head"). `scripts` are the head's package.json
 * scripts, `files` extra head files, `workflowCmds` what the head's own workflow runs.
 * Returns { dir, sha, tmp } (tmp is a scratch dir outside the repo for markers/logs).
 */
function makeHead({ scripts = {}, files = {}, workflowCmds = [LINT.cmd, TEST.cmd], extraCommitFiles = {}, baseConfig = null } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lci-adv-'));
  tmpRoots.push(tmp);
  const dir = path.join(tmp, 'repo');
  fs.mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  // BASE commit (branch `trusted-base`): holds the maintainer config when `baseConfig` is given.
  fs.writeFileSync(path.join(dir, 'README.md'), 'base\n');
  if (baseConfig !== null) {
    fs.mkdirSync(path.join(dir, '.ensemble'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.ensemble', 'local-ci.yaml'), baseConfig);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  git(dir, 'branch', 'trusted-base');
  const all = {
    '.gitignore': '.ensemble/local-ci-runs/\n.ensemble/local-ci.secrets.env\n',
    'package.json': JSON.stringify({ name: 'head', version: '1.0.0', scripts: { lint: 'exit 0', test: 'exit 0', ...scripts } }),
    [WORKFLOW]: workflowText(workflowCmds),
    ...files,
    ...extraCommitFiles,
  };
  for (const [rel, text] of Object.entries(all)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'head');
  return { dir, sha: git(dir, 'rev-parse', 'HEAD'), tmp };
}

const deps = (extra) => ({ resolveNodeBinDir: () => BIN_DIR, ...extra });
const baseEnv = () => ({ PATH: process.env.PATH, HOME: process.env.HOME || os.tmpdir() });
const gate = (head, approvalSet, opts, injected) => runGate({ repoRoot: head.dir, headSha: head.sha, approvalSet, env: baseEnv(), ...opts }, deps(injected));
/** A head script file that appends `text` to `file` (outside the clone), and the package.json script that runs it. */
const loggerFile = (file) => `require('fs').appendFileSync(${JSON.stringify(file)}, process.argv[2] + '\\n');\n`;
const logging = (file) => ({
  files: { 'scripts/log.js': loggerFile(file) },
  scripts: { lint: 'node scripts/log.js lint', test: 'node scripts/log.js test' },
});

// A head ci-local.js that prints PASS rows and exits 0 without running anything,
// and records (outside the clone) that it was ever imported or executed.
const lyingCiLocal = (marker) => `'use strict';
require('fs').appendFileSync(${JSON.stringify(marker)}, 'loaded\\n');
const STEPS = [{ name: 'lint', cmd: 'npm run lint' }, { name: 'test', cmd: 'npm run test' }];
module.exports = { STEPS };
if (require.main === module) { for (const s of STEPS) console.log(s.name + ' PASS 0.0'); process.exit(0); }
`;

describe('control: an honest head passes through the real runner', () => {
  it('runs every trusted command once per required Node version, in order, and passes', () => {
    const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lci-log-')), 'log');
    tmpRoots.push(path.dirname(log));
    const head = makeHead(logging(log));
    const r = gate(head, approvalFor([LINT, TEST]));
    expect(r).toMatchObject({ ok: true, failures: [], unmirrored: [] });
    expect(r.nodes).toEqual([{ node: MAJOR, ok: true, steps: [{ name: 'lint', status: 'PASS' }, { name: 'test', status: 'PASS' }] }]);
    expect(fs.readFileSync(log, 'utf8')).toBe('lint\ntest\n');
  });
});

describe('a lying head cannot fake its own result', () => {
  it('ci-local.js that prints PASS rows and exits 0 cannot hide failing real commands', () => {
    const marker = path.join(os.tmpdir(), `lci-marker-${process.pid}-lying`);
    fs.rmSync(marker, { force: true });
    const head = makeHead({ scripts: { lint: 'exit 1', test: 'exit 1' }, files: { 'scripts/ci-local.js': lyingCiLocal(marker) } });
    const r = gate(head, approvalFor([LINT, TEST]));
    expect(r.ok).toBe(false);
    expect(r.failures.map((f) => [f.kind, f.step, f.node])).toEqual([['step-failed', 'lint', MAJOR], ['step-failed', 'test', MAJOR]]);
    expect(r.nodes[0].steps).toEqual([{ name: 'lint', status: 'FAIL' }, { name: 'test', status: 'FAIL' }]);
    expect(r.failures[0].message).toContain('exit 1');
    expect(r.failures[0].message).toContain(head.sha);
  });

  it('a head ci-local.js is NEVER loaded or executed by the runner (import-time side effect does not happen)', () => {
    const marker = path.join(os.tmpdir(), `lci-marker-${process.pid}-import`);
    fs.rmSync(marker, { force: true });
    const head = makeHead({ files: { 'scripts/ci-local.js': lyingCiLocal(marker) } });
    const r = gate(head, approvalFor([LINT, TEST]));
    expect(r.ok).toBe(true); // the trusted commands pass, so the run is graded only by them
    expect(fs.existsSync(marker)).toBe(false);
    fs.rmSync(marker, { force: true });
  });

  it('a head whose package.json script fails fails the gate, naming the step, exit status and head SHA', () => {
    const head = makeHead({ scripts: { lint: 'exit 3' } });
    const r = gate(head, approvalFor([LINT, TEST]));
    expect(r.ok).toBe(false);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toMatchObject({ kind: 'step-failed', step: 'lint', node: MAJOR, sha: head.sha });
    expect(r.failures[0].message).toContain('exit 3');
    expect(r.nodes[0].ok).toBe(false);
  });

  it('a head that drops a required step from its OWN workflow changes nothing: the trusted command still runs and fails', () => {
    const head = makeHead({ scripts: { test: 'exit 1' }, workflowCmds: [LINT.cmd] });
    const r = gate(head, approvalFor([LINT, TEST]));
    expect(r.unmirrored).toEqual([]);
    expect(r.ok).toBe(false);
    expect(r.failures.map((f) => f.step)).toEqual(['test']);
  });

  it('a head that ADDS a required workflow step the trusted list does not cover fails closed and runs nothing', () => {
    const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lci-log-')), 'log');
    tmpRoots.push(path.dirname(log));
    const head = makeHead({ ...logging(log), workflowCmds: [LINT.cmd, TEST.cmd, 'npm run deploy-check'] });
    const r = gate(head, approvalFor([LINT, TEST]));
    expect(r.ok).toBe(false);
    expect(r.unmirrored.map((u) => u.step)).toEqual(['npm run deploy-check']);
    expect(fs.existsSync(log)).toBe(false);
  });

  it('a head that rewrites a workflow step command so it no longer matches the trusted text fails closed', () => {
    const head = makeHead({ workflowCmds: [LINT.cmd, 'npm run test -- --bail'] });
    const r = gate(head, approvalFor([LINT, TEST]));
    expect(r.ok).toBe(false);
    expect(r.unmirrored.map((u) => u.step)).toEqual(['npm run test -- --bail']);
  });

  it('a head whose required workflow file is unreadable fails closed', () => {
    const head = makeHead({ files: { [WORKFLOW]: 'jobs: [unterminated' } });
    const r = gate(head, approvalFor([LINT, TEST]));
    expect(r.ok).toBe(false);
    expect(r.unmirrored.length).toBeGreaterThan(0);
  });

  it('a step that moves the clone HEAD (the attestation is bound to the sha) voids the run even though every command exits 0', () => {
    const moveHead = { name: 'move', cmd: 'git -c user.name=x -c user.email=x@x.invalid -c commit.gpgsign=false commit --allow-empty -qm moved' };
    const head = makeHead({ workflowCmds: [LINT.cmd, moveHead.cmd] });
    const r = gate(head, approvalFor([LINT, moveHead]));
    expect(r.nodes.every((n) => n.ok)).toBe(true);
    expect(r.failures.map((f) => f.kind)).toEqual(['clone-moved']);
    expect(r.ok).toBe(false);
  });
});

describe('nothing but the maintainer config sets the Node matrix and the command list', () => {
  it('a nodeVersions option cannot shrink the matrix: every approval-set version is resolved', () => {
    const head = makeHead({});
    const two = validateConfig({
      workflows: [{ file: WORKFLOW, jobs: [{ id: 'ci', matrix: { 'node-version': [MAJOR, MAJOR + 1] } }] }],
      steps: [LINT, TEST],
      status_context: 'x/l',
      app_id: 1,
    }).approvalSet;
    const asked = [];
    const r = runGate(
      { repoRoot: head.dir, headSha: head.sha, approvalSet: two, env: baseEnv(), nodeVersions: [MAJOR], steps: [{ name: 'only', cmd: 'true' }], ciCommand: 'true' },
      {
        resolveNodeBinDir(major) {
          asked.push(major);
          if (major !== MAJOR) throw new Error('not provisionable in this test');
          return BIN_DIR;
        },
      }
    );
    expect(asked).toEqual([MAJOR, MAJOR + 1]);
    expect(r.ok).toBe(false);
    expect(r.failures.map((f) => [f.kind, f.node])).toEqual([['node-version', MAJOR + 1]]);
    expect(r.nodes[0].steps.map((s) => s.name)).toEqual(['lint', 'test']); // the trusted list ran, not the smuggled one
  });

  it("the head's own .ensemble/local-ci.yaml is never consulted: the gate (through the CLI) grades with the maintainer's file", async () => {
    const cfgText = (steps, extra) => yaml.dump({
      workflows: [{ file: WORKFLOW, jobs: [{ id: 'ci', matrix: { 'node-version': [MAJOR] } }] }],
      steps,
      ...extra,
      status_context: 'x/local-ci',
      app_id: 1,
    });
    const weak = cfgText([{ name: 'noop', cmd: 'true' }]);
    const trusted = cfgText([{ name: 'lint', cmd: 'npm run lint' }], { equivalents: [{ workflowStep: 'true', runs: 'lint' }] });
    // Maintainer config committed at BASE; the hostile head commits a weakened one and stays checked out.
    const head = makeHead({ scripts: { lint: 'exit 1' }, workflowCmds: ['true'], baseConfig: trusted, extraCommitFiles: { '.ensemble/local-ci.yaml': weak } });
    expect(fs.readFileSync(path.join(head.dir, '.ensemble', 'local-ci.yaml'), 'utf8')).toBe(weak); // head's file is what is on disk
    const report = await cli.runGateFlow(
      { repoRoot: head.dir, headSha: head.sha, baseRef: 'trusted-base', repo: 'o/r', dryRun: true },
      { ...cli.defaultDeps(), runnerDeps: deps(), env: {}, loadCredential: () => ({ credential: null, reason: 'none' }) }
    );
    expect(report.ok).toBe(false);
    expect(report.failures.map((f) => [f.kind, f.step])).toEqual([['step-failed', 'lint']]);
  });
});

describe('secrets and environment', () => {
  it('a step sees only the allowlisted environment: no inherited credential, no arbitrary variable', () => {
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lci-env-')), 'env.json');
    tmpRoots.push(path.dirname(out));
    const dump = { name: 'envdump', cmd: 'node scripts/envdump.js' };
    const head = makeHead({
      workflowCmds: [dump.cmd],
      files: { 'scripts/envdump.js': `require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.env));\n` },
    });
    const env = { ...baseEnv(), LANG: 'C', TERM: 'dumb', MY_SECRET: 'inherited-secret-value', GITHUB_TOKEN: 'ghp_inheritedtokenvalue', DEPLOY_KEY: 'k'.repeat(10), UNRELATED: 'x', NODE_OPTIONS: '--no-warnings' };
    const r = gate(head, approvalFor([dump]), { env });
    expect(r.ok).toBe(true);
    const seen = JSON.parse(fs.readFileSync(out, 'utf8'));
    const allowed = new Set(['CI', 'HOME', 'LANG', 'NODE_OPTIONS', 'PATH', 'TERM']);
    const addedByBash = new Set(['PWD', 'OLDPWD', 'SHLVL', '_', '__CF_USER_TEXT_ENCODING']);
    expect(Object.keys(seen).filter((k) => !allowed.has(k) && !addedByBash.has(k))).toEqual([]);
    for (const k of allowed) expect(seen).toHaveProperty(k);
    for (const k of ['MY_SECRET', 'GITHUB_TOKEN', 'DEPLOY_KEY', 'UNRELATED']) expect(seen).not.toHaveProperty(k);
    expect(seen.CI).toBe('true');
    expect(seen.PATH.split(path.delimiter)[0]).toBe(BIN_DIR);
  });

  it('a configured secret reaches the step but a step that prints it never leaks it into the result', () => {
    const SECRET = 'configured-secret-value-123';
    const printer = { name: 'printer', cmd: 'node scripts/print.js' };
    const head = makeHead({
      workflowCmds: [printer.cmd],
      files: { 'scripts/print.js': "console.log('seen=' + process.env.APP_SECRET_X); console.error('err=' + process.env.APP_SECRET_X); process.exit(1);\n" },
    });
    const r = gate(head, approvalFor([printer]), { env: { ...baseEnv(), APP_SECRET_X: SECRET }, secretNames: ['APP_SECRET_X'] });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).toContain('seen=[REDACTED]');
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  it('every inherited credential-named value is redacted from everything returned, even when a (fake) step prints it', () => {
    const head = makeHead({});
    const values = ['tok-AAAAAAAA-1', 'sec-BBBBBBBB-2', 'key-CCCCCCCC-3', 'pw-DDDDDDDD-4', 'cred-EEEEEEEE-5', 'auth-FFFFFFFF-6'];
    const env = {
      ...baseEnv(),
      GH_TOKEN: values[0],
      MY_SECRET: values[1],
      API_KEY: values[2],
      DB_PASSWORD: values[3],
      AWS_CREDENTIALS: values[4],
      AUTHORIZATION: values[5],
      HARMLESS: 'visible-value',
    };
    const leak = (cmd) => ({ status: 1, stdout: `${values.join(' ')} visible-value`, stderr: `x ${values[1]}` });
    const r = gate(head, approvalFor([LINT, TEST]), { env }, { run: (cmd, o) => (cmd === 'node --version' ? { status: 0, stdout: process.version, stderr: '' } : leak(cmd, o)) });
    expect(r.ok).toBe(false);
    const text = JSON.stringify(r);
    for (const v of values) expect(text).not.toContain(v);
    expect(text).toContain('[REDACTED]');
    expect(text).toContain('visible-value'); // only credential-named variables are redacted
  });

  it('short credential-named values (< 6 chars) are not redacted, so output is not shredded', () => {
    const head = makeHead({});
    const r = gate(head, approvalFor([LINT, TEST]), { env: { ...baseEnv(), MY_TOKEN: 'ab' } }, {
      run: (cmd) => (cmd === 'node --version' ? { status: 0, stdout: process.version, stderr: '' } : { status: 1, stdout: 'abc cab', stderr: '' }),
    });
    expect(JSON.stringify(r)).toContain('abc cab');
  });

  it('the failure status posted to GitHub and the CLI report never contain an inherited secret', async () => {
    const SECRET = 'inherited-deploy-token-9f2c';
    const head = makeHead({
      baseConfig: yaml.dump({
        workflows: [{ file: WORKFLOW, jobs: [{ id: 'ci', matrix: { 'node-version': [MAJOR] } }] }],
        steps: [LINT, TEST],
        status_context: 'x/local-ci',
        app_id: 1,
      }),
    });
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const posted = [];
    const fetch = async (url, init) => {
      const reply = (o) => ({ status: 200, json: async () => o });
      if (url.endsWith('/installation')) return reply({ id: 7 });
      if (url.endsWith('/access_tokens')) return reply({ token: 'ghs_' + 'x'.repeat(36) });
      if (/\/statuses\//.test(url)) posted.push(JSON.parse(init.body));
      return reply({ id: 1 });
    };
    const previous = process.env.DEPLOY_TOKEN;
    process.env.DEPLOY_TOKEN = SECRET;
    try {
      const report = await cli.runGateFlow(
        { repoRoot: head.dir, headSha: head.sha, baseRef: 'trusted-base', repo: 'o/r' },
        {
          ...cli.defaultDeps(),
          fetch,
          env: {},
          loadCredential: () => ({ credential: { appId: '1', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) } }),
          runnerDeps: deps({ run: (cmd) => (cmd === 'node --version' ? { status: 0, stdout: process.version, stderr: '' } : { status: 1, stdout: `boom ${SECRET}`, stderr: SECRET }) }),
        }
      );
      expect(report.ok).toBe(false);
      expect(posted.map((p) => p.state)).toEqual(['failure']);
      expect(JSON.stringify(report)).not.toContain(SECRET);
      expect(JSON.stringify(posted)).not.toContain(SECRET);
      expect(JSON.stringify(report)).toContain('[REDACTED]');
    } finally {
      if (previous === undefined) delete process.env.DEPLOY_TOKEN;
      else process.env.DEPLOY_TOKEN = previous;
    }
  });
});

describe('a step is graded the way hosted CI grades it: fail fast, not by the last command', () => {
  // GitHub Actions runs a bash step with -e (-o pipefail with shell: bash). Plain bash -c reports only the
  // LAST command's status, which would pass a head whose loop or script fails halfway.
  const step = (cmd) => ({ name: 'multi', cmd });
  const headFor = (cmd) => makeHead({ workflowCmds: [cmd] });

  it('a failure in the middle of a multi-command step fails the step', () => {
    const cmd = 'true\nfalse\ntrue\n';
    const r = gate(headFor(cmd), approvalFor([step(cmd)]));
    expect(r.unmirrored).toEqual([]);
    expect(r.ok).toBe(false);
    expect(r.failures.map((f) => [f.kind, f.step])).toEqual([['step-failed', 'multi']]);
  });

  it('a failing stage of a pipeline fails the step', () => {
    const cmd = 'false | true\n';
    const r = gate(headFor(cmd), approvalFor([step(cmd)]));
    expect(r.ok).toBe(false);
    expect(r.failures.map((f) => f.kind)).toEqual(['step-failed']);
  });

  it('a loop whose body fails once fails the step, as this repository\'s package.json check would on hosted CI', () => {
    const cmd = 'for p in a b c; do if [ "$p" = b ]; then node -e "process.exit(1)"; else true; fi; done\n';
    const r = gate(headFor(cmd), approvalFor([step(cmd)]));
    expect(r.ok).toBe(false);
    expect(r.failures.map((f) => f.kind)).toEqual(['step-failed']);
  });

  it('control: the same shapes pass when nothing fails', () => {
    const cmd = 'true\ntrue | true\nfor p in a b; do true; done\n';
    const r = gate(headFor(cmd), approvalFor([step(cmd)]));
    expect(r).toMatchObject({ ok: true, failures: [], unmirrored: [] });
  });
});

describe('a head file that is a symlink cannot make the runner read outside the clone', () => {
  it('a workflow file that is a symlink to a file outside the repository is refused, not read through', () => {
    const head = makeHead();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'lci-outside-'));
    tmpRoots.push(outside);
    // A perfectly valid workflow that mirrors the trusted steps, placed OUTSIDE the repository.
    fs.writeFileSync(path.join(outside, 'ci.yml'), workflowText([LINT.cmd, TEST.cmd]));
    fs.rmSync(path.join(head.dir, WORKFLOW));
    fs.symlinkSync(path.join(outside, 'ci.yml'), path.join(head.dir, WORKFLOW));
    git(head.dir, 'add', '-A');
    git(head.dir, 'commit', '-q', '-m', 'workflow is a symlink');
    const sha = git(head.dir, 'rev-parse', 'HEAD');
    const r = gate({ dir: head.dir, sha, tmp: head.tmp }, approvalFor([LINT, TEST]));
    expect(r.ok).toBe(false);
    expect(r.failures.some((f) => /symlink|outside/i.test(f.message))).toBe(true);
  });
});
