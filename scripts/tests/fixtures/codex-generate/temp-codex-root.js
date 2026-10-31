'use strict';

/**
 * Shared test helper (NOT a test file itself) for the TRD-020 (commit 4144a53) test-isolation
 * fix: `scripts/generate-codex/index.js`'s `copyAdapterSkills`, `generateCommandSkills`, and
 * `vendorCodexToolchain` previously had no way to point their glob-sourced `packagesDir` or
 * their write/delete-target `outputDir` anywhere but the live repository tree, so their "live
 * smoke run" tests had no choice but to create throwaway `packages/__*__` fixture packages and
 * write/delete real output under `packages/codex/.codex/` -- tripping `lint-model-ids` and, via
 * a real-fixture `afterAll` deleting the real vendor tree, losing 35 tracked files.
 *
 * Those three functions now accept `packagesDir`/`outputDir`/`rootDir` overrides (defaulting to
 * the real repo paths, so `main()` -- which never passes overrides -- is byte-identical to
 * before). This helper builds an isolated `os.tmpdir()`-rooted mirror of just enough of the
 * `packages/**` layout for those overrides to point at, so a caller can:
 *
 * ```
 * <root>/node_modules                              -> symlink to <repoRoot>/node_modules
 * <root>/packages/<fixture-or-copied-package>/...
 * <root>/packages/codex/.codex/...                  (generator output lands here)
 * ```
 *
 * `<root>` lives entirely under `os.tmpdir()`, never inside the live repository tree, mirroring
 * `scripts/tests/fixtures/toolchain/mutant-toolchain-copy.js`'s `makeMutantToolchainRoot()`:
 * the `node_modules` symlink is created before anything is written so a later
 * `child_process.execFileSync` run of the vendored `toolchain-cli.js` (whose `require('ajv')` /
 * `require('js-yaml')` resolve via Node's normal upward node_modules walk) finds this monorepo's
 * real, hoisted `node_modules` without copying it. `cleanup()` removes the symlink itself
 * (never the `node_modules` directory it points at) before removing the rest of the copy.
 *
 * `seedFile(relPath)` copies a single real file (read-only source, e.g. a pre-existing
 * `packages/development/commands/fix-issue.yaml` or an already-generated
 * `packages/codex/.codex/skills/react/SKILL.md`) into the identical relative path under
 * `<root>`, so byte-identical/no-regression assertions that depend on real repo content keep
 * their meaning without ever reading, writing, or deleting that content in place.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..', '..', '..');
const REPO_NODE_MODULES = path.join(REPO_ROOT, 'node_modules');

function makeCodexTempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-generate-'));

  // Symlink FIRST, before anything is required/executed from inside the copy: a vendored
  // toolchain-cli.js run via child_process needs this to already exist for its upward
  // node_modules walk to succeed.
  const nodeModulesLink = path.join(root, 'node_modules');
  fs.symlinkSync(REPO_NODE_MODULES, nodeModulesLink, 'dir');

  const packagesDir = path.join(root, 'packages');
  const outputDir = path.join(packagesDir, 'codex', '.codex');
  fs.mkdirSync(packagesDir, { recursive: true });

  return {
    root,
    packagesDir,
    outputDir,
    rootDir: root,

    /**
     * Copy a real repo file (read-only source) to the same relative path under this temp
     * root, creating intermediate directories as needed. Returns the destination path.
     */
    seedFile(relPath) {
      const src = path.join(REPO_ROOT, relPath);
      const dest = path.join(root, relPath);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
      return dest;
    },

    cleanup() {
      try {
        fs.rmSync(nodeModulesLink, { force: true });
      } catch {
        // already gone
      }
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

module.exports = { makeCodexTempRoot, REPO_ROOT };
