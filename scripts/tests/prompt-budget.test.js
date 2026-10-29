'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CEILINGS, countWords, collectSizes, checkBudgets, buildBaseline } = require('../lib/prompt-budget');

const words = (n) => Array(n).fill('w').join(' ');
const cmd = (words_) => ({ kind: 'command', words: words_ });

describe('checkBudgets', () => {
  test('under-ceiling file passes', () => {
    const r = checkBudgets({ 'packages/a/commands/x.yaml': cmd(CEILINGS.command) }, {});
    expect(r).toEqual({ failures: [], advisories: [] });
  });

  test('new over-ceiling file fails naming file, size, limit', () => {
    const r = checkBudgets({ 'packages/a/commands/x.yaml': cmd(CEILINGS.command + 1) }, {});
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toContain('packages/a/commands/x.yaml');
    expect(r.failures[0]).toContain(String(CEILINGS.command + 1));
    expect(r.failures[0]).toContain(String(CEILINGS.command));
  });

  test('ceilings differ per kind', () => {
    const sizes = {
      'packages/a/agents/x.yaml': { kind: 'agent', words: CEILINGS.agent + 1 },
      'packages/a/skills/s/SKILL.md': { kind: 'skill', words: CEILINGS.skill + 1 },
    };
    expect(checkBudgets(sizes, {}).failures).toHaveLength(2);
  });

  test('baselined file growing fails', () => {
    const f = 'packages/a/commands/x.yaml';
    const r = checkBudgets({ [f]: cmd(3001) }, { [f]: 3000 });
    expect(r.failures[0]).toContain('3001');
    expect(r.failures[0]).toContain('3000');
  });

  test('baselined file at baseline passes silently', () => {
    const f = 'packages/a/commands/x.yaml';
    expect(checkBudgets({ [f]: cmd(3000) }, { [f]: 3000 })).toEqual({ failures: [], advisories: [] });
  });

  test('baselined file shrinking passes with advisory', () => {
    const f = 'packages/a/commands/x.yaml';
    const r = checkBudgets({ [f]: cmd(2900) }, { [f]: 3000 });
    expect(r.failures).toEqual([]);
    expect(r.advisories[0]).toContain(f);
    expect(r.advisories[0]).toContain('--update-prompt-baseline');
  });
});

describe('buildBaseline', () => {
  test('records only over-ceiling files at current size', () => {
    const sizes = {
      'packages/a/commands/big.yaml': cmd(4000),
      'packages/a/commands/small.yaml': cmd(10),
    };
    expect(buildBaseline(sizes)).toEqual({ 'packages/a/commands/big.yaml': 4000 });
  });
});

describe('collectSizes', () => {
  let root, pkgs;
  const put = (rel, content) => {
    const full = path.join(pkgs, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-'));
    pkgs = path.join(root, 'packages');
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  test('counts source files and classifies them', () => {
    put('dev/commands/c.yaml', words(5));
    put('dev/agents/a.yaml', words(6));
    put('dev/skills/s/SKILL.md', words(7));
    put('dev/commands/c.md', words(99));
    expect(collectSizes(pkgs)).toEqual({
      'packages/dev/commands/c.yaml': { kind: 'command', words: 5 },
      'packages/dev/agents/a.yaml': { kind: 'agent', words: 6 },
      'packages/dev/skills/s/SKILL.md': { kind: 'skill', words: 7 },
    });
  });

  test('reference directories and node_modules are excluded', () => {
    for (const p of ['pi', 'codex', 'opencode']) {
      put(`${p}/commands/c.yaml`, words(9000));
      put(`${p}/skills/s/SKILL.md`, words(9000));
    }
    put('dev/node_modules/x/SKILL.md', words(9000));
    put('dev/commands/ok.yaml', words(3));
    expect(Object.keys(collectSizes(pkgs))).toEqual(['packages/dev/commands/ok.yaml']);
  });

  test('symlinked mirrors are not double counted', () => {
    put('dev/skills/s/SKILL.md', words(4));
    fs.mkdirSync(path.join(pkgs, 'full'));
    fs.symlinkSync(path.join(pkgs, 'dev', 'skills'), path.join(pkgs, 'full', 'skills'));
    expect(Object.keys(collectSizes(pkgs))).toEqual(['packages/dev/skills/s/SKILL.md']);
  });
});

test('countWords matches wc -w semantics', () => {
  expect(countWords('a  b\n\tc ')).toBe(3);
  expect(countWords('')).toBe(0);
});
