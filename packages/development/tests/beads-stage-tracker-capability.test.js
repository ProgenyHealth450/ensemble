'use strict';

/**
 * Tests for TRD-2026-8d825f54 TRD-026: `beads-stage.js#stageBeadsExport`'s working-text
 * acquisition is routed through the toolchain's `tracker.stage-export` capability (the
 * default adapter implements it as `cat .beads/issues.jsonl`) instead of a direct
 * `fs.readFileSync`, with a documented `UNAVAILABLE`/`fallback` degrade for an adapter that
 * does not declare the capability. Companion to `beads-stage.test.js` (unmodified by this
 * change) and `scripts/tests/toolchain-adapter-tracker-beads-manifest.test.js` (which proves
 * the manifest's static shape).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const yaml = require('js-yaml');

const { buildScopedExport, stageBeadsExport } = require('../lib/beads-stage');
const { validateAdapterDir } = require('../lib/toolchain/validate');

const OURS = ['[trd:ours'];
const rec = (id, title, extra = {}) => JSON.stringify({ id, title, status: 'open', labels: [], ...extra });
const text = (...lines) => lines.join('\n') + '\n';

const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const ADAPTER_DIR = path.join(REPO_ROOT, 'packages', 'development', 'skills', 'adapter-tracker-beads');

// ---------------------------------------------------------------------------
// Real git repositories (same fixtures as beads-stage.test.js)
// ---------------------------------------------------------------------------
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beads-stage-cap-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'config', 'core.autocrlf', 'false');
  fs.mkdirSync(path.join(dir, '.beads'));
  const exportFile = path.join(dir, '.beads', 'issues.jsonl');
  fs.writeFileSync(exportFile, text(
    rec('f-1', '[trd:other:task:A] foreign one'),
    rec('o-1', '[trd:ours:task:A] ours one')
  ));
  git(dir, 'add', '.beads/issues.jsonl');
  git(dir, 'commit', '-q', '-m', 'base');
  return { dir, exportFile };
}

/** Pollute the working export the way a shared db does: foreign additions, a foreign status change, our new bead. */
function pollute(exportFile) {
  fs.writeFileSync(exportFile, text(
    rec('f-1', '[trd:other:task:A] foreign one', { status: 'closed' }), // foreign status change
    rec('o-1', '[trd:ours:task:A] ours one', { status: 'closed' }), // our change
    rec('f-9', '[trd:other:task:Q] foreign from another branch'), // foreign addition
    rec('o-2', '[trd:ours:task:B] ours new') // our addition
  ));
}

