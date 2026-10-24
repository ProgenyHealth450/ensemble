'use strict';

/**
 * Tests for the toolchain explain/resolve CLI (lib/toolchain-cli.js), covering TRD-004-TEST
 * (TRD-2026-8d825f54 TRD-004, PRD REQ-012 "Explain mode", AC-012-1 and AC-012-2).
 *
 * Per the wave-3 reviewer constraint recorded on this bead: these tests do NOT mock or
 * monkeypatch `resolveCategory`/`loadToolchainConfigFile`. They exercise the real five-tier
 * precedence chain in `lib/toolchain/config.js` end to end against real temp-directory config
 * files and the real shipped `toolchain/toolchain.default.yaml`. The only permitted injection
 * is `ctx.detect`, which `toolchain-cli.js`'s own header doc documents as the sanctioned
 * TRD-016 injection point for exercising the `source:'detection'` path without a real
 * detection engine.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');
const { spawnSync } = require('child_process');

const { resolve, explain, main } = require('../lib/toolchain-cli');
const { DEFAULT_TOOLCHAIN_PATH } = require('../lib/toolchain/config');

const CLI = path.join(__dirname, '..', 'lib', 'toolchain-cli.js');

// Mirrors toolchain-cli.js's own CATEGORIES list (TRD-004); all 14 toolchain categories.
const CATEGORIES = [
  'host',
  'workflow',
  'worktree',
  'tracker',
  'work-graph',
  'ci-local',
  'review',
  'lint',
  'test-runner',
  'e2e-quality',
  'container-deploy',
  'iac',
  'platform-cloud',
  'package-runner',
];

/** Read the real shipped default adapter map (not a hardcoded guess). */
function loadShippedDefaults() {
  return yaml.load(fs.readFileSync(DEFAULT_TOOLCHAIN_PATH, 'utf8'));
}

/**
 * Build a {adapter, source} map for every category assuming every category falls through to
 * the shipped default, then layer the five representative precedence-tier overrides on top:
 *   - worktree  -> project config   ('jj')
 *   - ci-local  -> user config      ('custom-ci')
 *   - host      -> env-compat       ('gitlab', via ENSEMBLE_PR_BACKEND)
 *   - tracker   -> injected detect  ('jira-detected', source: 'detection')
 * Every other category (including workflow, which also has an env-compat slot that is
 * deliberately left unset here) is expected to resolve to the real shipped default.
 */
function buildExpectedData(defaults) {
  const data = {};
  for (const category of CATEGORIES) {
    data[category] = { adapter: defaults[category], source: 'default' };
  }
  data.worktree = { adapter: 'jj', source: 'project' };
  data['ci-local'] = { adapter: 'custom-ci', source: 'user' };
  data.host = { adapter: 'gitlab', source: 'env-compat' };
  data.tracker = { adapter: 'jira-detected', source: 'detection' };
  return data;
}

/**
 * Construct a real temp project directory (with `.ensemble/toolchain.yaml`) and a real temp
 * user config directory (with `$XDG_CONFIG_HOME/ensemble/toolchain.yaml`), plus a ctx wired to
 * exercise all five precedence tiers simultaneously in one `explain`/`resolve` call:
 *   1. project config:  worktree  -> 'jj'
 *   2. user config:     ci-local  -> 'custom-ci'
 *   3. env-compat:      host      -> 'gitlab' (ENSEMBLE_PR_BACKEND)
 *   4. injected detect: tracker   -> 'jira-detected' (source: 'detection')
 *   5. shipped default: every remaining category
 */
function buildFullPrecedenceCtx() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'toolchain-cli-project-'));
  fs.mkdirSync(path.join(projectRoot, '.ensemble'), { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, '.ensemble', 'toolchain.yaml'),
    'worktree: jj\n'
  );

  const xdgConfigHome = fs.mkdtempSync(path.join(os.tmpdir(), 'toolchain-cli-xdg-'));
  fs.mkdirSync(path.join(xdgConfigHome, 'ensemble'), { recursive: true });
  fs.writeFileSync(
    path.join(xdgConfigHome, 'ensemble', 'toolchain.yaml'),
    'ci-local: custom-ci\n'
  );

  const env = {
    XDG_CONFIG_HOME: xdgConfigHome,
    ENSEMBLE_PR_BACKEND: 'gitlab',
  };

  const detect = (category) => {
    if (category === 'tracker') {
      return { value: 'jira-detected', source: 'detection' };
    }
    return null;
  };

  return { projectRoot, env, detect, _tmpDirs: [projectRoot, xdgConfigHome] };
}

