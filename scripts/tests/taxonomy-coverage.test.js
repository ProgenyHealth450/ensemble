'use strict';
/** Tests for scripts/lib/taxonomy-coverage.js and scripts/check-taxonomy-coverage.js (TRD-048). */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const yaml = require('js-yaml');

const { checkCoverage, extractCommandTokens } = require('../lib/taxonomy-coverage');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CLI = path.join(REPO_ROOT, 'scripts', 'check-taxonomy-coverage.js');
const CATEGORIES = ['host', 'workflow', 'worktree', 'tracker', 'work-graph', 'ci-local', 'review',
  'lint', 'test-runner', 'e2e-quality', 'container-deploy', 'iac', 'platform-cloud', 'package-runner'];

let roots = [];
afterEach(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
  roots = [];
});

function write(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

/** A minimal valid tree: 14 categories, one adapter per category, matching defaults. */
function validRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taxonomy-'));
  roots.push(root);
  const defaults = [];
  for (const cat of CATEGORIES) {
    write(root, `packages/development/toolchain/categories/${cat}.yaml`, `category: ${cat}\n`);
    write(root, `packages/p/skills/adapter-${cat}-a/adapter.yaml`,
      `adapter: ${cat}-a\ncategories: [${cat}]\nbinaries: []\n`);
    defaults.push(`${cat}: ${cat}-a`);
  }
  write(root, 'packages/development/toolchain/toolchain.default.yaml', defaults.join('\n') + '\n');
  const inv = CATEGORIES.map(c => `${c}: []`);
  inv.push('ignoredCommands:', '  - echo');
  write(root, 'packages/development/toolchain/tool-inventory.yaml', inv.join('\n') + '\n');
  return root;
}

describe('checkCoverage on the shipped tree', () => {
  test('has zero errors and every inventoried tool maps to exactly one category', () => {
    const result = checkCoverage(REPO_ROOT);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);

    const inv = yaml.load(fs.readFileSync(
      path.join(REPO_ROOT, 'packages/development/toolchain/tool-inventory.yaml'), 'utf8'));
    const seen = new Map();
    for (const [key, tools] of Object.entries(inv)) {
      for (const tool of tools) seen.set(tool, [...(seen.get(tool) || []), key]);
    }
    for (const [tool, keys] of seen) expect({ tool, keys: keys.length }).toEqual({ tool, keys: 1 });
    for (const cat of CATEGORIES) expect(Object.keys(inv)).toContain(cat);
  });

  test('check-taxonomy-coverage.js exits 0', () => {
    const out = execFileSync(process.execPath, [CLI], { encoding: 'utf8' });
    expect(out).toMatch(/file\(s\) scanned/);
  });
});

