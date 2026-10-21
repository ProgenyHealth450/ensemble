'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { validateConfig } = require('../lib/local-ci-config');
const {
  runGate,
  cloneAtSha,
  sweepStaleClones,
  findUnmirroredSteps,
  requiredNodeVersions,
  RUNS_DIR,
} = require('../lib/local-ci-runner');

const CONFIG = `
workflows:
  - file: .github/workflows/validate.yml
    jobs:
      - id: validate
  - file: .github/workflows/test.yml
    jobs:
      - id: test
        matrix:
          node-version: [22, 24]
status_context: ensemble/local-ci
app_id: 123
`;

const VALIDATE_YML = `
name: Validate
jobs:
  validate:
    steps:
      - uses: actions/checkout@v6
      - name: Setup Node.js
        uses: actions/setup-node@v6
        with: { node-version: '24' }
      - name: Install dependencies
        run: npm ci --legacy-peer-deps
      - name: Validate
        run: npm run validate
`;
const TEST_YML = `
name: Test
jobs:
  test:
    steps:
      - uses: actions/checkout@v6
      - name: Run tests
        run: npm test
`;
const CI_STEPS = [
  { name: 'install', cmd: 'npm ci --legacy-peer-deps' },
  { name: 'validate', cmd: 'npm run validate' },
  { name: 'test', cmd: 'npm test' },
];
const CI_SUMMARY_OK = 'STEP      RESULT   SECONDS\ninstall   PASS     1.0\nvalidate  PASS     1.0\ntest      PASS     1.0\n\nAll steps passed';

