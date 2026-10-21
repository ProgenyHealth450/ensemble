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
      { path: 'docs/my file.md', oldPath: 'docs/my file.md', added: 3, deleted: 1, binary: false },
    ]);
  });

  it('marks binary lines and counts them as zero lines', () => {
    expect(parseNumstat('-\t-\tlogo.png\n')).toEqual([{ path: 'logo.png', oldPath: 'logo.png', added: 0, deleted: 0, binary: true }]);
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
  const exists = (p) => fs.existsSync(path.join(root, p));

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
    expect(isGenerated(p, exists)).toBe(true);
  });

  it.each(['scripts/pr-size.js', 'packages/dev/src/index.js', 'docs/guide.md', 'packages/piano/x.js'])(
    'treats %s as hand-written',
    (p) => {
      expect(isGenerated(p, exists)).toBe(false);
    }
  );

  it('treats command/agent .md as generated only when the sibling .yaml exists', () => {
    expect(isGenerated('packages/dev/commands/ensemble/with-src.md', exists)).toBe(true);
    expect(isGenerated('packages/dev/commands/ensemble/hand.md', exists)).toBe(false);
    expect(isGenerated('packages/dev/agents/bot.md', exists)).toBe(true);
    expect(isGenerated('packages/dev/agents/hand.md', exists)).toBe(false);
  });
});

describe('summarize', () => {
  const file = (n) => [{ path: 'src/a.js', added: n, deleted: 0, binary: false }];

  it('is not over exactly at the threshold and over by one', () => {
    expect(summarize(file(400), 400).over).toBe(false);
    expect(summarize(file(401), 400).over).toBe(true);
  });

  it('excludes generated lines and reports top hand-written files', () => {
    const s = summarize(
      [
        { path: 'packages/pi/x.md', added: 1000, deleted: 0, binary: false },
        { path: 'a.js', added: 5, deleted: 5, binary: false },
        { path: 'b.js', added: 1, deleted: 0, binary: false },
        { path: 'img.png', added: 0, deleted: 0, binary: true },
      ],
      400
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

describe('rename classification', () => {
  const nums = (n, tag) => Array.from({ length: n }, (_, i) => `${tag}${i}\n`).join('');
  const edit = (text, k) => text.split('\n').map((l, i) => (i < k ? `${l}-edited` : l)).join('\n');
  const exists = (set) => (side, p) => set[side].has(p);

  it('counts a hand-written file renamed into a generated path as hand-written', () => {
    const [f] = parseNumstat('10\t10\tlib/util.js => packages/pi/util.md\n');
    expect(f).toMatchObject({ path: 'packages/pi/util.md', oldPath: 'lib/util.js' });
    const s = summarize([f], 400);
    expect(s.handWritten).toBe(20);
    expect(s.generated).toBe(0);
  });

  it('counts a generated file renamed to a hand-written path as hand-written', () => {
    const s = summarize(parseNumstat('3\t3\tpackages/pi/a.md => docs/a.md\n'), 400);
    expect(s.handWritten).toBe(6);
    expect(s.generated).toBe(0);
  });

  it('resolves the sibling yaml per side', () => {
    const files = parseNumstat('5\t5\tpackages/dev/agents/{a.md => b.md}\n');
    const both = exists({ old: new Set(['packages/dev/agents/a.yaml']), new: new Set(['packages/dev/agents/b.yaml']) });
    expect(summarize(files, 400, both)).toMatchObject({ handWritten: 0, generated: 10 });
    const yamlLost = exists({ old: new Set(['packages/dev/agents/a.yaml']), new: new Set() });
    expect(summarize(files, 400, yamlLost)).toMatchObject({ handWritten: 10, generated: 0 });
  });

  describe('CLI end-to-end', () => {
    let repo;
    const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
    const write = (p, content) => {
      fs.mkdirSync(path.dirname(path.join(repo, p)), { recursive: true });
      fs.writeFileSync(path.join(repo, p), content);
    };

    beforeAll(() => {
      repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-size-rename-'));
      git('init', '-q', '-b', 'main');
      git('config', 'user.email', 't@example.com');
      git('config', 'user.name', 't');
      git('config', 'commit.gpgsign', 'false');
      const util = nums(300, 'u');
      const agent = nums(200, 'g');
      write('lib/util.js', util);
      write('packages/dev/agents/a.yaml', 'name: a\n');
      write('packages/dev/agents/a.md', agent);
      git('add', '.');
      git('commit', '-qm', 'base');
      git('checkout', '-q', '-b', 'feature');
      fs.mkdirSync(path.join(repo, 'packages/pi'), { recursive: true });
      git('mv', 'lib/util.js', 'packages/pi/util.md');
      write('packages/pi/util.md', edit(util, 10));
      git('mv', 'packages/dev/agents/a.yaml', 'packages/dev/agents/b.yaml');
      git('mv', 'packages/dev/agents/a.md', 'packages/dev/agents/b.md');
      write('packages/dev/agents/b.md', edit(agent, 5));
      git('add', '-A');
      git('commit', '-qm', 'feature');
      // Run from the base checkout: classification must come from the refs, not the worktree.
      git('checkout', '-q', 'main');
    });
    afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));

    it('classifies renames by both endpoints and the yaml per ref', () => {
      const r = spawnSync('node', [SCRIPT, '--base', 'main', '--head', 'feature', '--threshold', '400'], { cwd: repo, encoding: 'utf8' });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('Hand-written changed lines: 20');
      expect(r.stdout).toContain('Generated changed lines:    10');
      expect(r.stdout).toContain('packages/pi/util.md');
    });
  });
});
