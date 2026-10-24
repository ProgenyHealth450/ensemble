'use strict';
/**
 * Tests for `worktree.list` returning one `worktrees` array entry per real registered worktree
 * (TRD-2026-8d825f54 PR 10 fix round, item 5): `packages/git/skills/adapter-worktree-plain-git/
 * adapter.yaml`'s `worktree.list` used to run `git worktree list --porcelain`, whose real
 * output is multi-line BLOCKS per worktree (a `worktree <path>` line, then `HEAD <sha>`, then
 * `branch <ref>`-or-`detached`, separated by a blank line) -- `mapping.js`'s `'lines'` format
 * has no per-block grouping primitive, so it flattened every worktree's 3-4 lines into one
 * shared array with no boundary between worktrees. The capability now runs plain `git worktree
 * list` (no flag), whose real output is exactly ONE line per worktree, so `parse.format: lines`
 * already yields one array entry per worktree with no engine change needed.
 *
 * Real `git` is spawned here (read-only `git worktree list`, never a side-effecting
 * create/remove/prune) against this actual repository's own real worktrees, the same
 * live-verification convention this adapter's own `SKILL.md`/`adapter.yaml` comments already
 * use and document.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const yaml = require('js-yaml');

const { runCapability } = require('../../packages/development/lib/toolchain/runner');

const REPO_ROOT = path.join(__dirname, '..', '..');
const MANIFEST_PATH = path.join(
  REPO_ROOT,
  'packages',
  'git',
  'skills',
  'adapter-worktree-plain-git',
  'adapter.yaml'
);

function loadRealManifest() {
  return yaml.load(fs.readFileSync(MANIFEST_PATH, 'utf8'));
}

/** Ground truth: how many worktrees `git` itself reports registered against this repo. */
function countRealWorktreesViaPorcelain() {
  const result = spawnSync('git', ['worktree', 'list', '--porcelain'], {
    cwd: REPO_ROOT,
    encoding: 'utf8'
  });
  // Each worktree's porcelain block starts with its own `worktree <path>` line.
  return result.stdout.split('\n').filter((line) => line.startsWith('worktree ')).length;
}

describe('worktree.list: one entry per worktree (real git subprocess, no mock)', () => {
  test("the real adapter.yaml's worktree.list run template no longer declares --porcelain", () => {
    const manifest = loadRealManifest();
    expect(manifest.capabilities['worktree.list'].run).toEqual(['git', 'worktree', 'list']);
  });

  test('runCapability(worktree.list) against this real repo returns exactly one worktrees entry per real registered worktree', async () => {
    const manifest = loadRealManifest();
    const expectedCount = countRealWorktreesViaPorcelain();
    expect(expectedCount).toBeGreaterThan(0);

    const result = await runCapability(manifest, 'worktree.list', {}, { execFileOptions: { cwd: REPO_ROOT } });

    expect(result.ok).toBe(true);
    expect(Array.isArray(result.data.worktrees)).toBe(true);
    expect(result.data.worktrees).toHaveLength(expectedCount);
    // Every entry carries its own path and sha on one line -- never a bare `HEAD ...`/
    // `branch ...`/`detached` continuation fragment split off into its own array entry (the
    // `--porcelain` bug this fix removes).
    for (const line of result.data.worktrees) {
      expect(line).not.toMatch(/^HEAD /);
      expect(line).not.toMatch(/^branch /);
      expect(line).not.toBe('detached');
    }
  });

  describe('mutation proof (temp mutable copy of the real manifest, never the live repo source)', () => {
    test('reverting worktree.list back to --porcelain makes the same real repo report far MORE array entries than real worktrees (the pre-fix bug)', async () => {
      const manifest = loadRealManifest();
      manifest.capabilities['worktree.list'].run = ['git', 'worktree', 'list', '--porcelain'];

      const expectedCount = countRealWorktreesViaPorcelain();
      const result = await runCapability(manifest, 'worktree.list', {}, { execFileOptions: { cwd: REPO_ROOT } });

      expect(result.ok).toBe(true);
      // Porcelain emits 3-4 lines per worktree (worktree/HEAD/branch-or-detached, occasionally
      // more), so the flattened array is always strictly more than one entry per worktree --
      // the exact regression this fix removes.
      expect(result.data.worktrees.length).toBeGreaterThan(expectedCount * 2);
    });
  });
});
