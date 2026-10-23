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
const { spawnSync, execFileSync } = require('child_process');

const { resolve, explain, main } = require('../lib/toolchain-cli');
const { DEFAULT_TOOLCHAIN_PATH } = require('../lib/toolchain/config');
const {
  makeMutantToolchainRoot,
  mutateAndRequire
} = require('../../../scripts/tests/fixtures/toolchain/mutant-toolchain-copy');

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

/**
 * TRD-2026-8d825f54 TRD-018: `preflight`/`confirm-status`/`confirm-record` subcommand coverage
 * (PRD REQ-013, REQ-011). This file is the TRD's own named path for this coverage; the
 * `mutant-toolchain-copy` mutation-proof helper is used below for the new async-dispatch
 * branch, even though most prior uses of that helper in this repo live under `scripts/tests/`
 * -- this file did not previously import it, but nothing prevents reuse here, and the TRD
 * names this exact file as the home for the new subcommands' subprocess tests.
 */

/** Write `.ensemble/toolchain.yaml` mapping categories to adapter ids for `projectRoot`. */
function mkProjectConfig(projectRoot, categoryToAdapter) {
  const ensembleDir = path.join(projectRoot, '.ensemble');
  fs.mkdirSync(ensembleDir, { recursive: true });
  const lines =
    Object.entries(categoryToAdapter)
      .map(([category, adapterId]) => `${category}: ${adapterId}`)
      .join('\n') + '\n';
  fs.writeFileSync(path.join(ensembleDir, 'toolchain.yaml'), lines);
}

/**
 * Install a fixture adapter under the "installed" origin (`packages/*\/skills/<dir>`), which
 * `loadAdapter` never subjects to the repo-local trust gate -- same convention
 * `scripts/tests/toolchain-preflight.test.js#mkInstalledAdapter` already uses. All capability
 * and health-check `run` arrays invoke the real `process.execPath` with `-e` so every spawned
 * child is a genuine, fast, deterministic Node process, never a shell or mock.
 */
function mkInstalledAdapter(projectRoot, adapterId, overrides = {}) {
  const skillDir = path.join(projectRoot, 'packages', 'fixture-pkg', 'skills', adapterId);
  fs.mkdirSync(skillDir, { recursive: true });
  const manifest = {
    adapter: adapterId,
    version: '1.0.0',
    categories: ['tracker'],
    contract: { tracker: '1.0' },
    binaries: [process.execPath],
    allowlist: [{ bin: process.execPath, sub: ['-e'] }],
    env: [],
    health: [],
    detect: [],
    capabilities: {
      'tracker.show': { run: [process.execPath, '-e', 'process.stdout.write("ok")'] },
      'tracker.create': { run: [process.execPath, '-e', 'process.stdout.write("created")'] }
    },
    ...overrides
  };
  fs.writeFileSync(path.join(skillDir, 'adapter.yaml'), yaml.dump(manifest));
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `# ${adapterId}\n`);
  return skillDir;
}

/**
 * Install a fixture adapter under the repo-local origin (`.ensemble/adapters/<dir>`), which
 * `loadAdapter`'s non-interactive trust gate subjects to the user's `trustedRepoAdapters`
 * allowlist -- an interactive call (the default; no `--non-interactive`) skips that gate
 * entirely regardless of trust, per `../lib/toolchain/adapters.js#loadAdapter`'s own doc.
 * Otherwise identical to `mkInstalledAdapter` above.
 */
function mkRepoLocalAdapter(projectRoot, adapterId, overrides = {}) {
  const adapterDir = path.join(projectRoot, '.ensemble', 'adapters', adapterId);
  fs.mkdirSync(adapterDir, { recursive: true });
  const manifest = {
    adapter: adapterId,
    version: '1.0.0',
    categories: ['tracker'],
    contract: { tracker: '1.0' },
    binaries: [process.execPath],
    allowlist: [{ bin: process.execPath, sub: ['-e'] }],
    env: [],
    health: [],
    detect: [],
    capabilities: {
      'tracker.show': { run: [process.execPath, '-e', 'process.stdout.write("ok")'] },
      'tracker.create': { run: [process.execPath, '-e', 'process.stdout.write("created")'] }
    },
    ...overrides
  };
  fs.writeFileSync(path.join(adapterDir, 'adapter.yaml'), yaml.dump(manifest));
  fs.writeFileSync(path.join(adapterDir, 'SKILL.md'), `# ${adapterId}\n`);
  return adapterDir;
}

/**
 * Minimal, explicit child env for every real subprocess spawned below: only `PATH` is
 * inherited. This deliberately strips `CI`, `ENSEMBLE_NON_INTERACTIVE`, `FOREMAN_TASK_TITLE`,
 * `CLAUDE_SESSION_ID` and `ENSEMBLE_SESSION_ID` from whatever the real host/CI environment
 * happens to set, so `confirm.js`'s non-interactive/session-key precedence chains behave
 * identically and deterministically regardless of where this suite runs (matching
 * `scripts/tests/toolchain-confirm.test.js`'s own "production wiring" convention).
 */
function cleanSpawnEnv() {
  return { PATH: process.env.PATH };
}

