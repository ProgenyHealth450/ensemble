'use strict';
/**
 * Tests for the "default-only" adapter invariant (TRD-2026-8d825f54 TRD-046):
 * scripts/lib/default-only-check.js's `checkDefaultOnly` asserts that each of the ten
 * restricted toolchain categories (worktree, ci-local, review, lint, test-runner, e2e-quality,
 * container-deploy, iac, platform-cloud, package-runner) has exactly one shipped adapter and
 * its own category contract file.
 *
 * Mutation proof below operates on a fresh os.tmpdir() copy of
 * scripts/lib/default-only-check.js (never the live repo source), mirroring
 * scripts/tests/capability-ids-check.test.js's own `mutateAndRequireCheck` pattern at the same
 * dependency-free-module scale.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');

const {
  RESTRICTED_CATEGORIES,
  discoverShippedAdapters,
  groupShippedAdaptersByCategory,
  checkDefaultOnly
} = require('../lib/default-only-check');

const REPO_ROOT = path.join(__dirname, '..', '..');
const REAL_CATEGORIES_DIR = path.join(REPO_ROOT, 'packages', 'development', 'toolchain', 'categories');
const REAL_PACKAGES_DIR = path.join(REPO_ROOT, 'packages');
const REAL_FILE = path.resolve(__dirname, '..', 'lib', 'default-only-check.js');

/**
 * Write a minimal, valid-enough adapter directory (`adapter.yaml` only -- this module never
 * reads `SKILL.md`) under `skillsDir/adapter-<adapter>`.
 */
