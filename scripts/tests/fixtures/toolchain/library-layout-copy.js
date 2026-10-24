'use strict';

/**
 * Shared test helper (NOT a test file itself) for mutation-proof tests of
 * `packages/development/lib/toolchain/adapters.js`'s library-relative installed-tier
 * discovery (TRD-2026-8d825f54 TRD-006, PR 5 independent review).
 *
 * Unlike `./mutant-toolchain-copy.js#makeMutantToolchainRoot()` (which always reproduces the
 * monorepo-source `<root>/packages/development/lib/toolchain` shape), this helper builds a
 * fresh copy of just `lib/toolchain/`'s `.js` files at the LITERAL relative directory names
 * `./adapters.js#matchLibraryLocationTail`/`LIBRARY_LOCATION_TAILS` actually recognize, for
 * any one of the four shipped layouts -- so a mutation test can `require()` the copy's own
 * `adapters.js` and observe `discoverAdapters`/`loadAdapter` behave as if it were really
 * running from that layout, including the real `adapter-tracker-beads` skill at the correct
 * sibling position when `includeAdapterSkills` is set.
 *
 * `config.js`/`config-path.js` (and every other `.js` file in `lib/toolchain/`) are copied
 * alongside `adapters.js` since it `require()`s them by relative path; `js-yaml`/`ajv` resolve
 * via the `node_modules` symlink, exactly like `mutant-toolchain-copy.js`.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..', '..', '..');
const REPO_DEV_PKG = path.join(REPO_ROOT, 'packages', 'development');
const REPO_NODE_MODULES = path.join(REPO_ROOT, 'node_modules');
const REPO_ADAPTER_SKILL = path.join(REPO_DEV_PKG, 'skills', 'adapter-tracker-beads');

/**
 * The relative path segments (under a fresh package root) each layout's `lib/toolchain` copy
 * lives at, plus the single directory NAME its adapters' `skills` root sits at directly under
 * that same package root -- mirroring `LIBRARY_LOCATION_TAILS` exactly.
 */
const LAYOUTS = {
  source: { toolchainParent: [], skillsDirName: 'skills' },
  pi: { toolchainParent: ['vendor'], skillsDirName: 'skills' },
  codex: { toolchainParent: ['skills', 'vendor'], skillsDirName: 'skills' },
  opencode: { toolchainParent: ['skill', 'vendor'], skillsDirName: 'skill' }
};

/**
 * @param {'source'|'pi'|'codex'|'opencode'} layout
 * @param {{includeAdapterSkills?: boolean}} [options]
 * @returns {{root: string, adaptersPath: string, toolchainLibDir: string,
 *   skillsRoot: string, cleanup: () => void}}
 */
function makeLibraryLayoutCopy(layout, options = {}) {
  const { includeAdapterSkills = false } = options;
  const shape = LAYOUTS[layout];
  if (!shape) {
    throw new Error(`makeLibraryLayoutCopy: unknown layout '${layout}'`);
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), `toolchain-layout-${layout}-`));
  const nodeModulesLink = path.join(root, 'node_modules');
  fs.symlinkSync(REPO_NODE_MODULES, nodeModulesLink, 'dir');

  const pkgRoot = path.join(root, 'pkg');
  const toolchainLibDir = path.join(pkgRoot, ...shape.toolchainParent, 'lib', 'toolchain');
  fs.mkdirSync(toolchainLibDir, { recursive: true });
  for (const name of fs.readdirSync(path.join(REPO_DEV_PKG, 'lib', 'toolchain'))) {
    if (!name.endsWith('.js')) continue;
    fs.copyFileSync(path.join(REPO_DEV_PKG, 'lib', 'toolchain', name), path.join(toolchainLibDir, name));
  }

  const skillsRoot = path.join(pkgRoot, shape.skillsDirName);
  if (includeAdapterSkills) {
    fs.cpSync(REPO_ADAPTER_SKILL, path.join(skillsRoot, 'adapter-tracker-beads'), { recursive: true });
  }

  return {
    root,
    adaptersPath: path.join(toolchainLibDir, 'adapters.js'),
    toolchainLibDir,
    skillsRoot,
    cleanup: () => {
      try {
        fs.rmSync(nodeModulesLink, { force: true });
      } catch {
        // already gone
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

module.exports = { makeLibraryLayoutCopy };
