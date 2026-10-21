/**
 * One beads execution engine: implement-trd-beads (TRD orchestrator) -> beads-build
 * (wave loop) -> beads-build-wave command (one wave, loaded by the thin beads-build-wave agent). implement-bead is a thin
 * single-bead entry that follows the same branching / PR_BACKEND / commit policy.
 *
 * These checks read the source YAML and assert policy that has to hold across all of
 * them, so a contradiction between the entry points fails here.
 */
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const ENGINE_FILES = [
  'commands/implement-trd-beads.yaml',
  'commands/beads-build.yaml',
  'commands/implement-bead.yaml',
  'commands/beads-build-wave.yaml',
  'agents/beads-build-wave.yaml',
];

describe('beads engine sources', () => {
  test.each(ENGINE_FILES)('%s parses as YAML', (rel) => {
    expect(() => yaml.load(read(rel))).not.toThrow();
  });

  test.each(ENGINE_FILES)('%s only mentions broad staging when forbidding it', (rel) => {
    const text = read(rel);
    const staging = /git add -A|git add \.(?![\w/])|git add \.beads\/?|git commit -a(?!\w)|commit -a(?!\w)/g;
    for (const m of text.matchAll(staging)) {
      const before = text.slice(Math.max(0, m.index - 200), m.index);
      expect(before).toMatch(/never|do not|not stage|forbid/i);
    }
  });

  test.each(ENGINE_FILES)('%s does not treat bv as required', (rel) => {
    const text = read(rel);
    expect(text).not.toMatch(/bv \(beads_viewer\) is required/);
    expect(text).not.toMatch(/bv is required/i);
    expect(text).not.toMatch(/no graceful-degradation/);
    expect(text).not.toMatch(/no br ready fallback/);
    expect(text).not.toMatch(/never a fallback dispatcher/);
  });

  test('the wave command and beads-build both define the br-only scheduling fallback', () => {
    expect(read('commands/beads-build-wave.yaml')).toMatch(/br-only: `br ready --json`/);
    expect(read('commands/beads-build.yaml')).toMatch(/bv is OPTIONAL/);
    expect(read('commands/implement-trd-beads.yaml')).toMatch(/bv is OPTIONAL/);
  });
});

describe('beads-build --plan mode (replaces beads-plan)', () => {
  const build = yaml.load(read('commands/beads-build.yaml'));
  const plan = build.workflow.phases.find((p) => p.name === 'Plan Mode');

  test('is advertised and parsed', () => {
    expect(build.metadata.argument_hint).toMatch(/\[--plan\]/);
    expect(read('commands/beads-build.yaml')).toMatch(/Parse --plan from \$ARGUMENTS/);
  });

  test('exists as its own phase and is read-only', () => {
    expect(plan).toBeDefined();
    const text = JSON.stringify(plan);
    expect(text).not.toMatch(/br (close|update|create|comment add)|git (commit|add|push)|beads-label|beads-stage/);
    expect(text).toMatch(/br sync --flush-only/);
  });
});

describe('implement-bead shares the engine policy', () => {
  const text = read('commands/implement-bead.yaml');

  test('resolves branching strategy and PR backend through resolve-sdlc', () => {
    expect(text).toMatch(/resolve-sdlc/);
    expect(text).toMatch(/PR_BACKEND==gh/);
    expect(text).toMatch(/PR_BACKEND==ado/);
    expect(text).toMatch(/PR_BACKEND==manual/);
  });

  test('never creates a branch with a hard-coded git town fallback', () => {
    expect(text).not.toMatch(/git town hack[^.]*fallback/i);
    expect(text).toMatch(/BRANCHING_STRATEGY==git-town/);
    expect(text).toMatch(/plain-git/);
  });

  test('its dirty-tree gate ignores br state under .beads/', () => {
    expect(text).toMatch(/git status --porcelain -- \. '':\(exclude\)\.beads''/);
  });
});

describe('removed duplicates stay removed', () => {
  const GONE = [
    'commands/beads-plan.yaml',
    'skills/complete-beads/SKILL.md',
    'lib/complete-beads-cli.js',
    'lib/complete-beads-planner.js',
  ];
  test.each(GONE)('%s does not exist', (rel) => {
    expect(fs.existsSync(path.join(ROOT, rel))).toBe(false);
  });

  test('the single wave definition is the hidden wave command', () => {
    expect(fs.existsSync(path.join(ROOT, 'commands/beads-build-wave.yaml'))).toBe(true);
    expect(read('commands/beads-build-wave.yaml')).toMatch(/visibility: hidden/);
  });

  test('no command or agent source still names a removed component', () => {
    const dirs = ['commands', 'agents', 'skills'].map((d) => path.join(ROOT, d));
    const hits = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name !== 'ensemble') walk(p);
        } else if (/\.yaml$/.test(e.name) || e.name === 'SKILL.md') {
          if (/complete-beads|ensemble:beads-plan/.test(fs.readFileSync(p, 'utf8'))) hits.push(p);
        }
      }
    };
    dirs.forEach(walk);
    expect(hits).toEqual([]);
  });
});