function writeFixtureAdapter(skillsDir, { adapter, categories }) {
  const dir = path.join(skillsDir, `adapter-${adapter}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'adapter.yaml'),
    yaml.dump({ adapter, categories })
  );
}

/**
 * Build a fresh temp `packages/` tree with exactly one shipped adapter per
 * `RESTRICTED_CATEGORIES` entry, under a single fixture package directory, plus whatever extra
 * adapters `extra` describes (each `{adapter, categories}`, added to the SAME fixture package).
 *
 * @param {Array<{adapter: string, categories: string[]}>} [extra]
 * @returns {{packagesDir: string, cleanup: () => void}}
 */
function makeFixturePackagesDir(extra = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'default-only-check-fixture-'));
  const skillsDir = path.join(root, 'fixture-pkg', 'skills');
  fs.mkdirSync(skillsDir, { recursive: true });

  for (const category of RESTRICTED_CATEGORIES) {
    writeFixtureAdapter(skillsDir, { adapter: `${category}-only`, categories: [category] });
  }
  for (const entry of extra) {
    writeFixtureAdapter(skillsDir, entry);
  }

  return {
    packagesDir: root,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true })
  };
}

/**
 * Apply a single, mandatory string replacement to a fresh /tmp copy of
 * scripts/lib/default-only-check.js and `require()` the result. Throws if `needle` is not
 * found, so a mutation test fails loudly instead of silently no-op'ing when the real source has
 * since changed.
 */
function mutateAndRequireCheck(needle, replacement) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'default-only-check-mutant-'));
  const nodeModulesLink = path.join(tmpDir, 'node_modules');
  try {
    fs.symlinkSync(path.resolve(__dirname, '..', '..', 'node_modules'), nodeModulesLink, 'dir');

    const tmpFile = path.join(tmpDir, 'default-only-check.js');
    const original = fs.readFileSync(REAL_FILE, 'utf8');
    if (!original.includes(needle)) {
      throw new Error(`mutateAndRequireCheck: needle not found: ${JSON.stringify(needle)}`);
    }
    const mutated = original.replace(needle, replacement);
    if (mutated === original) {
      throw new Error('mutateAndRequireCheck: replacement produced no change');
    }
    fs.writeFileSync(tmpFile, mutated);
    // eslint-disable-next-line global-require, import/no-dynamic-require
    return require(tmpFile);
  } finally {
    try {
      fs.rmSync(nodeModulesLink, { force: true });
    } catch {
      // already gone
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe('checkDefaultOnly against the real repo tree', () => {
  test('all 10 restricted categories are compliant after TRD-042/043/044', () => {
    const result = checkDefaultOnly(REAL_CATEGORIES_DIR, REAL_PACKAGES_DIR);
    expect(result).toEqual({ ok: true, errors: [] });
  });

  test('generated/vendor packages (pi, codex, full, opencode) never contribute a second adapter', () => {
    // packages/pi ships its own adapter-host-github, adapter-tracker-beads, etc. (a bundled
    // copy of the real ones) and packages/full mirrors adapter-tracker-beads too -- if either
    // were not excluded, every restricted category with a packages/pi counterpart would wrongly
    // report 2+ adapters. (None of the restricted categories currently have a packages/pi
    // mirror, so this also guards against one being added without updating the exclusion list.)
    const adapters = discoverShippedAdapters(REAL_PACKAGES_DIR);
    for (const adapter of adapters) {
      expect(adapter.dir).not.toMatch(/[/\\]packages[/\\](pi|codex|full|opencode)[/\\]/);
    }
  });
});

describe('groupShippedAdaptersByCategory', () => {
  test('every restricted category key is present even when nothing ships for it', () => {
    const { packagesDir, cleanup } = makeFixturePackagesDir();
    try {
      fs.rmSync(path.join(packagesDir, 'fixture-pkg', 'skills', 'adapter-iac-only'), {
        recursive: true,
        force: true
      });
      const grouped = groupShippedAdaptersByCategory(packagesDir);
      expect(grouped.iac).toEqual([]);
      expect(grouped.worktree).toEqual([{ name: 'worktree-only', dir: expect.any(String) }]);
    } finally {
      cleanup();
    }
  });
});

describe('checkDefaultOnly: fixture failure modes (never written into the live repo tree)', () => {
  test('zero adapters for a restricted category fails naming it', () => {
    const { packagesDir, cleanup } = makeFixturePackagesDir();
    try {
      fs.rmSync(path.join(packagesDir, 'fixture-pkg', 'skills', 'adapter-lint-only'), {
        recursive: true,
        force: true
      });
      const result = checkDefaultOnly(REAL_CATEGORIES_DIR, packagesDir);
      expect(result.ok).toBe(false);
      expect(result.errors.some((m) => m.includes('lint') && m.includes('no shipped adapter'))).toBe(
        true
      );
    } finally {
      cleanup();
    }
  });

  test('a second shipped adapter for iac fails exit 1, naming iac and both adapter names', () => {
    const { packagesDir, cleanup } = makeFixturePackagesDir([
      { adapter: 'pulumi', categories: ['iac'] }
    ]);
    try {
      const result = checkDefaultOnly(REAL_CATEGORIES_DIR, packagesDir);
      expect(result.ok).toBe(false);
      const iacError = result.errors.find((m) => m.startsWith('iac:'));
      expect(iacError).toBeDefined();
      expect(iacError).toEqual(
        expect.stringContaining('expected exactly one shipped adapter, found 2')
      );
      expect(iacError).toEqual(expect.stringContaining('iac-only'));
      expect(iacError).toEqual(expect.stringContaining('pulumi'));
      // Every OTHER restricted category still has exactly one adapter in this fixture, so no
      // other category should appear in errors.
      expect(result.errors.filter((m) => !m.startsWith('iac:'))).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test('a missing category contract file fails naming it', () => {
    const { packagesDir, cleanup } = makeFixturePackagesDir();
    const tmpCategoriesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'default-only-check-categories-'));
    try {
      for (const file of fs.readdirSync(REAL_CATEGORIES_DIR)) {
        if (file === 'iac.yaml') continue; // deliberately omitted
        fs.copyFileSync(path.join(REAL_CATEGORIES_DIR, file), path.join(tmpCategoriesDir, file));
      }
      const result = checkDefaultOnly(tmpCategoriesDir, packagesDir);
      expect(result.ok).toBe(false);
      expect(
        result.errors.some((m) => m.includes('iac') && m.includes('missing category contract file'))
      ).toBe(true);
    } finally {
      cleanup();
      fs.rmSync(tmpCategoriesDir, { recursive: true, force: true });
    }
  });
});

describe('checkDefaultOnly: mutation proof', () => {
  test('a mutant with the "2+ adapters" branch removed wrongly passes the exact fixture that catches the real bug', () => {
    const { packagesDir, cleanup } = makeFixturePackagesDir([
      { adapter: 'pulumi', categories: ['iac'] }
    ]);
    try {
      // Sanity: the real, unmutated module correctly fails this fixture (asserted in detail by
      // the test above too).
      const real = checkDefaultOnly(REAL_CATEGORIES_DIR, packagesDir);
      expect(real.ok).toBe(false);

      // Mutant: the "two or more shipped adapters" branch never pushes an error (as if that
      // whole `else if` arm were deleted) -- the exact defect this test must catch.
      const mutant = mutateAndRequireCheck(
        `    } else if (adapters.length > 1) {
      const names = adapters.map((a) => a.name).join(', ');
      errors.push(
        \`\${category}: expected exactly one shipped adapter, found \${adapters.length} (\${names})\`
      );
    }`,
        '    }'
      );
      const mutated = mutant.checkDefaultOnly(REAL_CATEGORIES_DIR, packagesDir);
      expect(mutated.ok).toBe(true); // wrongly passes -- proves the branch above is load-bearing
      expect(mutated.errors).toEqual([]);
    } finally {
      cleanup();
    }
  });
});