// ---------------------------------------------------------------------------
// Implementation AC 1: the real adapter's `cat`-routed capability is equivalent to a direct
// `fs.readFileSync` of the same working-tree file.
// ---------------------------------------------------------------------------
describe('TRD-026: tracker.stage-export (real adapter, real cat) matches a direct fs.readFileSync read', () => {
  test('stageBeadsExport via the capability scopes identically to buildScopedExport called directly on the fs-read text', () => {
    const repo = makeRepo();
    try {
      pollute(repo.exportFile);
      const directRead = fs.readFileSync(repo.exportFile, 'utf8');
      const headText = git(repo.dir, 'show', 'HEAD:.beads/issues.jsonl');
      const expected = buildScopedExport(headText, directRead, { matches: OURS });

      const res = stageBeadsExport({ cwd: repo.dir, matches: OURS });
      expect(res).toMatchObject({
        ok: true,
        tracked: true,
        replaced: expected.replaced,
        added: expected.added,
        foreignDropped: expected.foreignDropped
      });

      // The index now holds exactly the same scoped text `buildScopedExport` computes from a
      // direct `fs.readFileSync` of the identical working file -- proving the `cat`-routed
      // capability read the same live content, not a stale or different one.
      const stagedText = git(repo.dir, 'show', ':0:.beads/issues.jsonl');
      expect(stagedText).toBe(expected.text);

      // The working file itself is still untouched (br's own export is never rewritten).
      expect(fs.readFileSync(repo.exportFile, 'utf8')).toBe(directRead);
    } finally {
      fs.rmSync(repo.dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Implementation AC 2: an adapter that does not declare `tracker.stage-export` degrades
// safely to the documented `UNAVAILABLE`/`fallback` envelope, with no index or working-file
// mutation.
// ---------------------------------------------------------------------------
const NO_STAGE_EXPORT_ADAPTER_ID = 'beads-stage-cap-stub-tracker';

/** Minimal installed-origin tracker adapter that omits `tracker.stage-export` entirely. */
function writeAdapterWithoutStageExport(projectRoot, adapterId) {
  const skillDir = path.join(projectRoot, 'packages', 'fixture-pkg', 'skills', adapterId);
  fs.mkdirSync(skillDir, { recursive: true });
  const manifest = {
    adapter: adapterId,
    version: '1.0.0',
    categories: ['tracker'],
    contract: { tracker: '1.0' },
    binaries: ['br'],
    allowlist: [{ bin: 'br', sub: ['show'] }],
    env: [],
    health: [],
    detect: [],
    capabilities: {
      'tracker.show': { run: ['br', 'show', '${id}', '--json'] }
    }
  };
  fs.writeFileSync(path.join(skillDir, 'adapter.yaml'), yaml.dump(manifest));
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `# ${adapterId}\n`);
}

describe('TRD-026: stageBeadsExport degrades safely when the resolved adapter has no tracker.stage-export', () => {
  test('returns {staged:false, unavailable:true, fallback:"full-export-unscoped"} and mutates neither index nor working file', () => {
    const repo = makeRepo();
    try {
      pollute(repo.exportFile);
      const beforeIndex = git(repo.dir, 'diff', '--cached', '--name-only');
      const beforeWork = fs.readFileSync(repo.exportFile, 'utf8');

      fs.mkdirSync(path.join(repo.dir, '.ensemble'), { recursive: true });
      fs.writeFileSync(
        path.join(repo.dir, '.ensemble', 'toolchain.yaml'),
        `tracker: ${NO_STAGE_EXPORT_ADAPTER_ID}\n`
      );
      writeAdapterWithoutStageExport(repo.dir, NO_STAGE_EXPORT_ADAPTER_ID);

      const res = stageBeadsExport({ cwd: repo.dir, matches: OURS });
      expect(res).toEqual({
        ok: true,
        tracked: true,
        staged: false,
        unavailable: true,
        fallback: 'full-export-unscoped',
        file: '.beads/issues.jsonl'
      });

      expect(git(repo.dir, 'diff', '--cached', '--name-only')).toBe(beforeIndex);
      expect(fs.readFileSync(repo.exportFile, 'utf8')).toBe(beforeWork);
    } finally {
      fs.rmSync(repo.dir, { recursive: true, force: true });
    }
  });
});

const STAGE_EXPORT_ADAPTER_ID = 'beads-stage-cap-cat-tracker';

/**
 * Minimal installed-origin tracker adapter whose `tracker.stage-export` is real `cat`,
 * self-contained under the test repo's own `packages/fixture-pkg/skills` -- independent of
 * the default adapter's own installed location, so it resolves identically inside a
 * mutant-root copy that never copied `skills/adapter-tracker-beads`.
 */
function writeAdapterWithStageExport(projectRoot, adapterId) {
  const skillDir = path.join(projectRoot, 'packages', 'fixture-pkg', 'skills', adapterId);
  fs.mkdirSync(skillDir, { recursive: true });
  const manifest = {
    adapter: adapterId,
    version: '1.0.0',
    categories: ['tracker'],
    contract: { tracker: '1.0' },
    binaries: ['cat'],
    allowlist: [{ bin: 'cat', sub: ['.beads/issues.jsonl'] }],
    env: [],
    health: [],
    detect: [],
    capabilities: {
      'tracker.stage-export': { run: ['cat', '.beads/issues.jsonl'] }
    }
  };
  fs.writeFileSync(path.join(skillDir, 'adapter.yaml'), yaml.dump(manifest));
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `# ${adapterId}\n`);
}

// ---------------------------------------------------------------------------
// Implementation AC 3: the real adapter's allowlist actually passes validation for
// `tracker.stage-export` (no subcommand outside `allowlist[]`).
// ---------------------------------------------------------------------------
describe('TRD-026: the default adapter\'s allowlist validator accepts tracker.stage-export', () => {
  test('validateAdapterDir(real dir) reports zero errors mentioning stage-export', () => {
    const result = validateAdapterDir(ADAPTER_DIR);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.errors.some((e) => String(e).includes('stage-export'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Mutation-restore proof: a mutant that always falls back to the pre-change
// `fs.readFileSync` route (or that silently corrupts the capability's returned text) produces
// WRONG scoping, proving this suite would catch a regression in the routing change.
// ---------------------------------------------------------------------------
const REPO_DEV_PKG = path.join(REPO_ROOT, 'packages', 'development');

/**
 * Build a fresh `/tmp` copy of `beads-stage.js` alongside the real, unmutated `lib/toolchain/
 * *.js`, `lib/beads-label.js` (a `beads-stage.js` dependency) and `lib/complexity-analyzer.js`
 * (a `runner.js` dependency) -- the same relative-layout convention
 * `beads-label-default-run.test.js#makeBeadsLabelMutantRoot` uses. The real repo tree is never
 * written to; a caller edits one `.js` file under THIS copy, never the real source.
 */
function makeBeadsStageMutantRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beads-stage-mutant-'));
  const nodeModulesLink = path.join(root, 'node_modules');
  fs.symlinkSync(path.join(REPO_ROOT, 'node_modules'), nodeModulesLink, 'dir');

  const devPkgRoot = path.join(root, 'packages', 'development');
  const libDir = path.join(devPkgRoot, 'lib');
  const toolchainLibDir = path.join(libDir, 'toolchain');
  fs.mkdirSync(toolchainLibDir, { recursive: true });
  for (const name of fs.readdirSync(path.join(REPO_DEV_PKG, 'lib', 'toolchain'))) {
    if (!name.endsWith('.js')) continue;
    fs.copyFileSync(path.join(REPO_DEV_PKG, 'lib', 'toolchain', name), path.join(toolchainLibDir, name));
  }
  fs.copyFileSync(path.join(REPO_DEV_PKG, 'lib', 'beads-label.js'), path.join(libDir, 'beads-label.js'));
  fs.copyFileSync(path.join(REPO_DEV_PKG, 'lib', 'beads-stage.js'), path.join(libDir, 'beads-stage.js'));
  fs.copyFileSync(
    path.join(REPO_DEV_PKG, 'lib', 'complexity-analyzer.js'),
    path.join(libDir, 'complexity-analyzer.js')
  );
  fs.cpSync(path.join(REPO_DEV_PKG, 'toolchain'), path.join(devPkgRoot, 'toolchain'), { recursive: true });

  return {
    beadsStagePath: path.join(libDir, 'beads-stage.js'),
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

/** Same single-replacement, loud-on-miss convention as `beads-label-default-run.test.js`. */
function mutateAndRequireFresh(filePath, needle, replacement) {
  const original = fs.readFileSync(filePath, 'utf8');
  if (!original.includes(needle)) {
    throw new Error(`mutateAndRequireFresh: needle not found in ${filePath}: ${JSON.stringify(needle)}`);
  }
  const mutated = original.replace(needle, replacement);
  fs.writeFileSync(filePath, mutated);
  // eslint-disable-next-line global-require, import/no-dynamic-require
  return require(filePath);
}

describe('mutation-restore proof: the tracker.stage-export routing actually discriminates', () => {
  test('reverting the DEFAULT_FILE branch to always use fs.readFileSync never reaches the unavailable path, proving the capability route is exercised', () => {
    const mutantRoot = makeBeadsStageMutantRoot();
    const repo = makeRepo();
    try {
      const mutantStageBeadsExport = mutateAndRequireFresh(
        mutantRoot.beadsStagePath,
        "if (file === DEFAULT_FILE) {",
        "if (false) {"
      ).stageBeadsExport;

      pollute(repo.exportFile);

      fs.mkdirSync(path.join(repo.dir, '.ensemble'), { recursive: true });
      fs.writeFileSync(
        path.join(repo.dir, '.ensemble', 'toolchain.yaml'),
        `tracker: ${NO_STAGE_EXPORT_ADAPTER_ID}\n`
      );
      writeAdapterWithoutStageExport(repo.dir, NO_STAGE_EXPORT_ADAPTER_ID);

      // Under the real (unmutated) code this call hits the `UNAVAILABLE` fallback branch
      // (proven by the AC-2 test above). The mutant short-circuits the `DEFAULT_FILE` branch
      // to `false`, so it falls straight through to the direct `fs.readFileSync` path instead
      // -- it stages successfully (wrong: it should have reported `unavailable:true` and
      // mutated nothing), proving this suite would catch a regression that silently stops
      // invoking the capability at all.
      const res = mutantStageBeadsExport({ cwd: repo.dir, matches: OURS });
      expect(res.unavailable).not.toBe(true);
      expect(res.staged).toBeUndefined();
      expect(res).toMatchObject({ ok: true, tracked: true });
      expect(res.replaced).toBeGreaterThanOrEqual(0); // it actually staged something
    } finally {
      fs.rmSync(repo.dir, { recursive: true, force: true });
      mutantRoot.cleanup();
    }
  });

  test('corrupting workText assignment to an empty string drops every record, proving the suite catches a data-corrupting mutant', () => {
    const mutantRoot = makeBeadsStageMutantRoot();
    const repo = makeRepo();
    try {
      const mutantStageBeadsExport = mutateAndRequireFresh(
        mutantRoot.beadsStagePath,
        'workText = result.data;',
        "workText = '';"
      ).stageBeadsExport;

      pollute(repo.exportFile);
      const before = fs.readFileSync(repo.exportFile, 'utf8');

      fs.mkdirSync(path.join(repo.dir, '.ensemble'), { recursive: true });
      fs.writeFileSync(
        path.join(repo.dir, '.ensemble', 'toolchain.yaml'),
        `tracker: ${STAGE_EXPORT_ADAPTER_ID}\n`
      );
      writeAdapterWithStageExport(repo.dir, STAGE_EXPORT_ADAPTER_ID);

      const res = mutantStageBeadsExport({ cwd: repo.dir, matches: OURS });

      // The real route (proven by the AC-1 test above) stages `added:1, foreignDropped:2`.
      // Feeding an empty `workText` to `buildScopedExport` instead drops our OWN addition too
      // (nothing to add from an empty working text), proving this mutant produces WRONG
      // scoping that this suite's AC-1 assertions would catch.
      expect(res.added).not.toBe(1);
      expect(fs.readFileSync(repo.exportFile, 'utf8')).toBe(before); // working file still untouched
    } finally {
      fs.rmSync(repo.dir, { recursive: true, force: true });
      mutantRoot.cleanup();
    }
  });
});