/** Remove every temp directory `buildFullPrecedenceCtx()` created for `ctx`. */
function cleanupPrecedenceCtx(ctx) {
  for (const dir of ctx._tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Split a rendered table row (category/adapter/source padded with 2+ spaces) into columns. */
function splitTableRow(line) {
  return line.trim().split(/\s{2,}/);
}

/** Run `fn`, capturing everything written to `process.stdout.write` as a single string. */
function captureStdout(fn) {
  const orig = process.stdout.write;
  let captured = '';
  process.stdout.write = (chunk) => {
    captured += String(chunk);
    return true;
  };
  let returned;
  try {
    returned = fn();
  } finally {
    process.stdout.write = orig;
  }
  return { captured, returned };
}

const SHIPPED_DEFAULTS = loadShippedDefaults();
const EXPECTED_DATA = buildExpectedData(SHIPPED_DEFAULTS);

describe('explain/resolve: full five-tier precedence chain', () => {
  const ctx = buildFullPrecedenceCtx();
  afterAll(() => cleanupPrecedenceCtx(ctx));

  test('explain(ctx) resolves ok:true with all 14 categories present', () => {
    const result = explain(ctx);
    expect(result.ok).toBe(true);
    expect(Object.keys(result.data).sort()).toEqual([...CATEGORIES].sort());
  });

  test('explain(ctx) shows the exact adapter+source pair for each representative category (AC-012-1)', () => {
    const result = explain(ctx);
    expect(result.data.worktree).toEqual({ adapter: 'jj', source: 'project' });
    expect(result.data['ci-local']).toEqual({ adapter: 'custom-ci', source: 'user' });
    expect(result.data.host).toEqual({ adapter: 'gitlab', source: 'env-compat' });
    // AC-012-1's own worked example: a detection-resolved category reads source "detection".
    expect(result.data.tracker).toEqual({ adapter: 'jira-detected', source: 'detection' });
  });

  test('explain(ctx) matches the full expected map, including every default-tier category', () => {
    const result = explain(ctx);
    expect(result.data).toEqual(EXPECTED_DATA);
  });

  test('resolve(ctx) is identical to explain(ctx)', () => {
    expect(resolve(ctx)).toEqual(explain(ctx));
  });
});

describe('main(): human-readable table output', () => {
  const ctx = buildFullPrecedenceCtx();
  afterAll(() => cleanupPrecedenceCtx(ctx));

  test('main(["explain"], ctx) prints a table with category/adapter/source columns and exits 0', () => {
    const { captured, returned: code } = captureStdout(() => main(['explain'], ctx));
    expect(code).toBe(0);

    const lines = captured.trimEnd().split('\n');
    expect(splitTableRow(lines[0])).toEqual(['category', 'adapter', 'source']);

    const trackerRow = lines.find((line) => line.startsWith('tracker'));
    expect(splitTableRow(trackerRow)).toEqual(['tracker', 'jira-detected', 'detection']);

    const worktreeRow = lines.find((line) => line.startsWith('worktree'));
    expect(splitTableRow(worktreeRow)).toEqual(['worktree', 'jj', 'project']);
  });
});

describe('main(): --json machine-readable output (AC-012-2)', () => {
  const ctx = buildFullPrecedenceCtx();
  afterAll(() => cleanupPrecedenceCtx(ctx));

  test('main(["explain", "--json"], ctx) prints one JSON line matching explain(ctx) exactly, exits 0', () => {
    const direct = explain(ctx);
    const { captured, returned: code } = captureStdout(() => main(['explain', '--json'], ctx));
    expect(code).toBe(0);

    const lines = captured.trimEnd().split('\n');
    expect(lines).toHaveLength(1);

    const parsed = JSON.parse(lines[0]);
    expect(parsed).toEqual(direct);
  });

  test('the same per-category fields asserted in the human table appear identically in the JSON data', () => {
    const { captured } = captureStdout(() => main(['explain', '--json'], ctx));
    const parsed = JSON.parse(captured.trimEnd());

    expect(parsed.data.tracker).toEqual({ adapter: 'jira-detected', source: 'detection' });
    expect(parsed.data.worktree).toEqual({ adapter: 'jj', source: 'project' });
  });
});

describe('executable smoke test (child_process): no config files -> every category is the shipped default', () => {
  let freshProjectRoot;
  let freshXdgConfigHome;
  afterAll(() => {
    fs.rmSync(freshProjectRoot, { recursive: true, force: true });
    fs.rmSync(freshXdgConfigHome, { recursive: true, force: true });
  });

  test('node toolchain-cli.js explain --json -> exit 0, empty stderr, data.host/data.tracker match toolchain.default.yaml', () => {
    freshProjectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'toolchain-cli-smoke-project-'));
    freshXdgConfigHome = fs.mkdtempSync(path.join(os.tmpdir(), 'toolchain-cli-smoke-xdg-'));
    // Deliberately no `.ensemble/toolchain.yaml`, no `$XDG_CONFIG_HOME/ensemble/toolchain.yaml`,
    // and no ENSEMBLE_PR_BACKEND/ENSEMBLE_BRANCHING_STRATEGY in the child env, so every one of
    // the 14 categories must fall all the way through to the real shipped default.

    const res = spawnSync('node', [CLI, 'explain', '--json'], {
      cwd: freshProjectRoot,
      env: {
        PATH: process.env.PATH,
        XDG_CONFIG_HOME: freshXdgConfigHome,
      },
      encoding: 'utf8',
    });

    expect(res.status).toBe(0);
    expect(res.stderr).toBe('');

    const parsed = JSON.parse(res.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.host).toEqual({ adapter: SHIPPED_DEFAULTS.host, source: 'default' });
    expect(parsed.data.tracker).toEqual({ adapter: SHIPPED_DEFAULTS.tracker, source: 'default' });
  });
});
