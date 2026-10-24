'use strict';

/**
 * Cross-runtime resolution parity harness (TRD-2026-8d825f54 TRD-021, PRD REQ-021,
 * AC-021-1, AC-021-2).
 *
 * `toolchain-cli.js resolve --json` is shipped four times -- once per runtime -- and each
 * copy must resolve the same project config to the exact same `{adapter, source}` map for
 * every one of the 14 categories (`packages/development/lib/toolchain-cli.js#CATEGORIES`):
 *
 *   - claude/source: packages/development/lib/toolchain-cli.js (+ lib/toolchain/, + the
 *     sibling packages/development/toolchain/ data dir) -- the canonical, hand-maintained
 *     copy every other runtime is vendored from.
 *   - pi:            packages/pi/vendor/lib/toolchain-cli.js (+ vendor/lib/toolchain/, +
 *     vendor/toolchain/) -- a static, checked-in vendored copy (TRD-019).
 *   - codex:         packages/codex/.codex/skills/vendor/lib/toolchain-cli.js (+ sibling
 *     vendor/lib/toolchain/, + vendor/toolchain/) -- a static, checked-in vendored copy.
 *   - opencode:      has NO static vendored copy; `scripts/generate-opencode/index.js` calls
 *     `scripts/lib/toolchain-vendor.js#vendorToolchainLibrary` to produce
 *     `<outputDir>/.opencode/skill/vendor/lib/toolchain-cli.js` fresh on every generator run,
 *     so this harness generates one into a throwaway `os.tmpdir()` output dir before testing
 *     it, exactly like a real `npm run generate:opencode` would.
 *
 * Every runtime copy under test is built into (or, for opencode, generated into) a fresh
 * `os.tmpdir()`-rooted directory -- never the live, tracked `packages/**` tree -- with a
 * `node_modules` symlink to this monorepo's real, hoisted `node_modules` created BEFORE
 * anything else is written, mirroring `scripts/tests/fixtures/toolchain/mutant-toolchain-
 * copy.js#makeMutantToolchainRoot()` and `scripts/tests/fixtures/codex-generate/temp-codex-
 * root.js#makeCodexTempRoot()` exactly (both already-established patterns in this suite),
 * so each copied `toolchain-cli.js`'s `require('ajv')`/`require('js-yaml')` resolve via
 * Node's normal upward node_modules walk without copying `node_modules` itself. The claude/
 * source leg reuses `makeMutantToolchainRoot()` directly (its unmutated return value is
 * exactly the claude/source bundle layout this harness needs) rather than re-implementing the
 * same copy; pi and codex use a small local `copyRuntimeBundle()` helper below, since
 * `makeMutantToolchainRoot()` is hard-coded to `packages/development`'s own source paths.
 *
 * The fixture project config lives at `scripts/tests/fixtures/toolchain/runtime-parity-
 * fixture/.ensemble/toolchain.yaml` (a static, committed input fixture, not a temp-dir
 * artifact) and sets every one of the 14 categories explicitly, so `resolveCategory()`
 * (`packages/development/lib/toolchain/config.js`) always resolves via `source: 'project'`
 * for every category in every runtime -- the parity assertion below depends only on that
 * file's content, never on the host machine's own `$XDG_CONFIG_HOME` user config, legacy
 * env-compat variables, or git-remote-based detection.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { makeMutantToolchainRoot } = require('./fixtures/toolchain/mutant-toolchain-copy');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const REPO_NODE_MODULES = path.join(REPO_ROOT, 'node_modules');
const FIXTURE_PROJECT_ROOT = path.join(
  __dirname,
  'fixtures',
  'toolchain',
  'runtime-parity-fixture'
);

/**
 * A minimal, fixed child-process environment: the fixture config sets every category, so
 * `resolveCategory()` never reaches user config/env-compat/detection, but this still keeps
 * every runtime's `resolve --json` invocation independent of whatever the host test-runner's
 * own environment happens to contain.
 */
const ISOLATED_ENV = { PATH: process.env.PATH };