describe('preflight: subprocess (TRD-018)', () => {
  test('node toolchain-cli.js preflight --require tracker.show --json -> ok:true with a runId, exit 0', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'toolchain-cli-preflight-ok-'));
    try {
      mkProjectConfig(projectRoot, { tracker: 'fixture-preflight-ok-tracker' });
      mkInstalledAdapter(projectRoot, 'fixture-preflight-ok-tracker', {
        health: [
          { id: 'ok-check', run: [process.execPath, '-e', 'process.exit(0)'], timeoutMs: 2000 }
        ]
      });

      const res = spawnSync('node', [CLI, 'preflight', '--require', 'tracker.show', '--json'], {
        cwd: projectRoot,
        env: cleanSpawnEnv(),
        encoding: 'utf8'
      });

      expect(res.status).toBe(0);
      expect(res.stderr).toBe('');
      const parsed = JSON.parse(res.stdout);
      expect(parsed.ok).toBe(true);
      expect(typeof parsed.runId).toBe('string');
      expect(parsed.runId.length).toBeGreaterThan(0);
      expect(parsed.categories).toEqual(['tracker']);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('node toolchain-cli.js preflight --require tracker.show --json -> HEALTH_FAILED naming the failing check id, non-zero exit', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'toolchain-cli-preflight-fail-'));
    try {
      mkProjectConfig(projectRoot, { tracker: 'fixture-preflight-fail-tracker' });
      mkInstalledAdapter(projectRoot, 'fixture-preflight-fail-tracker', {
        health: [
          {
            id: 'broken-check',
            run: [process.execPath, '-e', 'process.exit(1)'],
            timeoutMs: 2000
          }
        ]
      });

      const res = spawnSync('node', [CLI, 'preflight', '--require', 'tracker.show', '--json'], {
        cwd: projectRoot,
        env: cleanSpawnEnv(),
        encoding: 'utf8'
      });

      expect(res.status).toBe(1);
      const parsed = JSON.parse(res.stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.error.code).toBe('HEALTH_FAILED');
      expect(parsed.error.message).toContain('broken-check');
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describe('preflight: requireCapabilities gating before health checks (TRD-013/TRD-014 follow-up, PRD REQ-004)', () => {
  test('node toolchain-cli.js preflight --require tracker.close against an adapter missing it -> UNAVAILABLE naming the capability and adapter, exit non-zero, no health check spawned, no preflight record', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'toolchain-cli-preflight-unavail-'));
    try {
      const markerPath = path.join(projectRoot, 'health-ran.marker');
      mkProjectConfig(projectRoot, { tracker: 'fixture-preflight-unavail-tracker' });
      mkInstalledAdapter(projectRoot, 'fixture-preflight-unavail-tracker', {
        // Deliberately no 'tracker.close' entry in capabilities (defaults only declare
        // tracker.show/tracker.create).
        health: [
          {
            id: 'marker-check',
            run: [
              process.execPath,
              '-e',
              `require('fs').writeFileSync(${JSON.stringify(markerPath)}, 'ran')`
            ],
            timeoutMs: 2000
          }
        ]
      });

      const res = spawnSync('node', [CLI, 'preflight', '--require', 'tracker.close', '--json'], {
        cwd: projectRoot,
        env: cleanSpawnEnv(),
        encoding: 'utf8'
      });

      expect(res.status).not.toBe(0);
      const parsed = JSON.parse(res.stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.error.code).toBe('UNAVAILABLE');
      expect(parsed.error.message).toContain('tracker.close');
      expect(parsed.error.message).toContain('fixture-preflight-unavail-tracker');

      // No spawn: the health check's marker file -- which only a real spawned process could
      // create -- does not exist.
      expect(fs.existsSync(markerPath)).toBe(false);

      // No preflight record written for any run id.
      const stateDir = path.join(projectRoot, '.ensemble', 'state', 'toolchain');
      const recordFiles = fs.existsSync(stateDir)
        ? fs.readdirSync(stateDir).filter((f) => f.startsWith('preflight-'))
        : [];
      expect(recordFiles).toHaveLength(0);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('node toolchain-cli.js preflight --require tracker.show --require tracker.create --json with both declared -> ok:true with a runId', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'toolchain-cli-preflight-both-required-'));
    try {
      mkProjectConfig(projectRoot, { tracker: 'fixture-preflight-both-required-tracker' });
      mkInstalledAdapter(projectRoot, 'fixture-preflight-both-required-tracker', {
        health: [
          { id: 'ok-check', run: [process.execPath, '-e', 'process.exit(0)'], timeoutMs: 2000 }
        ]
        // capabilities defaults already declare both tracker.show and tracker.create.
      });

      const res = spawnSync(
        'node',
        [CLI, 'preflight', '--require', 'tracker.show', '--require', 'tracker.create', '--json'],
        { cwd: projectRoot, env: cleanSpawnEnv(), encoding: 'utf8' }
      );

      expect(res.status).toBe(0);
      const parsed = JSON.parse(res.stdout);
      expect(parsed.ok).toBe(true);
      expect(typeof parsed.runId).toBe('string');
      expect(parsed.runId.length).toBeGreaterThan(0);
      expect(parsed.categories).toEqual(['tracker']);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('category grouping: a required capability is checked against its own category\'s adapter, not a sibling category\'s', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'toolchain-cli-preflight-cat-group-'));
    try {
      const trackerMarker = path.join(projectRoot, 'tracker-health-ran.marker');
      mkProjectConfig(projectRoot, {
        tracker: 'fixture-preflight-cat-a-tracker',
        'work-graph': 'fixture-preflight-cat-b-workgraph'
      });
      mkInstalledAdapter(projectRoot, 'fixture-preflight-cat-a-tracker', {
        health: [
          {
            id: 'tracker-marker-check',
            run: [
              process.execPath,
              '-e',
              `require('fs').writeFileSync(${JSON.stringify(trackerMarker)}, 'ran')`
            ],
            timeoutMs: 2000
          }
        ]
        // tracker.show is declared by default.
      });
      mkInstalledAdapter(projectRoot, 'fixture-preflight-cat-b-workgraph', {
        categories: ['work-graph'],
        contract: { 'work-graph': '1.0' },
        health: [],
        // Deliberately no 'work-graph.ready' capability.
        capabilities: {}
      });

      const res = spawnSync(
        'node',
        [CLI, 'preflight', '--require', 'tracker.show', '--require', 'work-graph.ready', '--json'],
        { cwd: projectRoot, env: cleanSpawnEnv(), encoding: 'utf8' }
      );

      expect(res.status).not.toBe(0);
      const parsed = JSON.parse(res.stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.error.code).toBe('UNAVAILABLE');
      expect(parsed.error.message).toContain('work-graph.ready');
      expect(parsed.error.message).toContain('fixture-preflight-cat-b-workgraph');
      // Never names the OTHER category's adapter or capability -- the gap is specific to the
      // category whose adapter actually lacks it.
      expect(parsed.error.message).not.toContain('fixture-preflight-cat-a-tracker');
      expect(parsed.error.message).not.toContain('tracker.show');

      // The tracker category's required capability WAS satisfied, but its health check never
      // spawned either: the work-graph category's gate failure aborts the whole preflight
      // before the shared health-check Promise.all (built across every category's loop
      // iteration) is ever reached.
      expect(fs.existsSync(trackerMarker)).toBe(false);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('category grouping: two categories with both required capabilities present -> ok:true naming both categories', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'toolchain-cli-preflight-cat-group-ok-'));
    try {
      mkProjectConfig(projectRoot, {
        tracker: 'fixture-preflight-cat-ok-a-tracker',
        'work-graph': 'fixture-preflight-cat-ok-b-workgraph'
      });
      mkInstalledAdapter(projectRoot, 'fixture-preflight-cat-ok-a-tracker', { health: [] });
      mkInstalledAdapter(projectRoot, 'fixture-preflight-cat-ok-b-workgraph', {
        categories: ['work-graph'],
        contract: { 'work-graph': '1.0' },
        health: [],
        capabilities: {
          'work-graph.ready': { run: [process.execPath, '-e', 'process.stdout.write("ready")'] }
        }
      });

      const res = spawnSync(
        'node',
        [CLI, 'preflight', '--require', 'tracker.show', '--require', 'work-graph.ready', '--json'],
        { cwd: projectRoot, env: cleanSpawnEnv(), encoding: 'utf8' }
      );

      expect(res.status).toBe(0);
      const parsed = JSON.parse(res.stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.categories.sort()).toEqual(['tracker', 'work-graph']);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describe('mutation proof: requireCapabilities gate actually blocks preflight health-check spawning (TRD-013/TRD-014 follow-up)', () => {
  function mkUnavailableFixture(prefix) {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    const markerPath = path.join(projectRoot, 'health-ran.marker');
    mkProjectConfig(projectRoot, { tracker: 'fixture-mutant-unavail-tracker' });
    mkInstalledAdapter(projectRoot, 'fixture-mutant-unavail-tracker', {
      health: [
        {
          id: 'marker-check',
          run: [
            process.execPath,
            '-e',
            `require('fs').writeFileSync(${JSON.stringify(markerPath)}, 'ran')`
          ],
          timeoutMs: 2000
        }
      ]
    });
    return { projectRoot, markerPath };
  }

  test('removing the requireCapabilities call makes a missing required capability no longer fail preflight (the real (a) test is sensitive to this mutation)', async () => {
    const mutantRoot = makeMutantToolchainRoot();
    const { projectRoot, markerPath } = mkUnavailableFixture('toolchain-preflight-mutant-remove-');
    try {
      const preflightPath = path.join(mutantRoot.toolchainLibDir, 'preflight.js');
      const needle = "requireCapabilities(loaded.manifest || {}, requiredForCategory, []);";
      const replacement = "void requiredForCategory; /* mutated: requireCapabilities call removed */";
      const mutatedPreflight = mutateAndRequire(preflightPath, needle, replacement);

      const ctx = { projectRoot, env: {} };
      const result = await mutatedPreflight.runPreflight(
        { categories: ['tracker'], runId: 'mutant-r1', requires: ['tracker.close'] },
        ctx
      );

      // Pre-fix/mutant behavior: with the gate removed, the missing required capability no
      // longer blocks -- preflight proceeds straight to the health check and passes, instead
      // of the fixed code's {ok:false, error:{code:'UNAVAILABLE', ...}}.
      expect(result.ok).toBe(true);
      expect(fs.existsSync(markerPath)).toBe(true);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
      mutantRoot.cleanup();
    }
  });

  test('swallowing the requireCapabilities failure instead of returning early lets the health check spawn anyway (equivalent to moving the gate after the health checks)', async () => {
    const mutantRoot = makeMutantToolchainRoot();
    const { projectRoot, markerPath } = mkUnavailableFixture('toolchain-preflight-mutant-swallow-');
    try {
      const preflightPath = path.join(mutantRoot.toolchainLibDir, 'preflight.js');
      const needle =
        "    } catch (error) {\n" +
        "      return {\n" +
        "        ok: false,\n" +
        "        error: { code: error.code || 'UNAVAILABLE', message: error.message }\n" +
        "      };\n" +
        "    }";
      const replacement =
        "    } catch (error) {\n" +
        "      // mutated: swallow instead of returning early -- the gate no longer blocks\n" +
        "    }";
      const mutatedPreflight = mutateAndRequire(preflightPath, needle, replacement);

      const ctx = { projectRoot, env: {} };
      await mutatedPreflight.runPreflight(
        { categories: ['tracker'], runId: 'mutant-r2', requires: ['tracker.close'] },
        ctx
      );

      // The gate no longer aborts before the health-check Promise.all -- the marker file now
      // exists, proving the real (a) test's "no spawn" assertion is sensitive to this mutation.
      expect(fs.existsSync(markerPath)).toBe(true);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
      mutantRoot.cleanup();
    }
  });
});

describe('confirm-record / confirm-status: subprocess round trip (TRD-018)', () => {
  test('confirm-status is confirmed:false before confirm-record and confirmed:true after it, across three real subprocesses', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'toolchain-cli-confirm-'));
    try {
      mkProjectConfig(projectRoot, { tracker: 'fixture-confirm-tracker' });
      mkInstalledAdapter(projectRoot, 'fixture-confirm-tracker');
      const env = cleanSpawnEnv();
      // A shared --run-id is supplied on every call: with no CLAUDE_SESSION_ID/
      // ENSEMBLE_SESSION_ID set (cleanSpawnEnv strips them) and no --run-id, confirm-record
      // would now be refused with CONFIRM_KEY_REQUIRED (PR 4 review Finding 3 -- no shared
      // 'no-session' bucket); this round trip is about the confirmed/unconfirmed transition,
      // not about keying, so a run id keeps the three calls tied to the same record.
      const runId = 'subprocess-confirm-r1';

      const before = spawnSync(
        'node',
        [CLI, 'confirm-status', 'tracker.create', '--run-id', runId, '--json'],
        { cwd: projectRoot, env, encoding: 'utf8' }
      );
      expect(before.status).toBe(0);
      const beforeParsed = JSON.parse(before.stdout);
      expect(beforeParsed.ok).toBe(true);
      expect(beforeParsed.capability).toBe('tracker.create');
      expect(beforeParsed.adapter).toBe('fixture-confirm-tracker');
      expect(beforeParsed.data.confirmed).toBe(false);

      const record = spawnSync(
        'node',
        [CLI, 'confirm-record', 'tracker.create', '--run-id', runId, '--json'],
        { cwd: projectRoot, env, encoding: 'utf8' }
      );
      expect(record.status).toBe(0);
      const recordParsed = JSON.parse(record.stdout);
      expect(recordParsed.ok).toBe(true);
      expect(recordParsed.data).toEqual({ confirmed: true });

      const after = spawnSync(
        'node',
        [CLI, 'confirm-status', 'tracker.create', '--run-id', runId, '--json'],
        { cwd: projectRoot, env, encoding: 'utf8' }
      );
      expect(after.status).toBe(0);
      const afterParsed = JSON.parse(after.stdout);
      expect(afterParsed.ok).toBe(true);
      expect(afterParsed.data).toEqual({ confirmed: true });
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describe('confirm-status: repo-local adapter allowlist pass-through (TRD-2026-8d825f54 PR 4 review Finding 1)', () => {
  test('an interactive confirm-status call (no --non-interactive) for a repo-local adapter reaches confirmed:false with allowlist in data, never UNTRUSTED_REPO_ADAPTER', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'toolchain-cli-confirm-repo-local-'));
    try {
      mkProjectConfig(projectRoot, { tracker: 'fixture-repo-local-tracker' });
      mkRepoLocalAdapter(projectRoot, 'fixture-repo-local-tracker');

      const res = spawnSync('node', [CLI, 'confirm-status', 'tracker.create', '--json'], {
        cwd: projectRoot,
        env: cleanSpawnEnv(),
        encoding: 'utf8'
      });

      expect(res.status).toBe(0);
      const parsed = JSON.parse(res.stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.adapter).toBe('fixture-repo-local-tracker');
      expect(parsed.data.confirmed).toBe(false);
      expect(parsed.data.allowlist).toEqual([{ bin: process.execPath, sub: ['-e'] }]);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describe('confirm-status / confirm-record: malformed --run-id rejected before adapter resolution (TRD-2026-8d825f54 PR 4 review Finding 2)', () => {
  test('confirm-status with a malformed --run-id returns INVALID_RUN_ID, exit 1', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'toolchain-cli-confirm-status-badrunid-'));
    try {
      const res = spawnSync(
        'node',
        [CLI, 'confirm-status', 'tracker.create', '--run-id', '../escape2', '--json'],
        { cwd: projectRoot, env: cleanSpawnEnv(), encoding: 'utf8' }
      );

      expect(res.status).toBe(1);
      const parsed = JSON.parse(res.stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.error.code).toBe('INVALID_RUN_ID');
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('confirm-record with a malformed --run-id returns INVALID_RUN_ID, exit 1', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'toolchain-cli-confirm-record-badrunid-'));
    try {
      const res = spawnSync(
        'node',
        [CLI, 'confirm-record', 'tracker.create', '--run-id', '../escape2', '--json'],
        { cwd: projectRoot, env: cleanSpawnEnv(), encoding: 'utf8' }
      );

      expect(res.status).toBe(1);
      const parsed = JSON.parse(res.stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.error.code).toBe('INVALID_RUN_ID');
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describe('preflight: malformed --require capability rejected before health checks (TRD-2026-8d825f54 PR 4 review Finding 3)', () => {
  test("preflight --require bogusCapability (no dot) returns INVALID_ARG naming the bad value, never HEALTH_FAILED", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'toolchain-cli-preflight-badrequire-'));
    try {
      const res = spawnSync(
        'node',
        [CLI, 'preflight', '--require', 'bogusCapability', '--json'],
        { cwd: projectRoot, env: cleanSpawnEnv(), encoding: 'utf8' }
      );

      expect(res.status).toBe(1);
      const parsed = JSON.parse(res.stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.error.code).toBe('INVALID_ARG');
      expect(parsed.error.message).toContain('bogusCapability');
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describe('preflight + confirm-record then run: full gate satisfied across three real subprocesses (TRD-018 optional polish)', () => {
  test('confirm-record, then preflight, then run tracker.create with the same --run-id -> run no longer reports PREFLIGHT_REQUIRED', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'toolchain-cli-preflight-then-run-'));
    try {
      mkProjectConfig(projectRoot, { tracker: 'fixture-preflight-then-run-tracker' });
      mkInstalledAdapter(projectRoot, 'fixture-preflight-then-run-tracker', {
        health: [
          { id: 'ok-check', run: [process.execPath, '-e', 'process.exit(0)'], timeoutMs: 2000 }
        ]
      });
      const env = cleanSpawnEnv();
      const runId = 'subprocess-gate-r1';

      const record = spawnSync(
        'node',
        [CLI, 'confirm-record', 'tracker.create', '--run-id', runId, '--json'],
        { cwd: projectRoot, env, encoding: 'utf8' }
      );
      expect(record.status).toBe(0);
      expect(JSON.parse(record.stdout).ok).toBe(true);

      const preflightRes = spawnSync(
        'node',
        [CLI, 'preflight', '--require', 'tracker.show', '--run-id', runId, '--json'],
        { cwd: projectRoot, env, encoding: 'utf8' }
      );
      expect(preflightRes.status).toBe(0);
      expect(JSON.parse(preflightRes.stdout).ok).toBe(true);

      const runRes = spawnSync(
        'node',
        [CLI, 'run', 'tracker.create', '--run-id', runId, '--json'],
        { cwd: projectRoot, env, encoding: 'utf8' }
      );
      const runParsed = JSON.parse(runRes.stdout);
      expect(runParsed.error).toBeUndefined();
      expect(runParsed.ok).toBe(true);
      expect(runRes.status).toBe(0);
      expect(runParsed.data).toBe('created');
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describe('unknown subcommand: subprocess (TRD-018 seven-subcommand usage)', () => {
  test('node toolchain-cli.js bogus --json -> exit 2, usage message lists all seven subcommands', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'toolchain-cli-unknown-'));
    try {
      const res = spawnSync('node', [CLI, 'bogus', '--json'], {
        cwd: projectRoot,
        env: cleanSpawnEnv(),
        encoding: 'utf8'
      });

      expect(res.status).toBe(2);
      const parsed = JSON.parse(res.stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.error.code).toBe('UNKNOWN_SUBCOMMAND');
      for (const name of [
        'resolve',
        'explain',
        'validate',
        'run',
        'preflight',
        'confirm-status',
        'confirm-record'
      ]) {
        expect(parsed.error.message).toContain(name);
      }
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describe('run: PREFLIGHT_REQUIRED subprocess (TRD-018 literal subprocess coverage for `run`)', () => {
  test('node toolchain-cli.js run tracker.create --run-id <id> --json with no prior preflight -> PREFLIGHT_REQUIRED, exit 1', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'toolchain-cli-run-preflight-'));
    try {
      mkProjectConfig(projectRoot, { tracker: 'fixture-run-preflight-tracker' });
      mkInstalledAdapter(projectRoot, 'fixture-run-preflight-tracker');

      const res = spawnSync(
        'node',
        [CLI, 'run', 'tracker.create', '--run-id', 'subprocess-r1', '--json'],
        { cwd: projectRoot, env: cleanSpawnEnv(), encoding: 'utf8' }
      );

      expect(res.status).toBe(1);
      const parsed = JSON.parse(res.stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.error.code).toBe('PREFLIGHT_REQUIRED');
      expect(parsed.error.message).toContain('tracker.create');
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

/**
 * Mutation proof (TRD-018): `main()`'s async-dispatch branch was generalized from
 * `subcommand === 'run'` to `subcommand === 'run' || subcommand === 'preflight'` so a real
 * `preflight` invocation is awaited before its result is printed. This mutant-toolchain-copy
 * test disables the `preflight` arm and shows a real `preflight` call then falls through to
 * the generic *synchronous* dispatch branch, which calls `printResult` on the still-pending
 * `Promise` `preflight()` returned instead of its resolved value -- `result.ok` is `undefined`
 * on a `Promise`, so `printResult`'s failure branch reads `result.error.code` off `undefined`
 * and throws, synchronously, inside `main()`. The real (unmutated) code never does this: the
 * "preflight: subprocess" describe block above proves a real `preflight --require ...` call
 * always returns a clean `{ok:true, runId, ...}`/`{ok:false, error:{...}}` envelope, never a
 * thrown exception.
 */
describe('mutation proof: preflight async-dispatch branch matters (TRD-018)', () => {
  test("removing the `|| subcommand === 'preflight'` arm makes a real preflight invocation throw instead of returning a result", () => {
    const mutantRoot = makeMutantToolchainRoot();
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'toolchain-cli-mutant-preflight-'));
    try {
      const needle = "if (subcommand === 'run' || subcommand === 'preflight') {";
      const replacement = "if (subcommand === 'run') {";
      const mutatedCli = mutateAndRequire(mutantRoot.cliPath, needle, replacement);

      mkProjectConfig(projectRoot, { tracker: 'fixture-mutant-preflight-tracker' });
      mkInstalledAdapter(projectRoot, 'fixture-mutant-preflight-tracker', {
        health: [
          { id: 'ok-check', run: [process.execPath, '-e', 'process.exit(0)'], timeoutMs: 2000 }
        ]
      });

      const ctx = { projectRoot, env: {} };
      // Deliberately no `--json`: with `--json` present, `printResult`'s `if (json)` branch
      // short-circuits to `JSON.stringify(result)` before ever touching `result.ok`/
      // `result.error`, so the mutant's dangling Promise would merely serialize as `{}`
      // instead of surfacing a difference. Without `--json`, `printResult` reads
      // `result.ok` (`undefined` on a `Promise`, since the mutated branch never awaits it)
      // then `result.error.code` off `undefined`, throwing synchronously inside `main()`.
      expect(() =>
        mutatedCli.main(['preflight', '--require', 'tracker.show'], ctx)
      ).toThrow();
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
      mutantRoot.cleanup();
    }
  });
});

function initGitRepo(dir) {
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
}

function setGitRemote(dir, url) {
  execFileSync('git', ['remote', 'add', 'origin', url], { cwd: dir, stdio: 'ignore' });
}

/** Run an async `fn` (typically a direct `main()` call for 'run'/'preflight'), capturing
 * everything written to `process.stdout.write` only AFTER `fn`'s returned promise resolves --
 * unlike the synchronous `captureStdout` above, this never restores the spy before async
 * printing has actually happened. */
async function captureStdoutAsync(fn) {
  const chunks = [];
  const spy = jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    chunks.push(String(chunk));
    return true;
  });
  try {
    const returned = await fn();
    return { returned, stdout: chunks.join('') };
  } finally {
    spy.mockRestore();
  }
}

/**
 * TRD-2026-8d825f54 PR 4 review Finding 1: a detection-selected adapter (no config file at
 * all; the project's git `origin` remote matches an installed adapter's `remote_url_matches`
 * signal) must resolve identically -- same adapter id AND `source:'detection'` -- through
 * EVERY subcommand, not just `resolve`/`explain`. Real git repo, real subprocess, no injected
 * ctx: every call below uses `main()`'s own unmodified default ctx (`detect: detectAdapter`).
 */
describe('detection-selected adapter works end to end through preflight/run/confirm-status (TRD-2026-8d825f54 PR 4 review Finding 1)', () => {
  function mkDetectionProject(adapterId) {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'toolchain-cli-detection-e2e-'));
    initGitRepo(projectRoot);
    setGitRemote(projectRoot, 'https://github.com/example/widget.git');
    mkInstalledAdapter(projectRoot, adapterId, {
      detect: [{ signal: 'remote_url_matches', pattern: 'github\\.com' }],
      capabilities: {
        'tracker.show': { run: [process.execPath, '-e', 'process.stdout.write("ok")'] }
      }
    });
    return projectRoot;
  }

  test('preflight succeeds for the detection-resolved adapter (not the shipped default)', () => {
    const projectRoot = mkDetectionProject('fixture-detect-preflight-tracker');
    try {
      const res = spawnSync('node', [CLI, 'preflight', '--require', 'tracker.show', '--json'], {
        cwd: projectRoot,
        env: cleanSpawnEnv(),
        encoding: 'utf8'
      });
      expect(res.status).toBe(0);
      const parsed = JSON.parse(res.stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.categories).toEqual(['tracker']);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test("run reports source:'detection' for the detection-resolved adapter", () => {
    const projectRoot = mkDetectionProject('fixture-detect-run-tracker');
    try {
      const res = spawnSync('node', [CLI, 'run', 'tracker.show', '--json'], {
        cwd: projectRoot,
        env: cleanSpawnEnv(),
        encoding: 'utf8'
      });
      expect(res.status).toBe(0);
      const parsed = JSON.parse(res.stdout);
      expect(parsed).toEqual({
        ok: true,
        capability: 'tracker.show',
        adapter: 'fixture-detect-run-tracker',
        source: 'detection',
        data: 'ok'
      });
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test("confirm-status reports source:'detection' for the detection-resolved adapter", () => {
    const projectRoot = mkDetectionProject('fixture-detect-confirm-tracker');
    try {
      const res = spawnSync('node', [CLI, 'confirm-status', 'tracker.show', '--json'], {
        cwd: projectRoot,
        env: cleanSpawnEnv(),
        encoding: 'utf8'
      });
      expect(res.status).toBe(0);
      const parsed = JSON.parse(res.stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.adapter).toBe('fixture-detect-confirm-tracker');
      expect(parsed.source).toBe('detection');
      // tracker.show is sideEffect:false, so confirmation is never required for it.
      expect(parsed.data).toEqual({ required: false });
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  describe('mutation-proof: dropping ctx.detect in the preflight handler loses the detected adapter', () => {
    test("removing 'detect: ctx.detect' from the preflight handler's runPreflight ctx falls through to the shipped default and fails, never succeeding for the detected adapter", async () => {
      const mutantRoot = makeMutantToolchainRoot();
      try {
        const needle =
          "  return runPreflight(\n" +
          "    { categories, runId, nonInteractive: Boolean(parsed.nonInteractive), requires },\n" +
          "    {\n" +
          "      projectRoot: ctx.projectRoot || process.cwd(),\n" +
          "      env: ctx.env || process.env,\n" +
          "      detect: ctx.detect\n" +
          "    }\n" +
          "  );";
        const replacement =
          "  return runPreflight(\n" +
          "    { categories, runId, nonInteractive: Boolean(parsed.nonInteractive), requires },\n" +
          "    { projectRoot: ctx.projectRoot || process.cwd(), env: ctx.env || process.env }\n" +
          "  );";
        const mutatedCli = mutateAndRequire(mutantRoot.cliPath, needle, replacement);

        const projectRoot = mkDetectionProject('fixture-detect-mutant-tracker');
        const { detectAdapter } = require(mutantRoot.toolchainLibDir + '/detect.js');
        try {
          const code = await mutatedCli.main(
            ['preflight', '--require', 'tracker.show', '--json'],
            { projectRoot, env: { PATH: process.env.PATH }, detect: detectAdapter }
          );
          // With `detect` dropped, resolveCategory falls through to the shipped default (never
          // 'fixture-detect-mutant-tracker', which is not installed under the shipped default
          // id either) -- exactly what the real (unmutated) "preflight succeeds for the
          // detection-resolved adapter" test above disproves.
          expect(code).toBe(1);
        } finally {
          fs.rmSync(projectRoot, { recursive: true, force: true });
        }
      } finally {
        mutantRoot.cleanup();
      }
    });
  });

  describe('mutation-proof: dropping opts.source in run() loses the true source', () => {
    test("removing 'source,' from run()'s runCapability opts reports source:null even for a successful detection-resolved run", async () => {
      const mutantRoot = makeMutantToolchainRoot();
      try {
        const needle =
          "  const result = await runCapability(loaded.manifest, capability, args, {\n" +
          "    source,\n" +
          "    execFileOptions: { cwd: projectRoot }\n" +
          "  });";
        const replacement =
          "  const result = await runCapability(loaded.manifest, capability, args, {\n" +
          "    execFileOptions: { cwd: projectRoot }\n" +
          "  });";
        const mutatedCli = mutateAndRequire(mutantRoot.cliPath, needle, replacement);

        const projectRoot = mkDetectionProject('fixture-detect-nosource-tracker');
        const { detectAdapter } = require(mutantRoot.toolchainLibDir + '/detect.js');
        try {
          const { returned: code, stdout } = await captureStdoutAsync(() =>
            mutatedCli.main(['run', 'tracker.show', '--json'], {
              projectRoot,
              env: { PATH: process.env.PATH },
              detect: detectAdapter
            })
          );
          expect(code).toBe(0);
          const parsed = JSON.parse(stdout.trim());
          expect(parsed.ok).toBe(true);
          // With 'source,' removed, the envelope reports null even though the adapter was
          // genuinely resolved via detection -- exactly what the real (unmutated)
          // "run reports source:'detection'" test above disproves.
          expect(parsed.source).toBeNull();
        } finally {
          fs.rmSync(projectRoot, { recursive: true, force: true });
        }
      } finally {
        mutantRoot.cleanup();
      }
    });
  });
});

/**
 * TRD-2026-8d825f54 PR 4 review Finding 2: `run()` derives `interactive` the same way
 * `confirm-status`/`confirm-record` already do and loads the adapter BEFORE the confirmation
 * gate, so an interactive run of a repo-local adapter reaches `CONFIRMATION_REQUIRED` (never
 * `UNTRUSTED_REPO_ADAPTER`), while a non-interactive run without trust is still refused --
 * and, in both cases, the adapter's own side effect never actually runs (proved by a marker
 * file the adapter's spawned child would create, which never appears).
 */
describe('run(): interactive repo-local adapter reaches confirmation; non-interactive untrusted still refused; no spawn before confirmation (TRD-2026-8d825f54 PR 4 review Finding 2)', () => {
  function mkRepoLocalMarkerProject(adapterId, markerPath) {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'toolchain-cli-interactive-repo-local-'));
    mkProjectConfig(projectRoot, { tracker: adapterId });
    mkRepoLocalAdapter(projectRoot, adapterId, {
      capabilities: {
        'tracker.create': {
          run: [
            process.execPath,
            '-e',
            `require('fs').writeFileSync(${JSON.stringify(markerPath)}, 'spawned')`
          ]
        }
      }
    });
    return projectRoot;
  }

  test('an interactive run (no --non-interactive, no non-interactive env signal) reaches CONFIRMATION_REQUIRED, never UNTRUSTED_REPO_ADAPTER, and never spawns the adapter', () => {
    const markerPath = path.join(os.tmpdir(), `toolchain-cli-marker-interactive-${Date.now()}.txt`);
    const projectRoot = mkRepoLocalMarkerProject('fixture-repo-local-interactive', markerPath);
    try {
      const preflightRes = spawnSync(
        'node',
        [CLI, 'preflight', '--require', 'tracker.create', '--json'],
        { cwd: projectRoot, env: cleanSpawnEnv(), encoding: 'utf8' }
      );
      expect(preflightRes.status).toBe(0);
      const runId = JSON.parse(preflightRes.stdout).runId;

      const runRes = spawnSync(
        'node',
        [CLI, 'run', 'tracker.create', '--run-id', runId, '--json'],
        { cwd: projectRoot, env: cleanSpawnEnv(), encoding: 'utf8' }
      );
      expect(runRes.status).toBe(1);
      const parsed = JSON.parse(runRes.stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.error.code).toBe('CONFIRMATION_REQUIRED');
      expect(parsed.error.code).not.toBe('UNTRUSTED_REPO_ADAPTER');
      expect(fs.existsSync(markerPath)).toBe(false);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
      fs.rmSync(markerPath, { force: true });
    }
  });

  test('a non-interactive run without trust is still refused with UNTRUSTED_REPO_ADAPTER, and never spawns the adapter', () => {
    const markerPath = path.join(os.tmpdir(), `toolchain-cli-marker-noninteractive-${Date.now()}.txt`);
    const projectRoot = mkRepoLocalMarkerProject('fixture-repo-local-noninteractive', markerPath);
    try {
      const preflightRes = spawnSync(
        'node',
        [CLI, 'preflight', '--require', 'tracker.create', '--json'],
        { cwd: projectRoot, env: cleanSpawnEnv(), encoding: 'utf8' }
      );
      // preflight itself is also non-interactive-trust-gated (consistently, Finding 2); an
      // interactive preflight is used here only to obtain a passing record so this test
      // isolates the `run` subcommand's own gate.
      expect(preflightRes.status).toBe(0);
      const runId = JSON.parse(preflightRes.stdout).runId;

      const runRes = spawnSync(
        'node',
        [CLI, 'run', 'tracker.create', '--run-id', runId, '--non-interactive', '--json'],
        { cwd: projectRoot, env: cleanSpawnEnv(), encoding: 'utf8' }
      );
      expect(runRes.status).toBe(1);
      const parsed = JSON.parse(runRes.stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.error.code).toBe('UNTRUSTED_REPO_ADAPTER');
      expect(fs.existsSync(markerPath)).toBe(false);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
      fs.rmSync(markerPath, { force: true });
    }
  });

  describe('mutation-proof: removing the interactive derivation makes an interactive run of a repo-local adapter wrongly untrusted', () => {
    test("reverting run()'s loadAdapter call to the old bare ctx (no derived interactive flag) makes a genuinely interactive run fail UNTRUSTED_REPO_ADAPTER instead of reaching CONFIRMATION_REQUIRED", async () => {
      const mutantRoot = makeMutantToolchainRoot();
      try {
        const needle = '    loaded = loadAdapter(adapterId, { ...ctx, interactive });';
        const replacement = '    loaded = loadAdapter(adapterId, ctx);';
        const mutatedCli = mutateAndRequire(mutantRoot.cliPath, needle, replacement);

        const markerPath = path.join(os.tmpdir(), `toolchain-cli-marker-mutant-${Date.now()}.txt`);
        const projectRoot = mkRepoLocalMarkerProject('fixture-repo-local-mutant', markerPath);
        try {
          // A real preflight record, written directly through the mutant's own (unaffected)
          // preflight.js, so this test isolates `run()`'s own loadAdapter call -- not
          // preflight's.
          const { runPreflight } = require(mutantRoot.toolchainLibDir + '/preflight.js');
          const runId = 'mutant-interactive-r1';
          const pf = await runPreflight(
            { categories: ['tracker'], runId },
            { projectRoot, env: { PATH: process.env.PATH } }
          );
          expect(pf.ok).toBe(true);

          const { returned: code, stdout } = await captureStdoutAsync(() =>
            mutatedCli.main(['run', 'tracker.create', '--run-id', runId, '--json'], {
              projectRoot,
              env: { PATH: process.env.PATH }
            })
          );
          expect(code).toBe(1);
          const parsed = JSON.parse(stdout.trim());
          // With the derived `interactive` flag reverted to the old bare `ctx` (always
          // `interactive:false` by default inside `loadAdapter`), a genuinely interactive run
          // of a repo-local adapter now fails `UNTRUSTED_REPO_ADAPTER` instead of reaching
          // `CONFIRMATION_REQUIRED` -- exactly what the real (unmutated) "interactive run
          // reaches CONFIRMATION_REQUIRED" test above disproves.
          expect(parsed.error.code).toBe('UNTRUSTED_REPO_ADAPTER');
          expect(fs.existsSync(markerPath)).toBe(false);
        } finally {
          fs.rmSync(projectRoot, { recursive: true, force: true });
          fs.rmSync(markerPath, { force: true });
        }
      } finally {
        mutantRoot.cleanup();
      }
    });
  });
});