describe('checkCoverage failure modes', () => {
  test('a valid minimal tree has no errors', () => {
    expect(checkCoverage(validRoot()).errors).toEqual([]);
  });

  test('UNMAPPED_TOOL names file and tool for a fenced block starting `frobnicate --go`', () => {
    const root = validRoot();
    write(root, 'packages/x/commands/y.yaml', 'mission: |\n  ```bash\n  frobnicate --go\n  echo done\n  ```\n');
    const { errors } = checkCoverage(root);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ class: 'UNMAPPED_TOOL', tool: 'frobnicate', line: 3 });
    expect(errors[0].file.endsWith(path.join('x', 'commands', 'y.yaml'))).toBe(true);
  });

  test('CLI exits 1 naming file and tool when run on a tree with an unmapped tool', () => {
    const root = validRoot();
    write(root, 'packages/x/skills/s/SKILL.md', '```bash\nfrobnicate --go\n```\n');
    let out = '';
    let status = 0;
    try {
      execFileSync(process.execPath, ['-e', `require(${JSON.stringify(path.join(REPO_ROOT, 'scripts/check-taxonomy-coverage.js'))}).main(${JSON.stringify(root)})`], { encoding: 'utf8' });
    } catch (err) {
      status = err.status;
      out = err.stdout;
    }
    expect(status).toBe(1);
    expect(out).toContain('frobnicate');
    expect(out).toContain('SKILL.md');
  });

  test('tools in ignoredCommands, a mapped tool, adapter dirs and prose fences are not errors', () => {
    const root = validRoot();
    write(root, 'packages/development/toolchain/tool-inventory.yaml',
      CATEGORIES.map(c => (c === 'iac' ? 'iac:\n  - terraform' : `${c}: []`)).join('\n') + '\nignoredCommands:\n  - echo\n  - cat\n  - "true"\n');
    write(root, 'packages/x/commands/y.yaml',
      'mission: |\n  ```bash\n  VAR=1 terraform plan\n  if true; then echo hi; fi\n  cat <<EOF\n  frobnicate\n  EOF\n  ```\n  ```text\n  frobnicate\n  ```\n');
    write(root, 'packages/x/skills/adapter-iac-a/SKILL.md', '```bash\nfrobnicate\n```\n');
    expect(checkCoverage(root).errors.filter(e => e.class === 'UNMAPPED_TOOL')).toEqual([]);
  });

  test('a tool under two categories errors naming the tool and both categories', () => {
    const root = validRoot();
    write(root, 'packages/development/toolchain/tool-inventory.yaml',
      CATEGORIES.map(c => (c === 'container-deploy' || c === 'iac' ? `${c}:\n  - docker` : `${c}: []`)).join('\n') + '\nignoredCommands: []\n');
    const err = checkCoverage(root).errors.find(e => e.class === 'DUPLICATE_TOOL_MAPPING');
    expect(err.tool).toBe('docker');
    expect(err.categories.sort()).toEqual(['container-deploy', 'iac']);
  });

  test('a tool both mapped and ignored errors', () => {
    const root = validRoot();
    write(root, 'packages/development/toolchain/tool-inventory.yaml',
      CATEGORIES.map(c => (c === 'iac' ? 'iac:\n  - cat' : `${c}: []`)).join('\n') + '\nignoredCommands:\n  - cat\n');
    expect(checkCoverage(root).errors.map(e => e.class)).toContain('DUPLICATE_TOOL_MAPPING');
  });

  test('an adapter binary that is in neither inventory nor ignoredCommands errors', () => {
    const root = validRoot();
    write(root, 'packages/p/skills/adapter-iac-a/adapter.yaml',
      'adapter: iac-a\ncategories: [iac]\nbinaries: [mystery]\n');
    const err = checkCoverage(root).errors.find(e => e.tool === 'mystery');
    expect(err.class).toBe('UNMAPPED_TOOL');
    expect(err.file.endsWith('adapter.yaml')).toBe(true);
  });

  test('removing the lint default errors naming the category', () => {
    const root = validRoot();
    const file = 'packages/development/toolchain/toolchain.default.yaml';
    write(root, file, fs.readFileSync(path.join(root, file), 'utf8').replace('lint: lint-a\n', ''));
    const errors = checkCoverage(root).errors;
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ class: 'MISSING_DEFAULT_ADAPTER', category: 'lint' });
  });

  test('a default naming a nonexistent adapter directory errors naming the category', () => {
    const root = validRoot();
    const file = 'packages/development/toolchain/toolchain.default.yaml';
    write(root, file, fs.readFileSync(path.join(root, file), 'utf8').replace('iac: iac-a', 'iac: nonexistent'));
    const errors = checkCoverage(root).errors;
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ class: 'MISSING_DEFAULT_ADAPTER', category: 'iac' });
  });

  test('a category with no default and an inventory key that is no category both error', () => {
    const root = validRoot();
    write(root, 'packages/development/toolchain/categories/extra.yaml', 'category: extra\n');
    write(root, 'packages/development/toolchain/tool-inventory.yaml', 'bogus:\n  - x\nignoredCommands: []\n');
    const classes = checkCoverage(root).errors.map(e => `${e.class}:${e.category}`);
    expect(classes).toContain('MISSING_DEFAULT_ADAPTER:extra');
    expect(classes).toContain('UNKNOWN_INVENTORY_CATEGORY:bogus');
  });
});

describe('extractCommandTokens', () => {
  test('skips comments, assignments, keywords, heredocs, continuations and non-shell fences', () => {
    const text = [
      '```bash', '# comment', 'FOO=1 tool-a --x', 'for f in a; do', '  tool-b "$f" \\', '    tool-c', 'done',
      'x | tool-d && tool-e', 'cat <<EOF', 'not-a-tool', 'EOF', '```', '```json', 'tool-z', '```', ''
    ].join('\n');
    expect(extractCommandTokens(text).map(t => t.tool)).toEqual(['tool-a', 'tool-b', 'x', 'tool-d', 'tool-e', 'cat']);
  });
});
