'use strict';
/**
 * TRD-046-TEST (TRD-2026-8d825f54 PR 10): independent, black-box verification of TRD-046's two
 * Test AC scenarios (docs/TRD/TRD-2026-8d825f54-tool-abstraction-layer.md, "PR 10: Long-tail
 * categories" / TRD-046-TEST). This is a FRESH confirmation, written independently of
 * TRD-046's own unit tests (`scripts/tests/default-only-check.test.js`,
 * `scripts/tests/toolchain-resolve-unknown-adapter.test.js`), which already pass and already
 * prove the LOGIC works against synthetic fixtures/mutants and (for Scenario 1 only) already
 * call `checkDefaultOnly` against the real tree too. This file's job is to independently
 * confirm the same two real-tree/real-process facts a second time, with Scenario 2 going
 * through a real spawned `toolchain-cli.js` child process rather than an in-process function
 * call, so a wiring gap between `resolveAll`/`main`/`printResult` and `assertKnownAdapter`
 * that an in-process call could mask (for example `main`'s argv parsing, JSON envelope
 * printing, or exit-code plumbing silently not reaching the guard) would surface here even if
 * it didn't surface in TRD-046's own white-box tests.
 *
 * Scenario 1 ("Other categories have contract and one default only"): given the first-release
 * tree, every category other than tracker and host (the ten `RESTRICTED_CATEGORIES` in
 * `scripts/lib/default-only-check.js`) has a contract file under
 * `packages/development/toolchain/categories/` and exactly one shipped default adapter
 * directory, no alternative. Verified by calling `checkDefaultOnly` directly against the real
 * `packages/development/toolchain/categories` and `packages/` directories (no mocking) and
 * asserting its exact `{ok: true, errors: []}` return shape -- plus an independent,
 * `checkDefaultOnly`-bypassing filesystem walk of the same ten categories that reads
 * `packages/*\/skills/adapter-<category>-*` directly, so this scenario's "true today" proof
 * does not depend solely on the one function under independent test.
 *
 * Scenario 2 ("Unshipped alternative fails naming category and available adapters"): given a
 * user config selecting an unshipped adapter (`pulumi`) for the `iac` category, running the
 * real, unmodified `toolchain-cli.js resolve --json` as a child process (real `child_process`
 * spawn, not an internal function call) against a temp `.ensemble/toolchain.yaml` exits
 * non-zero with `{ok:false, error:{code:'UNKNOWN_ADAPTER', message}}` naming both `iac` and the
 * real shipped adapter `terraform`.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');
const { spawnSync } = require('child_process');

const { checkDefaultOnly, RESTRICTED_CATEGORIES } = require('../lib/default-only-check');

const REPO_ROOT = path.join(__dirname, '..', '..');
const REAL_CATEGORIES_DIR = path.join(REPO_ROOT, 'packages', 'development', 'toolchain', 'categories');
const REAL_PACKAGES_DIR = path.join(REPO_ROOT, 'packages');
const CLI = path.join(REAL_PACKAGES_DIR, 'development', 'lib', 'toolchain-cli.js');

// Generated/vendor package mirrors: excluded from this file's own independent filesystem walk
// for the same reason `scripts/lib/default-only-check.js#EXCLUDED_PACKAGES` excludes them --
// they re-export a source package's adapters rather than shipping a second, independent one.
const EXCLUDED_PACKAGES = new Set(['pi', 'codex', 'full', 'opencode']);

/**
 * An independent filesystem walk over every real source package's `skills/adapter-*`
 * directories, grouping each by the categories its own `adapter.yaml` declares. This
 * deliberately duplicates none of `scripts/lib/default-only-check.js`'s own helper functions
 * (`discoverShippedAdapters`/`groupShippedAdaptersByCategory`) so Scenario 1's "true today"
 * proof does not depend solely on the correctness of the module it is meant to independently
 * verify.
 *
 * @returns {Record<string, string[]>} category -> sorted list of adapter ids declaring it
 */