function sh(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
function git(cwd, ...args) {
  return sh('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], cwd);
}
function commitAll(cwd, msg) {
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', msg);
  return git(cwd, 'rev-parse', 'HEAD');
}

let tmp;
let repo;
let shaA; // older commit (checked out)
let shaB; // "PR head" (not checked out)
const approvalSet = validateConfig(CONFIG).approvalSet;

function write(rel, text) {
  const p = path.join(repo, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lci-runner-'));
  repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  write('.gitignore', '.ensemble/local-ci-runs/\n.ensemble/local-ci.secrets.env\n');
  write('.github/workflows/validate.yml', VALIDATE_YML);
  write('.github/workflows/test.yml', TEST_YML);
  write('scripts/ci-local.js', '// placeholder entry point\n');
  write('marker.txt', 'A');
  shaA = commitAll(repo, 'A');
  write('marker.txt', 'B');
  shaB = commitAll(repo, 'B');
  git(repo, 'checkout', '-q', '--detach', shaA); // maintainer is on A, PR head is B
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Fake process runner: `node --version` reports the Node on PATH; ci command and extras are scripted. */
function fakeDeps({ onCi, onCmd, nodeBin } = {}) {
  const calls = [];
  return {
    calls,
    resolveNodeBinDir(major) {
      if (nodeBin) return nodeBin(major);
      return `/fake/node${major}/bin`;
    },
    run(cmd, { cwd, env }) {
      calls.push({ cmd, cwd, env });
      if (cmd === 'node --version') {
        const m = /\/fake\/node(\d+)\/bin/.exec(env.PATH);
        return { status: 0, stdout: m ? `v${m[1]}.0.0\n` : 'v26.0.0\n', stderr: '' };
      }
      if (cmd === 'node scripts/ci-local.js') return onCi ? onCi({ cwd, env }) : { status: 0, stdout: CI_SUMMARY_OK, stderr: '' };
      return onCmd ? onCmd(cmd, { cwd, env }) : { status: 0, stdout: '', stderr: '' };
    },
  };
}

function gate(extra, deps) {
  return runGate({ repoRoot: repo, headSha: shaB, approvalSet, ciSteps: CI_STEPS, ...extra }, deps);
}

describe('local-ci-runner: isolated clone of the PR head', () => {
  test('runs the pushed commit, not the checked-out HEAD', () => {
    const seen = [];
    const deps = fakeDeps({
      onCi: ({ cwd }) => {
        seen.push({
          head: git(cwd, 'rev-parse', 'HEAD'),
          marker: fs.readFileSync(path.join(cwd, 'marker.txt'), 'utf8'),
          cwd,
        });
        return { status: 0, stdout: CI_SUMMARY_OK, stderr: '' };
      },
    });
    const r = gate({}, deps);
    expect(r.ok).toBe(true);
    expect(seen.length).toBe(2);
    for (const s of seen) {
      expect(s.head).toBe(shaB);
      expect(s.marker).toBe('B');
      expect(s.cwd).toBe(path.join(repo, RUNS_DIR, shaB));
    }
    // the maintainer's checkout is untouched
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(shaA);
    expect(fs.readFileSync(path.join(repo, 'marker.txt'), 'utf8')).toBe('A');
  });

  test('dirty working tree has no effect on the result', () => {
    write('marker.txt', 'DIRTY');
    write('scripts/ci-local.js', '// edited, uncommitted\n');
    write('untracked-new-file.txt', 'x');
    const contents = [];
    const deps = fakeDeps({
      onCi: ({ cwd }) => {
        contents.push({
          marker: fs.readFileSync(path.join(cwd, 'marker.txt'), 'utf8'),
          ci: fs.readFileSync(path.join(cwd, 'scripts/ci-local.js'), 'utf8'),
          untracked: fs.existsSync(path.join(cwd, 'untracked-new-file.txt')),
        });
        return { status: 0, stdout: CI_SUMMARY_OK, stderr: '' };
      },
    });
    const r = gate({}, deps);
    expect(r.ok).toBe(true);
    expect(contents.length).toBe(2);
    for (const c of contents) {
      expect(c.marker).toBe('B');
      expect(c.ci).toBe('// placeholder entry point\n');
      expect(c.untracked).toBe(false);
    }
    expect(fs.readFileSync(path.join(repo, 'marker.txt'), 'utf8')).toBe('DIRTY');
  });

  test('a commit that is in the repo but not reachable from any ref is still cloned exactly', () => {
    // dangling commit: created on a temp branch, then the branch is deleted
    git(repo, 'checkout', '-q', '-b', 'tmp-branch');
    write('marker.txt', 'DANGLING');
    const dangling = commitAll(repo, 'dangling');
    git(repo, 'checkout', '-q', '--detach', shaA);
    git(repo, 'branch', '-q', '-D', 'tmp-branch');
    const c = cloneAtSha({ repoRoot: repo, sha: dangling, deps: { git: (a, o) => { const r = spawnSync('git', a, { cwd: o && o.cwd, encoding: 'utf8' }); return { status: r.status, stdout: r.stdout, stderr: r.stderr }; } } });
    expect(c.ok).toBe(true);
    expect(git(c.dir, 'rev-parse', 'HEAD')).toBe(dangling);
    expect(fs.readFileSync(path.join(c.dir, 'marker.txt'), 'utf8')).toBe('DANGLING');
  });

  test('clone is removed after a normal run', () => {
    gate({}, fakeDeps());
    expect(fs.existsSync(path.join(repo, RUNS_DIR, shaB))).toBe(false);
  });

  test('unfetchable head: error naming the SHA, nothing run, no clone left', () => {
    const missing = 'deadbeef'.repeat(5);
    const deps = fakeDeps();
    const r = runGate({ repoRoot: repo, headSha: missing, approvalSet, ciSteps: CI_STEPS }, deps);
    expect(r.ok).toBe(false);
    expect(r.error).toContain(missing);
    expect(r.failures[0].kind).toBe('unfetchable-head');
    expect(r.failures[0].sha).toBe(missing);
    expect(deps.calls).toHaveLength(0);
    expect(fs.existsSync(path.join(repo, RUNS_DIR, missing))).toBe(false);
  });

  test('a head that is not a full commit sha is refused', () => {
    const r = runGate({ repoRoot: repo, headSha: 'HEAD', approvalSet, ciSteps: CI_STEPS }, fakeDeps());
    expect(r.ok).toBe(false);
    expect(r.failures[0].kind).toBe('unfetchable-head');
  });

  test('missing ci entry point in the PR head is a named prerequisite failure', () => {
    git(repo, 'checkout', '-q', '--detach', shaB);
    fs.rmSync(path.join(repo, 'scripts/ci-local.js'));
    const noCi = commitAll(repo, 'remove ci-local');
    const r = runGate({ repoRoot: repo, headSha: noCi, approvalSet, ciSteps: CI_STEPS }, fakeDeps());
    expect(r.ok).toBe(false);
    expect(r.failures[0].kind).toBe('prerequisite');
    expect(r.error).toContain('scripts/ci-local.js');
  });
});

describe('local-ci-runner: Node matrix', () => {
  test('each required version runs explicitly, not the machine default', () => {
    const deps = fakeDeps();
    const r = gate({}, deps);
    expect(r.ok).toBe(true);
    const ciRuns = deps.calls.filter((c) => c.cmd === 'node scripts/ci-local.js');
    expect(ciRuns.map((c) => c.env.PATH.split(path.delimiter)[0])).toEqual(['/fake/node22/bin', '/fake/node24/bin']);
    expect(r.nodes.map((n) => n.node)).toEqual([22, 24]);
    expect(requiredNodeVersions(approvalSet)).toEqual([22, 24]);
  });

  test('a required version that cannot be provided fails the gate (never a skip)', () => {
    const deps = fakeDeps({
      nodeBin: (major) => {
        if (major === 24) throw new Error('offline');
        return `/fake/node${major}/bin`;
      },
    });
    const r = gate({}, deps);
    expect(r.ok).toBe(false);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toMatchObject({ kind: 'node-version', node: 24, sha: shaB });
    expect(r.failures[0].message).toContain('Node 24');
    expect(deps.calls.filter((c) => c.cmd === 'node scripts/ci-local.js')).toHaveLength(1);
  });

  test('a resolved bin dir that is not actually the required major fails (machine default is not accepted)', () => {
    const deps = fakeDeps({ nodeBin: () => '/machine/default/node26' });
    const r = gate({}, deps);
    expect(r.ok).toBe(false);
    expect(r.failures.every((f) => f.kind === 'node-version')).toBe(true);
    expect(deps.calls.filter((c) => c.cmd === 'node scripts/ci-local.js')).toHaveLength(0);
  });

  test('no configured Node version is a failure, not a run on the default', () => {
    const noMatrix = validateConfig(`
workflows:
  - file: .github/workflows/validate.yml
    jobs:
      - id: validate
status_context: ensemble/local-ci
app_id: 1
`).approvalSet;
    const deps = fakeDeps();
    const r = runGate({ repoRoot: repo, headSha: shaB, approvalSet: noMatrix, ciSteps: CI_STEPS }, deps);
    expect(r.ok).toBe(false);
    expect(r.failures[0].kind).toBe('node-version');
    expect(deps.calls).toHaveLength(0);
  });
});

describe('local-ci-runner: workflow step mirroring', () => {
  const WF_WITH_EXTRA = `
name: Validate
jobs:
  validate:
    steps:
      - uses: actions/checkout@v6
      - name: Install dependencies
        run: npm ci --legacy-peer-deps
      - name: Validate
        run: npm run validate
      - name: Reject Windows-invalid filenames
        run: |
          if git ls-files | grep ':'; then exit 1; fi
      - name: Upload coverage
        uses: codecov/codecov-action@v7
`;

  function headWithExtraSteps() {
    git(repo, 'checkout', '-q', '--detach', shaB);
    write('.github/workflows/validate.yml', WF_WITH_EXTRA);
    const sha = commitAll(repo, 'extra workflow steps');
    git(repo, 'checkout', '-q', '--detach', shaA);
    return sha;
  }

  test('unmirrored required steps fail the gate and are named; nothing is run', () => {
    const sha = headWithExtraSteps();
    const deps = fakeDeps();
    const r = runGate({ repoRoot: repo, headSha: sha, approvalSet, ciSteps: CI_STEPS }, deps);
    expect(r.ok).toBe(false);
    expect(r.unmirrored.map((u) => u.step)).toEqual(['Reject Windows-invalid filenames', 'Upload coverage']);
    expect(r.failures.map((f) => f.step)).toEqual(['Reject Windows-invalid filenames', 'Upload coverage']);
    expect(deps.calls).toHaveLength(0);
  });

  test('an equivalent configured command mirrors the step and is run on every Node version', () => {
    const sha = headWithExtraSteps();
    const deps = fakeDeps();
    const r = runGate(
      {
        repoRoot: repo,
        headSha: sha,
        approvalSet,
        ciSteps: CI_STEPS,
        extraSteps: [{ name: 'windows-filenames', cmd: "! git ls-files | grep ':'" }],
        equivalents: [
          { workflowStep: 'Reject Windows-invalid filenames', runs: 'windows-filenames' },
          { workflowStep: 'Upload coverage', runs: 'windows-filenames' },
        ],
      },
      deps
    );
    expect(r.ok).toBe(true);
    expect(deps.calls.filter((c) => c.cmd === "! git ls-files | grep ':'")).toHaveLength(2);
  });

  test('an equivalent that names a step not in the list does not mirror', () => {
    const u = findUnmirroredSteps({
      workflows: [{ file: 'w.yml', doc: { jobs: { j: { steps: [{ name: 'Lint', run: 'npm run lint' }] } } } }],
      approvalSet: { workflows: [{ file: 'w.yml', jobs: [{ id: 'j' }] }] },
      runnable: CI_STEPS,
      equivalents: [{ workflowStep: 'Lint', runs: 'does-not-exist' }],
    });
    expect(u).toHaveLength(1);
    expect(u[0].step).toBe('Lint');
  });

  test('a required job missing from the workflow fails closed', () => {
    const u = findUnmirroredSteps({
      workflows: [{ file: 'w.yml', doc: { jobs: {} } }],
      approvalSet: { workflows: [{ file: 'w.yml', jobs: [{ id: 'gone' }] }] },
      runnable: CI_STEPS,
    });
    expect(u).toHaveLength(1);
    expect(u[0].job).toBe('gone');
  });

  test('a fully mirrored workflow set reports nothing unmirrored', () => {
    const r = gate({}, fakeDeps());
    expect(r.unmirrored).toEqual([]);
    expect(r.ok).toBe(true);
  });
});

describe("local-ci-runner: this repository's real approval set", () => {
  const yaml = require('js-yaml');
  const { STEPS } = require('../../../scripts/ci-local.js');
  const ROOT = path.resolve(__dirname, '../../..');
  const real = () => {
    const cfg = validateConfig(fs.readFileSync(path.join(ROOT, '.ensemble/local-ci.yaml'), 'utf8'));
    expect(cfg.problems).toEqual([]);
    const a = cfg.approvalSet;
    const workflows = [...new Set(a.workflows.map((w) => w.file))].map((f) => ({
      file: f,
      doc: yaml.load(fs.readFileSync(path.join(ROOT, f), 'utf8')),
    }));
    return { a, workflows };
  };
  const unmirrored = (o = {}) => {
    const { a, workflows } = real();
    return findUnmirroredSteps({
      workflows,
      approvalSet: a,
      runnable: [...STEPS, ...(o.extraSteps || a.extraSteps)],
      equivalents: o.equivalents || a.equivalents,
      excludedSteps: o.excludedSteps || a.excludedSteps,
    }).map((u) => u.step);
  };

  test('every required step of validate.yml and test.yml is mirrored, run, or recorded as excluded', () => {
    expect(unmirrored()).toEqual([]);
  });

  test('a step whose command drifted from the workflow becomes unmirrored', () => {
    const { a } = real();
    const drifted = a.extraSteps.map((s) => (s.name === 'check-package-json-consistency' ? { ...s, cmd: s.cmd + '\n# edited' } : s));
    expect(unmirrored({ extraSteps: drifted })).toEqual(['Check package.json consistency']);
  });

  test('dropping the generated-markdown equivalent makes that step unmirrored', () => {
    expect(unmirrored({ equivalents: [] })).toEqual(['Check generated markdown is up to date']);
  });

  test('dropping the recorded exclusion makes the coverage upload unmirrored', () => {
    expect(unmirrored({ excludedSteps: [] })).toEqual(['Upload coverage']);
  });

  test('an exclusion recorded for a different job does not hide the step', () => {
    const { a } = real();
    const wrongJob = [{ ...a.excludedSteps[0], job: 'validate' }];
    expect(unmirrored({ excludedSteps: wrongJob })).toEqual(['Upload coverage']);
  });
});

describe('local-ci-runner: failing steps', () => {
  test('non-zero step is a failure naming the step and the head SHA', () => {
    const deps = fakeDeps({
      onCi: () => ({
        status: 1,
        stdout: 'STEP      RESULT   SECONDS\ninstall   PASS     1.0\nvalidate  FAIL     2.0\ntest      PASS     1.0\n\n1 step(s) FAILED',
        stderr: '',
      }),
    });
    const r = gate({}, deps);
    expect(r.ok).toBe(false);
    const f = r.failures.find((x) => x.node === 22);
    expect(f).toMatchObject({ kind: 'step-failed', step: 'validate', sha: shaB });
    expect(f.message).toContain('validate');
    expect(f.message).toContain(shaB);
  });

  test('non-zero exit with an unparseable summary is still a failure', () => {
    const deps = fakeDeps({ onCi: () => ({ status: 2, stdout: 'boom', stderr: '' }) });
    const r = gate({}, deps);
    expect(r.ok).toBe(false);
    expect(r.failures[0].kind).toBe('step-failed');
    expect(r.failures[0].sha).toBe(shaB);
  });

  test('failing on one Node version fails the gate even if the other passes', () => {
    let n = 0;
    const deps = fakeDeps({
      onCi: () => (++n === 2 ? { status: 1, stdout: 'test  FAIL  1.0\n', stderr: '' } : { status: 0, stdout: CI_SUMMARY_OK, stderr: '' }),
    });
    const r = gate({}, deps);
    expect(r.ok).toBe(false);
    expect(r.nodes.map((x) => x.ok)).toEqual([true, false]);
  });

  test('a failing extra step is named with the SHA', () => {
    const deps = fakeDeps({ onCmd: () => ({ status: 3, stdout: '', stderr: 'nope' }) });
    const r = gate({ extraSteps: [{ name: 'pkg-consistency', cmd: 'check-pkg' }] }, deps);
    expect(r.ok).toBe(false);
    expect(r.failures[0]).toMatchObject({ kind: 'step-failed', step: 'pkg-consistency', sha: shaB });
  });

  test('an exception from the process runner is a failure and still removes the clone', () => {
    const deps = fakeDeps();
    deps.run = () => {
      throw new Error('process runner exploded');
    };
    const r = gate({}, deps);
    expect(r.ok).toBe(false);
    expect(r.failures[0].kind).toBe('runner-error');
    expect(fs.existsSync(path.join(repo, RUNS_DIR, shaB))).toBe(false);
  });
});

describe('local-ci-runner: crash safety', () => {
  const OLD = new Date('2020-01-01T00:00:00Z');

  function seed() {
    const runs = path.join(repo, RUNS_DIR);
    fs.mkdirSync(runs, { recursive: true });
    const staleSha = 'a'.repeat(40);
    const freshSha = 'b'.repeat(40);
    for (const name of [staleSha, freshSha, 'my-notes']) {
      fs.mkdirSync(path.join(runs, name));
      fs.writeFileSync(path.join(runs, name, 'file.txt'), 'x');
    }
    fs.writeFileSync(path.join(runs, 'c'.repeat(40)), 'a plain file named like a sha');
    fs.utimesSync(path.join(runs, staleSha), OLD, OLD);
    fs.utimesSync(path.join(runs, 'my-notes'), OLD, OLD);
    fs.utimesSync(path.join(runs, 'c'.repeat(40)), OLD, OLD);
    const foreign = path.join(repo, '.ensemble', 'maintainer-dir');
    fs.mkdirSync(foreign, { recursive: true });
    fs.writeFileSync(path.join(foreign, 'keep.txt'), 'keep');
    fs.utimesSync(foreign, OLD, OLD);
    const outside = path.join(tmp, 'outside-dir');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep');
    fs.utimesSync(outside, OLD, OLD);
    return { runs, staleSha, freshSha, foreign, outside };
  }

  test('a crash leaves a clone; the next run removes only stale sha-named clones', () => {
    // simulate a crash: the clone is created and the process dies before cleanup
    const real = {
      git: (a, o) => {
        const r = spawnSync('git', a, { cwd: o && o.cwd, encoding: 'utf8' });
        return { status: r.status, stdout: r.stdout, stderr: r.stderr };
      },
    };
    const crashed = cloneAtSha({ repoRoot: repo, sha: shaB, deps: real });
    expect(crashed.ok).toBe(true);
    fs.utimesSync(crashed.dir, OLD, OLD);
    const s = seed();

    const r = gate({}, fakeDeps());
    expect(r.ok).toBe(true);
    expect(r.staleRemoved.sort()).toEqual([shaB, s.staleSha].sort());
    expect(fs.existsSync(path.join(s.runs, s.staleSha))).toBe(false);
    // everything else untouched
    expect(fs.existsSync(path.join(s.runs, s.freshSha, 'file.txt'))).toBe(true);
    expect(fs.existsSync(path.join(s.runs, 'my-notes', 'file.txt'))).toBe(true);
    expect(fs.readFileSync(path.join(s.runs, 'c'.repeat(40)), 'utf8')).toBe('a plain file named like a sha');
  });

  test('foreign directories outside the prefix are left alone', () => {
    const s = seed();
    gate({}, fakeDeps());
    expect(fs.readFileSync(path.join(s.foreign, 'keep.txt'), 'utf8')).toBe('keep');
    expect(fs.readFileSync(path.join(s.outside, 'keep.txt'), 'utf8')).toBe('keep');
  });

  test('sweepStaleClones respects the threshold and a missing prefix directory', () => {
    expect(sweepStaleClones({ repoRoot: repo })).toEqual([]);
    const s = seed();
    const now = OLD.getTime() + 10 * 60 * 1000;
    expect(sweepStaleClones({ repoRoot: repo, maxAgeMs: 60 * 60 * 1000, now })).toEqual([]);
    expect(fs.existsSync(path.join(s.runs, s.staleSha))).toBe(true);
  });

  test('a fresh clone directory for the same sha is not clobbered', () => {
    const dir = path.join(repo, RUNS_DIR, shaB);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'other-run.txt'), 'in progress');
    const r = gate({}, fakeDeps());
    expect(r.ok).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'other-run.txt'), 'utf8')).toBe('in progress');
  });
});

