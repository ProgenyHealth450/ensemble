'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { parseNumstat, isGenerated, summarize } = require('../pr-size');

const SCRIPT = path.join(__dirname, '..', 'pr-size.js');

describe('parseNumstat', () => {
  it('parses counts and paths with spaces', () => {
    expect(parseNumstat('3\t1\tdocs/my file.md\n')).toEqual([
      { path: 'docs/my file.md', added: 3, deleted: 1, binary: false },
    ]);
  });

  it('marks binary lines and counts them as zero lines', () => {
    expect(parseNumstat('-\t-\tlogo.png\n')).toEqual([{ path: 'logo.png', added: 0, deleted: 0, binary: true }]);
  });

  it('resolves both rename forms to the new path', () => {
    const files = parseNumstat('0\t0\told.js => new.js\n2\t2\tsrc/{a => b}/x.js\n1\t0\tsrc/{ => sub}/y.js\n');
    expect(files.map((f) => f.path)).toEqual(['new.js', 'src/b/x.js', 'src/sub/y.js']);
  });
});

describe('isGenerated', () => {
  let root;
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-size-gen-'));
    const w = (p) => {
      fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
      fs.writeFileSync(path.join(root, p), 'x');
    };
    w('packages/dev/commands/with-src.yaml');
    w('packages/dev/commands/ensemble/with-src.md');
    w('packages/dev/commands/ensemble/hand.md');
    w('packages/dev/agents/bot.yaml');
    w('packages/dev/agents/bot.md');
    w('packages/dev/agents/hand.md');
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it.each([
    'packages/pi/commands/x.md',
    'packages/codex/src/y.ts',
    'packages/opencode/z.json',
    'packages/lifecycle-claude/bundle/lifecycle.cjs',
    'package-lock.json',
    'sub/yarn.lock',
    '.beads/issues.jsonl',
    'public/app.min.js',
  ])('treats %s as generated', (p) => {
    expect(isGenerated(p, root)).toBe(true);
  });

  it.each(['scripts/pr-size.js', 'packages/dev/src/index.js', 'docs/guide.md', 'packages/piano/x.js'])(
    'treats %s as hand-written',
    (p) => {
      expect(isGenerated(p, root)).toBe(false);
    }
  );

  it('treats command/agent .md as generated only when the sibling .yaml exists', () => {
    expect(isGenerated('packages/dev/commands/ensemble/with-src.md', root)).toBe(true);
    expect(isGenerated('packages/dev/commands/ensemble/hand.md', root)).toBe(false);
    expect(isGenerated('packages/dev/agents/bot.md', root)).toBe(true);
    expect(isGenerated('packages/dev/agents/hand.md', root)).toBe(false);
  });
});

describe('summarize', () => {
  const file = (n) => [{ path: 'src/a.js', added: n, deleted: 0, binary: false }];

  it('is not over exactly at the threshold and over by one', () => {
    expect(summarize(file(400), 400, os.tmpdir()).over).toBe(false);
    expect(summarize(file(401), 400, os.tmpdir()).over).toBe(true);
  });

  it('excludes generated lines and reports top hand-written files', () => {
    const s = summarize(
      [
        { path: 'packages/pi/x.md', added: 1000, deleted: 0, binary: false },
        { path: 'a.js', added: 5, deleted: 5, binary: false },
        { path: 'b.js', added: 1, deleted: 0, binary: false },
        { path: 'img.png', added: 0, deleted: 0, binary: true },
      ],
      400,
      os.tmpdir()
    );
    expect(s.handWritten).toBe(11);
    expect(s.generated).toBe(1000);
    expect(s.binaryFiles).toBe(1);
    expect(s.top.map((t) => t.path)).toEqual(['a.js', 'b.js']);
  });
});

describe('CLI end-to-end', () => {
  let repo;
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  const write = (p, content) => {
    fs.mkdirSync(path.dirname(path.join(repo, p)), { recursive: true });
    fs.writeFileSync(path.join(repo, p), content);
  };
  const run = (...args) => spawnSync('node', [SCRIPT, ...args], { cwd: repo, encoding: 'utf8' });

  beforeAll(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-size-e2e-'));
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 't');
    git('config', 'commit.gpgsign', 'false');
    write('README.md', 'base\n');
    git('add', '.');
    git('commit', '-qm', 'base');
    git('checkout', '-q', '-b', 'feature');
    write('src/hand.js', 'x\n'.repeat(50));
    write('packages/pi/gen.md', 'g\n'.repeat(900));
    fs.writeFileSync(path.join(repo, 'logo.bin'), Buffer.from([0, 1, 2, 0, 255, 0]));
    git('add', '.');
    git('commit', '-qm', 'feature');
  });
  afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));

  it('reports hand-written vs generated and exits 0 under the threshold', () => {
    const r = run('--base', 'main', '--head', 'feature', '--threshold', '400');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Hand-written changed lines: 50');
    expect(r.stdout).toContain('Generated changed lines:    900');
    expect(r.stdout).toContain('src/hand.js');
    expect(r.stdout).not.toContain('::warning');
  });

  it('warns but still exits 0 when over the threshold', () => {
    const summary = path.join(repo, 'summary.md');
    const r = spawnSync('node', [SCRIPT, '--base', 'main', '--head', 'feature', '--threshold', '10'], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, GITHUB_STEP_SUMMARY: summary },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('::warning');
    expect(fs.readFileSync(summary, 'utf8')).toContain('PR size (advisory)');
  });

  it('exits 1 under --strict when over, 0 when not over', () => {
    expect(run('--base', 'main', '--head', 'feature', '--threshold', '10', '--strict').status).toBe(1);
    expect(run('--base', 'main', '--head', 'feature', '--threshold', '50', '--strict').status).toBe(0);
  });

  it('does not fail on a bad ref without --strict', () => {
    expect(run('--base', 'no-such-ref').status).toBe(0);
  });
});