function walkShippedAdaptersByCategory() {
  /** @type {Record<string, string[]>} */
  const byCategory = {};
  for (const pkg of fs.readdirSync(REAL_PACKAGES_DIR, { withFileTypes: true })) {
    if (!pkg.isDirectory() || EXCLUDED_PACKAGES.has(pkg.name)) continue;
    const skillsDir = path.join(REAL_PACKAGES_DIR, pkg.name, 'skills');
    if (!fs.existsSync(skillsDir)) continue;
    for (const skill of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (!skill.isDirectory() || !skill.name.startsWith('adapter-')) continue;
      const manifestPath = path.join(skillsDir, skill.name, 'adapter.yaml');
      if (!fs.existsSync(manifestPath)) continue;
      const manifest = yaml.load(fs.readFileSync(manifestPath, 'utf8'));
      if (!manifest || typeof manifest.adapter !== 'string' || !Array.isArray(manifest.categories)) {
        continue;
      }
      for (const category of manifest.categories) {
        if (!byCategory[category]) byCategory[category] = [];
        byCategory[category].push(manifest.adapter);
      }
    }
  }
  for (const category of Object.keys(byCategory)) {
    byCategory[category].sort();
  }
  return byCategory;
}

function tmpProjectRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'toolchain-default-only-verification-'));
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

describe('Scenario 1: other categories have a contract and exactly one default adapter, no alternative', () => {
  test('checkDefaultOnly against the real repo tree reports ok with zero errors', () => {
    const result = checkDefaultOnly(REAL_CATEGORIES_DIR, REAL_PACKAGES_DIR);
    expect(result).toEqual({ ok: true, errors: [] });
  });

  test('an independent filesystem walk (not using default-only-check.js) finds exactly one adapter and a contract file for every restricted category', () => {
    const byCategory = walkShippedAdaptersByCategory();
    for (const category of RESTRICTED_CATEGORIES) {
      const contractPath = path.join(REAL_CATEGORIES_DIR, `${category}.yaml`);
      expect(fs.existsSync(contractPath)).toBe(true);

      const adapters = byCategory[category] || [];
      expect(adapters).toHaveLength(1);
    }
  });

  test('tracker and host are deliberately excluded from the invariant (not asserted single-adapter)', () => {
    expect(RESTRICTED_CATEGORIES).not.toContain('tracker');
    expect(RESTRICTED_CATEGORIES).not.toContain('host');
  });
});

describe('Scenario 2: an unshipped iac selection fails the real CLI end to end naming iac and terraform', () => {
  test('spawning the real toolchain-cli.js resolve --json process with {iac: pulumi} in project config exits non-zero with UNKNOWN_ADAPTER naming iac and terraform', () => {
    const { root, cleanup } = tmpProjectRoot();
    try {
      fs.mkdirSync(path.join(root, '.ensemble'), { recursive: true });
      fs.writeFileSync(path.join(root, '.ensemble', 'toolchain.yaml'), 'iac: pulumi\n');

      const result = spawnSync('node', [CLI, 'resolve', '--json'], {
        cwd: root,
        encoding: 'utf8'
      });

      expect(result.status).not.toBe(0);
      expect(result.status).not.toBeNull();

      const parsed = JSON.parse(result.stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.error.code).toBe('UNKNOWN_ADAPTER');
      expect(parsed.error.message).toContain('iac');
      expect(parsed.error.message).toContain('terraform');
    } finally {
      cleanup();
    }
  });

  test('regression: the same real CLI process resolves cleanly with no project config at all', () => {
    const { root, cleanup } = tmpProjectRoot();
    try {
      const result = spawnSync('node', [CLI, 'resolve', '--json'], {
        cwd: root,
        encoding: 'utf8'
      });

      expect(result.status).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.data.iac).toEqual({ adapter: 'terraform', source: 'default' });
    } finally {
      cleanup();
    }
  });
});