describe('local-ci-runner: secrets', () => {
  const SECRET = 's3cr3t-VALUE-9f2c';

  test('secrets from the gitignored file reach steps but never appear in the result', () => {
    write('.ensemble/local-ci.secrets.env', `# local\nAPP_KEY="${SECRET}"\n`);
    let seenInEnv;
    const deps = fakeDeps({
      onCi: ({ env }) => {
        seenInEnv = env.APP_KEY;
        return { status: 1, stdout: `validate  FAIL  1.0\nleaked ${SECRET} in output`, stderr: `err ${SECRET}` };
      },
      onCmd: () => ({ status: 1, stdout: SECRET, stderr: SECRET }),
    });
    const r = gate({ secretNames: ['APP_KEY'], extraSteps: [{ name: 'x', cmd: 'run-x' }] }, deps);
    expect(seenInEnv).toBe(SECRET);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(JSON.stringify(r)).toContain('[REDACTED]');
  });

  test('secrets from the environment are redacted too', () => {
    const deps = fakeDeps({ onCi: () => ({ status: 1, stdout: `validate FAIL 1.0\n${SECRET}`, stderr: '' }) });
    const r = gate({ secretNames: ['TOKEN_X'], env: { PATH: '/usr/bin', TOKEN_X: SECRET } }, deps);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  test('a secrets file that is tracked by git is refused', () => {
    write('.ensemble/local-ci.secrets.env', `APP_KEY=${SECRET}\n`);
    git(repo, 'add', '-f', '.ensemble/local-ci.secrets.env');
    git(repo, 'commit', '-q', '-m', 'oops tracked secret');
    const deps = fakeDeps();
    const r = gate({ secretNames: ['APP_KEY'] }, deps);
    expect(r.ok).toBe(false);
    expect(r.failures[0].kind).toBe('secrets');
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(deps.calls).toHaveLength(0);
  });

  test('a secrets file that is not gitignored is refused', () => {
    write('other-secrets.env', `APP_KEY=${SECRET}\n`);
    const r = gate({ secretNames: ['APP_KEY'], secretsFile: 'other-secrets.env' }, fakeDeps());
    expect(r.ok).toBe(false);
    expect(r.failures[0].kind).toBe('secrets');
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });
});