function copyFileSync(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

/**
 * Build a fresh copy of one runtime's `toolchain-cli.js` + `lib/toolchain/` + sibling
 * `toolchain/` data dir + `complexity-analyzer.js`, under `destRoot` (already inside an
 * `os.tmpdir()`-rooted directory with a `node_modules` symlink -- this function does not
 * create one itself).
 *
 * @returns {{cliPath: string, toolchainLibDir: string}}
 */
function copyRuntimeBundle(destRoot, { cliSrc, toolchainLibSrc, toolchainDataSrc, complexitySrc }) {
  const libDest = path.join(destRoot, 'lib');
  const toolchainLibDest = path.join(libDest, 'toolchain');
  const toolchainDataDest = path.join(destRoot, 'toolchain');

  copyFileSync(cliSrc, path.join(libDest, 'toolchain-cli.js'));
  copyFileSync(complexitySrc, path.join(libDest, 'complexity-analyzer.js'));
  fs.cpSync(toolchainLibSrc, toolchainLibDest, { recursive: true });
  fs.cpSync(toolchainDataSrc, toolchainDataDest, { recursive: true });

  return { cliPath: path.join(libDest, 'toolchain-cli.js'), toolchainLibDir: toolchainLibDest };
}

/** Run `node <cliPath> resolve --json` against the fixture project and parse its stdout. */
function runResolveJson(cliPath) {
  const stdout = execFileSync(process.execPath, [cliPath, 'resolve', '--json'], {
    cwd: FIXTURE_PROJECT_ROOT,
    env: ISOLATED_ENV,
    encoding: 'utf8'
  });
  return JSON.parse(stdout);
}

describe('toolchain-runtime-parity', () => {
  /** @type {{cliPath: string, cleanup: () => void}} */
  let claude;
  /** @type {{root: string, piCliPath: string, codexCliPath: string, codexFailureCliPath: string, codexFailureToolchainLibDir: string}} */
  let shared;
  /** @type {{root: string, opencodeCliPath: string}} */
  let opencode;

  beforeAll(() => {
    // --- claude/source: reuse the existing, already-established helper verbatim. ---
    claude = makeMutantToolchainRoot();

    // --- pi + codex: one shared os.tmpdir() root (one node_modules symlink for both). ---
    const sharedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'toolchain-runtime-parity-'));
    fs.symlinkSync(REPO_NODE_MODULES, path.join(sharedRoot, 'node_modules'), 'dir');

    const pi = copyRuntimeBundle(path.join(sharedRoot, 'pi'), {
      cliSrc: path.join(REPO_ROOT, 'packages', 'pi', 'vendor', 'lib', 'toolchain-cli.js'),
      toolchainLibSrc: path.join(REPO_ROOT, 'packages', 'pi', 'vendor', 'lib', 'toolchain'),
      toolchainDataSrc: path.join(REPO_ROOT, 'packages', 'pi', 'vendor', 'toolchain'),
      complexitySrc: path.join(REPO_ROOT, 'packages', 'pi', 'vendor', 'lib', 'complexity-analyzer.js')
    });

    const codexVendorRoot = path.join(
      REPO_ROOT,
      'packages',
      'codex',
      '.codex',
      'skills',
      'vendor'
    );
    const codex = copyRuntimeBundle(path.join(sharedRoot, 'codex'), {
      cliSrc: path.join(codexVendorRoot, 'lib', 'toolchain-cli.js'),
      toolchainLibSrc: path.join(codexVendorRoot, 'lib', 'toolchain'),
      toolchainDataSrc: path.join(codexVendorRoot, 'toolchain'),
      complexitySrc: path.join(codexVendorRoot, 'lib', 'complexity-analyzer.js')
    });

    // A second, independent codex copy dedicated to the Scenario 2 (missing-mechanism)
    // mutation, so deleting its `lib/toolchain/` subdirectory can never affect the Scenario 1
    // copy above regardless of test execution order.
    const codexFailure = copyRuntimeBundle(path.join(sharedRoot, 'codex-failure'), {
      cliSrc: path.join(codexVendorRoot, 'lib', 'toolchain-cli.js'),
      toolchainLibSrc: path.join(codexVendorRoot, 'lib', 'toolchain'),
      toolchainDataSrc: path.join(codexVendorRoot, 'toolchain'),
      complexitySrc: path.join(codexVendorRoot, 'lib', 'complexity-analyzer.js')
    });

    shared = {
      root: sharedRoot,
      piCliPath: pi.cliPath,
      codexCliPath: codex.cliPath,
      codexFailureCliPath: codexFailure.cliPath,
      codexFailureToolchainLibDir: codexFailure.toolchainLibDir
    };

    // --- opencode: no static vendored copy -- generate one fresh into a temp output dir. ---
    const opencodeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'toolchain-runtime-parity-opencode-'));
    fs.symlinkSync(REPO_NODE_MODULES, path.join(opencodeRoot, 'node_modules'), 'dir');
    const opencodeOutDir = path.join(opencodeRoot, 'out');

    execFileSync(
      process.execPath,
      [
        path.join(REPO_ROOT, 'scripts', 'generate-opencode', 'index.js'),
        '--output-dir',
        opencodeOutDir,
        '--packages-dir',
        path.join(REPO_ROOT, 'packages')
      ],
      { cwd: REPO_ROOT, encoding: 'utf8' }
    );

    opencode = {
      root: opencodeRoot,
      opencodeCliPath: path.join(opencodeOutDir, '.opencode', 'skill', 'vendor', 'lib', 'toolchain-cli.js')
    };
  }, 60000);

  afterAll(() => {
    claude.cleanup();
    fs.rmSync(path.join(shared.root, 'node_modules'), { force: true });
    fs.rmSync(shared.root, { recursive: true, force: true });
    fs.rmSync(path.join(opencode.root, 'node_modules'), { force: true });
    fs.rmSync(opencode.root, { recursive: true, force: true });
  });

  describe('Scenario 1: same adapter/source every runtime (Implementation AC 1)', () => {
    test('claude, opencode, pi and codex resolve the fixture project to the same 14-category {adapter, source} map', () => {
      expect(fs.existsSync(opencode.opencodeCliPath)).toBe(true);

      const results = {
        claude: runResolveJson(claude.cliPath),
        opencode: runResolveJson(opencode.opencodeCliPath),
        pi: runResolveJson(shared.piCliPath),
        codex: runResolveJson(shared.codexCliPath)
      };

      for (const [runtime, result] of Object.entries(results)) {
        expect(result.ok).toBe(true);
      }

      const baselineRuntime = 'claude';
      const baseline = results[baselineRuntime].data;
      const categories = Object.keys(baseline);
      expect(categories).toHaveLength(14);

      // Compare category-by-category (rather than one bulk deep-equal) so a mismatch's
      // failure message names both the offending runtime and category directly
      // (Implementation AC 3: "the test fails naming runtime and category").
      const mismatches = [];
      for (const [runtime, result] of Object.entries(results)) {
        if (runtime === baselineRuntime) continue;
        for (const category of categories) {
          const expected = baseline[category];
          const actual = result.data[category];
          if (!actual || actual.adapter !== expected.adapter || actual.source !== expected.source) {
            mismatches.push(
              `${runtime}/${category}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
            );
          }
        }
      }

      expect(mismatches).toEqual([]);
    });
  });

  describe('Scenario 2: unsupported runtime fails explicitly (Implementation AC 2)', () => {
    test('a codex bundle with lib/toolchain/ removed fails resolve --json with a non-zero exit naming the missing mechanism, never a default-adapter fallback', () => {
      fs.rmSync(shared.codexFailureToolchainLibDir, { recursive: true, force: true });

      let caught;
      try {
        execFileSync(process.execPath, [shared.codexFailureCliPath, 'resolve', '--json'], {
          cwd: FIXTURE_PROJECT_ROOT,
          env: ISOLATED_ENV,
          encoding: 'utf8'
        });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeDefined();
      expect(caught.status).not.toBe(0);

      // The real, pre-existing failure path: toolchain-cli.js's own top-level
      // `require('./toolchain/config')` (packages/development/lib/toolchain-cli.js:141) throws
      // Node's native MODULE_NOT_FOUND before any subcommand runs, naming the missing
      // mechanism (the resolver's own config module) in stderr. No product code was added to
      // produce this: deleting `lib/toolchain/` makes the CLI's unconditional top-level
      // requires (lines 141-149) fail before `main()`/`resolveAll()` is ever reached, so no
      // category can be silently resolved to a default adapter.
      expect(caught.stderr).toContain('Cannot find module');
      expect(caught.stderr).toContain('./toolchain/config');

      // No adapter id from the fixture or shipped default ever appears in stdout -- the
      // process produced no resolution output at all, not a partial or fallback one.
      expect(caught.stdout || '').not.toContain('github');
      expect(caught.stdout || '').not.toContain('"ok"');
    });
  });
});
