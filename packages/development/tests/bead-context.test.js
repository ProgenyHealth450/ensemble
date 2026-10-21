'use strict';

/**
 * Behavioural tests for `trd-cli bead-context`. Each test runs the real CLI in a throw-away
 * (non-git) directory, so repo-root resolution falls back to the cwd and the repo's own docs
 * are never touched. Beads come from the real `scaffold-plan` output.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.join(__dirname, '..', 'lib', 'trd-cli.js');

const PRD = `# Demo PRD

#### REQ-001: Thing works
The thing must work.

- AC-001-1: Given a thing, when run, then it works.
- AC-001-2: Given bad input, when run, then it errors.

#### REQ-002: Other thing
Other.

- AC-002-1: Given x, when y, then z.
`;

const trdText = (extra = '') => `---
prd_reference: docs/PRD/demo.md
---
# Demo TRD

Summary.

Based on PRD: docs/PRD/demo.md

## Master Task List

### PR 1: First

**Shippable State:** Works.

- [ ] **TRD-001** Build the thing (1h) \`[satisfies REQ-001]\`
  - Validates PRD ACs: AC-001-1, AC-001-2
  - Target File: src/thing.js
  - Actions:
    1. Build it
  - Implementation AC:
    - Given input, when run, then output is correct.
- [ ] **TRD-002** Wire CI (1h) \`[satisfies INFRA]\`
  - Target File: ci.yml
${extra}
- [ ] **TRD-001-TEST** Test the thing (1h) \`[verifies TRD-001] [satisfies REQ-001] [depends: TRD-001]\`
  - Validates PRD ACs: AC-001-1
  - Test AC:
    - Given a thing, when tested, then green.
`;

let dir;
function run(args, cwd = dir) {
  const r = spawnSync('node', [CLI, ...args], { cwd, encoding: 'utf8' });
  return { code: r.status, json: JSON.parse(r.stdout) };
}
function write(rel, text) {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
}
function plan() {
  return run(['scaffold-plan', 'docs/TRD/demo.md']).json.plan;
}
function ctx(bead, extra = []) {
  const file = path.join(dir, 'issue.json');
  fs.writeFileSync(file, JSON.stringify([{ id: 'b-1', title: bead.title, description: bead.description }]));
  return run(['bead-context', '--bead', 'b-1', '--issue-json', file, ...extra]);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bead-context-'));
  write('docs/TRD/demo.md', trdText());
  write('docs/PRD/demo.md', PRD);
  spawnSync('git', ['init', '-q'], { cwd: dir }); // repo root = dir
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('scaffold-plan reference paths', () => {
  test('TRD and PRD paths are repo-relative even when invoked with an absolute TRD path', () => {
    const p = run(['scaffold-plan', path.join(dir, 'docs/TRD/demo.md')]).json.plan;
    const t = p.tasks.find((x) => x.id === 'TRD-001');
    expect(t.description).toContain('TRD: docs/TRD/demo.md\n');
    expect(t.description).toContain('PRD Requirement: docs/PRD/demo.md#req-001');
    expect(p.warnings).toEqual([]);
  });

  test('a PRD named relative to the TRD directory resolves to its repo-relative path', () => {
    write('docs/TRD/demo.md', trdText().replace(/docs\/PRD\/demo\.md/g, '../PRD/demo.md'));
    const t = plan().tasks.find((x) => x.id === 'TRD-001');
    expect(t.description).toContain('PRD: docs/PRD/demo.md\n');
  });

  test('a missing PRD file yields (UNRESOLVED) and a plan warning', () => {
    fs.rmSync(path.join(dir, 'docs/PRD/demo.md'));
    const p = plan();
    expect(p.tasks[0].description).toContain('PRD: docs/PRD/demo.md (UNRESOLVED)');
    expect(p.warnings.join('\n')).toMatch(/could not be resolved/);
  });
});

describe('bead-context', () => {
  test('ok for every freshly planned bead kind, exit 0, source=description', () => {
    const p = plan();
    const beads = [p.epic, ...p.stories, ...p.tasks, ...p.synthesizedTests];
    expect(beads.length).toBeGreaterThanOrEqual(5);
    for (const b of beads) {
      const { code, json } = ctx(b);
      expect({ title: b.title, ok: json.ok, missing: json.missing, code }).toEqual({
        title: b.title, ok: true, missing: [], code: 0,
      });
      expect(json.source).toBe('description');
    }
  });

  test('task context carries the live TRD task and the PRD requirement with its ACs', () => {
    const t = plan().tasks.find((x) => x.id === 'TRD-001');
    const { json } = ctx(t);
    expect(json.kind).toBe('task');
    expect(json.references).toEqual({
      trd: 'docs/TRD/demo.md',
      trdTask: 'docs/TRD/demo.md#trd-001',
      prd: 'docs/PRD/demo.md',
      prdRequirements: ['REQ-001'],
      prdAcs: ['AC-001-1', 'AC-001-2'],
    });
    expect(json.context.trdTask).toMatchObject({ id: 'TRD-001', targetFiles: ['src/thing.js'], actions: ['Build it'] });
    expect(json.context.prdRequirements).toHaveLength(1);
    expect(json.context.prdRequirements[0]).toMatchObject({ id: 'REQ-001', title: 'Thing works' });
    expect(json.context.prdRequirements[0].acs.map((a) => a.id)).toEqual(['AC-001-1', 'AC-001-2']);
    expect(json.context.prdRequirements[0].acs[0]).toMatchObject({ given: expect.any(String), then: expect.any(String) });
  });

  test('kinds: test task, synth and epic are classified', () => {
    const p = plan();
    expect(ctx(p.tasks.find((x) => x.id === 'TRD-001-TEST')).json.kind).toBe('test');
    expect(ctx(p.epic).json.kind).toBe('epic');
    expect(ctx(p.stories[0]).json.kind).toBe('story');
  });

  test('INFRA task is ok with no requirements', () => {
    const { json } = ctx(plan().tasks.find((x) => x.id === 'TRD-002'));
    expect(json.ok).toBe(true);
    expect(json.references.prdRequirements).toEqual([]);
    expect(json.context.prdRequirements).toEqual([]);
  });

  test('re-reads the TRD live: a refinement after scaffolding is visible', () => {
    const t = plan().tasks.find((x) => x.id === 'TRD-001');
    write('docs/TRD/demo.md', trdText().replace('1. Build it', '1. Build it differently'));
    expect(ctx(t).json.context.trdTask.actions).toEqual(['Build it differently']);
  });

  test('deleted PRD file -> ok:false, exit 1, specific missing text', () => {
    const t = plan().tasks.find((x) => x.id === 'TRD-001');
    fs.rmSync(path.join(dir, 'docs/PRD/demo.md'));
    const { code, json } = ctx(t);
    expect(code).toBe(1);
    expect(json.ok).toBe(false);
    expect(json.missing.join(' | ')).toMatch(/PRD file docs\/PRD\/demo\.md cannot be read/);
  });

  test('deleted TRD file -> ok:false naming the TRD', () => {
    const t = plan().tasks.find((x) => x.id === 'TRD-001');
    fs.rmSync(path.join(dir, 'docs/TRD/demo.md'));
    const { code, json } = ctx(t);
    expect(code).toBe(1);
    expect(json.missing.join(' | ')).toMatch(/TRD file docs\/TRD\/demo\.md cannot be read/);
  });

  test('task anchor removed from the TRD -> ok:false', () => {
    const t = plan().tasks.find((x) => x.id === 'TRD-002');
    write('docs/TRD/demo.md', trdText().replace('- [ ] **TRD-002** Wire CI (1h) `[satisfies INFRA]`\n  - Target File: ci.yml\n', ''));
    const { code, json } = ctx(t);
    expect(code).toBe(1);
    expect(json.missing).toEqual(['TRD task trd-002 not found in docs/TRD/demo.md']);
  });

  test('requirement removed from the PRD -> ok:false naming the REQ', () => {
    const t = plan().tasks.find((x) => x.id === 'TRD-001');
    write('docs/PRD/demo.md', PRD.replace('#### REQ-001: Thing works', '#### Gone'));
    const { code, json } = ctx(t);
    expect(code).toBe(1);
    expect(json.missing).toEqual(['PRD requirement REQ-001 not found in docs/PRD/demo.md']);
  });

  test('(UNRESOLVED) PRD in the block -> ok:false', () => {
    fs.rmSync(path.join(dir, 'docs/PRD/demo.md'));
    const t = plan().tasks.find((x) => x.id === 'TRD-001');
    const { code, json } = ctx(t);
    expect(code).toBe(1);
    expect(json.missing.join(' | ')).toMatch(/UNRESOLVED/);
  });

  test('every problem is listed, not just the first', () => {
    const t = plan().tasks.find((x) => x.id === 'TRD-001');
    write('docs/TRD/demo.md', trdText().replace('**TRD-001** Build', '**TRD-009** Build'));
    write('docs/PRD/demo.md', '# empty\n');
    const { json } = ctx(t);
    expect(json.missing.length).toBeGreaterThanOrEqual(2);
  });

  test('legacy bead without a block and without --trd -> ok:false', () => {
    const { code, json } = ctx({ title: '[trd:demo:task:TRD-001] Build', description: '## Task: TRD-001\nTRD Reference: docs/TRD/demo.md#trd-001' });
    expect(code).toBe(1);
    expect(json.ok).toBe(false);
    expect(json.source).toBe('fallback');
    expect(json.missing.join(' | ')).toMatch(/no --trd/);
  });

  test('legacy bead falls back to the title prefix + --trd and still resolves PRD context', () => {
    const { code, json } = ctx(
      { title: '[trd:demo:task:TRD-001] Build', description: '## Task: TRD-001\nTRD Reference: docs/TRD/demo.md#trd-001' },
      ['--trd', 'docs/TRD/demo.md'],
    );
    expect(code).toBe(0);
    expect(json).toMatchObject({ ok: true, source: 'fallback', kind: 'task' });
    expect(json.references.trdTask).toBe('docs/TRD/demo.md#trd-001');
    expect(json.references.prdRequirements).toEqual(['REQ-001']);
    expect(json.context.prdRequirements[0].id).toBe('REQ-001');
  });

  test('legacy epic bead falls back with just the TRD', () => {
    const { json } = ctx({ title: '[trd:demo] Implement TRD: Demo', description: 'Summary.' }, ['--trd', 'docs/TRD/demo.md']);
    expect(json).toMatchObject({ ok: true, source: 'fallback', kind: 'epic' });
  });

  test('bead without refs and without a recognisable title -> ok:false', () => {
    const { code, json } = ctx({ title: 'Random bead', description: 'nothing' }, ['--trd', 'docs/TRD/demo.md']);
    expect(code).toBe(1);
    expect(json.missing.join(' | ')).toMatch(/no \[trd:<slug>/);
  });

  test('unknown bead (empty issue json) -> ok:false, exit 1', () => {
    const file = path.join(dir, 'empty.json');
    fs.writeFileSync(file, '[]');
    const { code, json } = run(['bead-context', '--bead', 'nope', '--issue-json', file]);
    expect(code).toBe(1);
    expect(json.ok).toBe(false);
    expect(json.missing[0]).toMatch(/bead nope not found/);
  });

  test('missing --bead is a normal CLI error envelope', () => {
    const { code, json } = run(['bead-context']);
    expect(code).toBe(1);
    expect(json.error).toMatch(/--bead/);
  });
});

describe('review regressions', () => {
  const legacy = { title: '[trd:demo:task:TRD-001] Build', description: 'old bead' };

  test.each([
    ['repo-root-relative --trd given from a subdirectory', 'docs/TRD/demo.md'],
    ['cwd-relative --trd given from a subdirectory', 'TRD/demo.md'],
  ])('legacy fallback: %s', (_n, trdFlag) => {
    const file = path.join(dir, 'issue.json');
    fs.writeFileSync(file, JSON.stringify([{ id: 'b-1', ...legacy }]));
    const { code, json } = run(['bead-context', '--bead', 'b-1', '--issue-json', file, '--trd', trdFlag], path.join(dir, 'docs'));
    expect({ code, ok: json.ok, missing: json.missing }).toEqual({ code: 0, ok: true, missing: [] });
    expect(json.references.trd).toBe('docs/TRD/demo.md');
  });

  test('ids containing letters survive the lower-cased anchor round trip', () => {
    write('docs/TRD/demo.md', trdText().replace(/TRD-001/g, 'TRD-A-001'));
    const t = plan().tasks.find((x) => x.id === 'TRD-A-001');
    expect(t).toBeTruthy();
    expect(t.description).toContain('TRD Task: docs/TRD/demo.md#trd-a-001');
    const { json } = ctx(t);
    expect(json.ok).toBe(true);
    expect(json.context.trdTask.id).toBe('TRD-A-001');
    expect(json.references.prdRequirements).toEqual(['REQ-001']);
  });

  test('multi-REQ bead: each requirement carries its own ACs even when the bead lists ACs of only one', () => {
    write('docs/TRD/demo.md', trdText().replace('`[satisfies REQ-001]`\n  - Validates PRD ACs: AC-001-1, AC-001-2', '`[satisfies REQ-001] [satisfies REQ-002]`\n  - Validates PRD ACs: AC-001-1'));
    const t = plan().tasks.find((x) => x.id === 'TRD-001');
    expect(t.description).toContain('PRD Requirement: docs/PRD/demo.md#req-002');
    const { json } = ctx(t);
    expect(json.ok).toBe(true);
    const byId = Object.fromEntries(json.context.prdRequirements.map((r) => [r.id, r.acs.map((a) => a.id)]));
    expect(byId).toEqual({ 'REQ-001': ['AC-001-1'], 'REQ-002': ['AC-002-1'] });
  });

  test('workstream-plan writes repo-relative, resolved reference paths', () => {
    const ready = (t) => t.replace('prd_reference:', 'design_readiness_score: 4.5\nstatus: Draft\nprd_reference:');
    write('docs/TRD/demo.md', ready(trdText()));
    write('docs/TRD/other.md', ready(trdText().replace('# Demo TRD', '# Other TRD')));
    const r = run(['workstream-plan', path.join(dir, 'docs/TRD/demo.md'), path.join(dir, 'docs/TRD/other.md')], path.join(dir, 'docs'));
    expect(r.json.ok).not.toBe(false);
    const sp = r.json.scaffoldPlans;
    const task = sp[0].plan.tasks.find((x) => x.id === 'TRD-001');
    expect(task.description).toContain('TRD: docs/TRD/demo.md\n');
    expect(task.description).toContain('PRD: docs/PRD/demo.md\n');
    expect(task.externalRef).toBe('docs/TRD/demo.md#trd-001');
  });
});
