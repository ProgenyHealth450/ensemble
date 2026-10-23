'use strict';
/**
 * Tests for TRD-2026-8d825f54 TRD-016: `detectAdapter(category, ctx)` in
 * packages/development/lib/toolchain/detect.js (PRD REQ-010, AC-010-1, AC-010-2), plus its
 * production wiring into `packages/development/lib/toolchain-cli.js`'s `main()` default ctx.
 *
 * Covers the bead's four implementation ACs:
 *   1. a remote matching an installed adapter's `remote_url_matches` signal resolves that
 *      adapter with `source:'detection'`.
 *   2. a remote matching no installed adapter's signal (and no config) throws
 *      `AMBIGUOUS_PROVIDER` naming the category and `.ensemble/toolchain.yaml`.
 *   3. no remote and no marker files resolves to the shipped default with `source:'default'`
 *      and no error (I2), exercised end-to-end through `resolveCategory`.
 *   4. two installed adapters both matching the remote throw `AMBIGUOUS_PROVIDER` listing both
 *      adapter names.
 * ...plus the realistic edge cases the bead calls out explicitly: the "no `.git` repo at all"
 * (silent default) vs "`.git` repo with an unmatched remote" (ambiguous) distinction, OR-across-
 * signals semantics, `detect: []` never matching on its own, category filtering, `file_exists`/
 * `dir_exists`/`git_config_set` signal evaluation, path-traversal rejection, the worktree
 * gitlink (`.git` file + `commondir`) resolution this very repository exercises in production,
 * and production reachability through `toolchain-cli.js`'s `main()`.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');
const { execFileSync, spawnSync } = require('child_process');

const { detectAdapter } = require('../../packages/development/lib/toolchain/detect');
const { resolveCategory } = require('../../packages/development/lib/toolchain/config');
const { main } = require('../../packages/development/lib/toolchain-cli');
const {
  makeMutantToolchainRoot,
  mutateAndRequire
} = require('./fixtures/toolchain/mutant-toolchain-copy');

const CLI = path.join(__dirname, '..', '..', 'packages', 'development', 'lib', 'toolchain-cli.js');

const tempDirs = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

function mkTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function initGitRepo(dir) {
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
}

function setGitRemote(dir, url) {
  execFileSync('git', ['remote', 'add', 'origin', url], { cwd: dir, stdio: 'ignore' });
}

function setGitConfig(dir, key, value) {
  execFileSync('git', ['config', key, value], { cwd: dir, stdio: 'ignore' });
}

/** A minimal, schema-shaped adapter manifest (no `detect:` populated unless overridden). */
function fixtureManifest(overrides = {}) {
  return {
    adapter: 'fixture-adapter',
    version: '1.0.0',
    categories: ['host'],
    contract: { host: '1.0' },
    binaries: ['fixture-tool'],
    allowlist: [{ bin: 'fixture-tool', sub: ['show'] }],
    env: [],
    health: [],
    detect: [],
    capabilities: {
      'host.show': {
        run: ['fixture-tool', 'show'],
        parse: { format: 'json', root: '$' }
      }
    },
    ...overrides
  };
}

/**
 * Install a fixture adapter under `<projectRoot>/packages/<packageName>/skills/<adapterDirName>`
 * -- the "installed" discovery root, which `loadAdapter` never subjects to the repo-local
 * untrusted-adapter trust check (TRD interpretation I5), so fixtures stay simple.
 */
function writeInstalledAdapter(projectRoot, packageName, adapterDirName, manifest) {
  const dir = path.join(projectRoot, 'packages', packageName, 'skills', adapterDirName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'adapter.yaml'), yaml.dump(manifest));
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '# Fixture Adapter\n');
  return dir;
}

function captureStdout(fn) {
  const chunks = [];
  const spy = jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    chunks.push(chunk);
    return true;
  });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return chunks.join('');
}

describe('AC-010-1/AC1: remote matches an installed adapter signal', () => {
  test('resolveCategory returns the matching adapter with source detection', () => {
    const projectRoot = mkTempDir('toolchain-detect-ac1-');
    initGitRepo(projectRoot);
    setGitRemote(projectRoot, 'https://github.com/example/repo.git');

    writeInstalledAdapter(
      projectRoot,
      'fixture-pkg',
      'github-fixture',
      fixtureManifest({
        adapter: 'github-fixture',
        categories: ['host'],
        detect: [{ signal: 'remote_url_matches', pattern: 'github\\.com' }]
      })
    );

    const result = resolveCategory('host', { projectRoot, env: {}, detect: detectAdapter });

    expect(result).toEqual({ value: 'github-fixture', source: 'detection' });
  });
});

describe('AC-010-2/AC2: remote matches no installed adapter signal', () => {
  test('throws AMBIGUOUS_PROVIDER naming the category and .ensemble/toolchain.yaml', () => {
    const projectRoot = mkTempDir('toolchain-detect-ac2-');
    initGitRepo(projectRoot);
    setGitRemote(projectRoot, 'https://example.invalid/x.git');

    writeInstalledAdapter(
      projectRoot,
      'fixture-pkg',
      'github-fixture',
      fixtureManifest({
        adapter: 'github-fixture',
        categories: ['host'],
        detect: [{ signal: 'remote_url_matches', pattern: 'github\\.com' }]
      })
    );

    let thrown;
    try {
      resolveCategory('host', { projectRoot, env: {}, detect: detectAdapter });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeDefined();
    expect(thrown.code).toBe('AMBIGUOUS_PROVIDER');
    expect(thrown.message).toContain('host');
    expect(thrown.message).toContain('.ensemble/toolchain.yaml');
  });
});

describe('AC3: no .git repo and no marker files', () => {
  test('resolveCategory falls through to the shipped default with source default, no error (I2)', () => {
    const projectRoot = mkTempDir('toolchain-detect-ac3-');
    // Deliberately no `git init` and no marker files at all.

    writeInstalledAdapter(
      projectRoot,
      'fixture-pkg',
      'github-fixture',
      fixtureManifest({
        adapter: 'github-fixture',
        categories: ['host'],
        detect: [{ signal: 'remote_url_matches', pattern: 'github\\.com' }]
      })
    );

    const result = resolveCategory('host', { projectRoot, env: {}, detect: detectAdapter });

    expect(result.source).toBe('default');
    expect(typeof result.value).toBe('string');
  });
});

describe('AC4: two installed adapters both match the remote', () => {
  test('AMBIGUOUS_PROVIDER lists both adapter names', () => {
    const projectRoot = mkTempDir('toolchain-detect-ac4-');
    initGitRepo(projectRoot);
    setGitRemote(projectRoot, 'https://github.com/example/repo.git');

    writeInstalledAdapter(
      projectRoot,
      'fixture-pkg-a',
      'github-fixture-a',
      fixtureManifest({
        adapter: 'github-fixture-a',
        categories: ['host'],
        detect: [{ signal: 'remote_url_matches', pattern: 'github\\.com' }]
      })
    );
    writeInstalledAdapter(
      projectRoot,
      'fixture-pkg-b',
      'github-fixture-b',
      fixtureManifest({
        adapter: 'github-fixture-b',
        categories: ['host'],
        detect: [{ signal: 'remote_url_matches', pattern: 'github\\.com' }]
      })
    );

    let thrown;
    try {
      detectAdapter('host', { projectRoot, env: {} });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeDefined();
    expect(thrown.code).toBe('AMBIGUOUS_PROVIDER');
    expect(thrown.message).toContain('github-fixture-a');
    expect(thrown.message).toContain('github-fixture-b');
  });
});

describe('no-repo vs unmatched-remote distinction (I2)', () => {
  test('a git repo with no origin remote configured is treated the same as no signal source: shipped default, no error', () => {
    const projectRoot = mkTempDir('toolchain-detect-no-remote-');
    initGitRepo(projectRoot); // `git init` only -- no `remote add`.

    writeInstalledAdapter(
      projectRoot,
      'fixture-pkg',
      'github-fixture',
      fixtureManifest({
        adapter: 'github-fixture',
        categories: ['host'],
        detect: [{ signal: 'remote_url_matches', pattern: 'github\\.com' }]
      })
    );

    const result = resolveCategory('host', { projectRoot, env: {}, detect: detectAdapter });

    expect(result.source).toBe('default');
  });
});

describe('detect signal types', () => {
  test('file_exists signal detects a marker file within projectRoot', () => {
    const projectRoot = mkTempDir('toolchain-detect-file-exists-');
    fs.writeFileSync(path.join(projectRoot, 'Gemfile'), '');

    writeInstalledAdapter(
      projectRoot,
      'fixture-pkg',
      'rails-fixture',
      fixtureManifest({
        adapter: 'rails-fixture',
        categories: ['host'],
        detect: [{ signal: 'file_exists', path: 'Gemfile' }]
      })
    );

    const result = resolveCategory('host', { projectRoot, env: {}, detect: detectAdapter });

    expect(result).toEqual({ value: 'rails-fixture', source: 'detection' });
  });

  test('file_exists does not match when the path is a directory, not a file', () => {
    const projectRoot = mkTempDir('toolchain-detect-file-exists-isdir-');
    fs.mkdirSync(path.join(projectRoot, 'Gemfile'));

    writeInstalledAdapter(
      projectRoot,
      'fixture-pkg',
      'rails-fixture',
      fixtureManifest({
        adapter: 'rails-fixture',
        categories: ['host'],
        detect: [{ signal: 'file_exists', path: 'Gemfile' }]
      })
    );

    const result = resolveCategory('host', { projectRoot, env: {}, detect: detectAdapter });

    expect(result.source).toBe('default');
  });

  test('dir_exists signal detects a marker directory within projectRoot', () => {
    const projectRoot = mkTempDir('toolchain-detect-dir-exists-');
    fs.mkdirSync(path.join(projectRoot, '.terraform'));

    writeInstalledAdapter(
      projectRoot,
      'fixture-pkg',
      'iac-fixture',
      fixtureManifest({
        adapter: 'iac-fixture',
        categories: ['iac'],
        detect: [{ signal: 'dir_exists', path: '.terraform' }]
      })
    );

    const result = resolveCategory('iac', { projectRoot, env: {}, detect: detectAdapter });

    expect(result).toEqual({ value: 'iac-fixture', source: 'detection' });
  });

  test('git_config_set signal detects a configured git-town main-branch key', () => {
    const projectRoot = mkTempDir('toolchain-detect-git-config-');
    initGitRepo(projectRoot);
    setGitConfig(projectRoot, 'git-town.main-branch', 'main');

    writeInstalledAdapter(
      projectRoot,
      'fixture-pkg',
      'git-town-fixture',
      fixtureManifest({
        adapter: 'git-town-fixture',
        categories: ['workflow'],
        detect: [{ signal: 'git_config_set', key: 'git-town.main-branch' }]
      })
    );

    const result = resolveCategory('workflow', { projectRoot, env: {}, detect: detectAdapter });

    expect(result).toEqual({ value: 'git-town-fixture', source: 'detection' });
  });

  test('git_config_set does not match an absent key', () => {
    const projectRoot = mkTempDir('toolchain-detect-git-config-absent-');
    initGitRepo(projectRoot);

    writeInstalledAdapter(
      projectRoot,
      'fixture-pkg',
      'git-town-fixture',
      fixtureManifest({
        adapter: 'git-town-fixture',
        categories: ['workflow'],
        detect: [{ signal: 'git_config_set', key: 'git-town.main-branch' }]
      })
    );

    const result = resolveCategory('workflow', { projectRoot, env: {}, detect: detectAdapter });

    expect(result.source).toBe('default');
  });

  test('resolves the origin remote through a worktree gitlink (.git file) whose commondir points at the main repo config', () => {
    const mainGitDir = mkTempDir('toolchain-detect-worktree-main-git-');
    fs.writeFileSync(
      path.join(mainGitDir, 'config'),
      '[remote "origin"]\n\turl = https://github.com/example/repo.git\n'
    );

    const worktreeGitDir = mkTempDir('toolchain-detect-worktree-git-');
    fs.writeFileSync(path.join(worktreeGitDir, 'commondir'), `${mainGitDir}\n`);

    const projectRoot = mkTempDir('toolchain-detect-worktree-project-');
    fs.writeFileSync(path.join(projectRoot, '.git'), `gitdir: ${worktreeGitDir}\n`);

    writeInstalledAdapter(
      projectRoot,
      'fixture-pkg',
      'github-fixture',
      fixtureManifest({
        adapter: 'github-fixture',
        categories: ['host'],
        detect: [{ signal: 'remote_url_matches', pattern: 'github\\.com' }]
      })
    );

    const result = resolveCategory('host', { projectRoot, env: {}, detect: detectAdapter });

    expect(result).toEqual({ value: 'github-fixture', source: 'detection' });
  });
});

describe('mutation-proof branches', () => {
  test('OR semantics: a candidate matches when ANY declared signal matches, not only the first', () => {
    const projectRoot = mkTempDir('toolchain-detect-or-semantics-');
    initGitRepo(projectRoot);
    setGitConfig(projectRoot, 'git-town.main-branch', 'main');

    writeInstalledAdapter(
      projectRoot,
      'fixture-pkg',
      'multi-signal-fixture',
      fixtureManifest({
        adapter: 'multi-signal-fixture',
        categories: ['workflow'],
        detect: [
          { signal: 'dir_exists', path: 'does-not-exist' },
          { signal: 'git_config_set', key: 'git-town.main-branch' }
        ]
      })
    );

    const result = resolveCategory('workflow', { projectRoot, env: {}, detect: detectAdapter });

    expect(result).toEqual({ value: 'multi-signal-fixture', source: 'detection' });
  });

  test('an adapter with detect: [] never matches on its own (no repo signal, e.g. Jira)', () => {
    const projectRoot = mkTempDir('toolchain-detect-empty-signal-');

    writeInstalledAdapter(
      projectRoot,
      'fixture-pkg',
      'jira-fixture',
      fixtureManifest({
        adapter: 'jira-fixture',
        categories: ['tracker'],
        detect: []
      })
    );

    const result = resolveCategory('tracker', { projectRoot, env: {}, detect: detectAdapter });

    expect(result.source).toBe('default');
  });

  test('a matching adapter that does not declare the requested category is excluded (category filter)', () => {
    const projectRoot = mkTempDir('toolchain-detect-category-filter-');
    initGitRepo(projectRoot);
    setGitRemote(projectRoot, 'https://github.com/example/repo.git');

    writeInstalledAdapter(
      projectRoot,
      'fixture-pkg',
      'github-fixture',
      fixtureManifest({
        adapter: 'github-fixture',
        categories: ['host'],
        detect: [{ signal: 'remote_url_matches', pattern: 'github\\.com' }]
      })
    );

    const result = resolveCategory('tracker', { projectRoot, env: {}, detect: detectAdapter });

    expect(result.source).toBe('default');
  });

  test('a file_exists signal whose path escapes projectRoot never matches (fail closed, no throw)', () => {
    const projectRoot = mkTempDir('toolchain-detect-traversal-project-');
    const outsideDir = mkTempDir('toolchain-detect-traversal-outside-');
    fs.writeFileSync(path.join(outsideDir, 'secret'), '');

    const escapingRelativePath = path.relative(projectRoot, path.join(outsideDir, 'secret'));
    expect(escapingRelativePath.startsWith('..')).toBe(true);

    writeInstalledAdapter(
      projectRoot,
      'fixture-pkg',
      'escape-fixture',
      fixtureManifest({
        adapter: 'escape-fixture',
        categories: ['host'],
        detect: [{ signal: 'file_exists', path: escapingRelativePath }]
      })
    );

    expect(() =>
      resolveCategory('host', { projectRoot, env: {}, detect: detectAdapter })
    ).not.toThrow();
    const result = resolveCategory('host', { projectRoot, env: {}, detect: detectAdapter });
    expect(result.source).toBe('default');
  });

  test('an invalid regex pattern in a remote_url_matches signal is caught internally and treated as no match (not a thrown parse error)', () => {
    const projectRoot = mkTempDir('toolchain-detect-bad-pattern-');
    initGitRepo(projectRoot); // No origin remote configured, so there is no signal source at
    // all and the result must be a silent default -- isolating the internal `new RegExp()`
    // catch from the separate (and separately tested) AMBIGUOUS_PROVIDER-on-unmatched-remote
    // branch.

    writeInstalledAdapter(
      projectRoot,
      'fixture-pkg',
      'bad-pattern-fixture',
      fixtureManifest({
        adapter: 'bad-pattern-fixture',
        categories: ['host'],
        detect: [{ signal: 'remote_url_matches', pattern: '(unterminated' }]
      })
    );

    let result;
    expect(() => {
      result = detectAdapter('host', { projectRoot, env: {} });
    }).not.toThrow();
    expect(result).toBeFalsy();
  });

  test('AMBIGUOUS_PROVIDER fires from the remote-signal-declared-but-unmatched gate even when no candidate directly matches by any signal (candidateDeclaresRemoteSignal)', () => {
    // Neither candidate below ever lands in `matched`: the marker adapter's `dir_exists`
    // target is never created, and the remote adapter's `remote_url_matches` pattern does not
    // match the configured origin. The only way this still throws `AMBIGUOUS_PROVIDER` (instead
    // of falling through to the shipped default) is the `candidateDeclaresRemoteSignal` flag at
    // detect.js:355 feeding the `originUrl && candidateDeclaresRemoteSignal` gate at line 376 --
    // proving that gate is reachable and load-bearing even when `matched.length === 0`.
    const projectRoot = mkTempDir('toolchain-detect-remote-gate-');
    initGitRepo(projectRoot);
    setGitRemote(projectRoot, 'https://gitlab.com/example/repo.git');

    writeInstalledAdapter(
      projectRoot,
      'fixture-pkg-marker',
      'marker-fixture',
      fixtureManifest({
        adapter: 'marker-fixture',
        categories: ['workflow'],
        detect: [{ signal: 'dir_exists', path: 'never-created-marker-dir' }]
      })
    );
    writeInstalledAdapter(
      projectRoot,
      'fixture-pkg-remote',
      'remote-fixture',
      fixtureManifest({
        adapter: 'remote-fixture',
        categories: ['workflow'],
        detect: [{ signal: 'remote_url_matches', pattern: 'github\\.com' }]
      })
    );

    let thrown;
    try {
      detectAdapter('workflow', { projectRoot, env: {} });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeDefined();
    expect(thrown.code).toBe('AMBIGUOUS_PROVIDER');
    expect(thrown.message).toContain('workflow');
  });

  test('an unrecognized signal type is treated as no-match, never a crash or a silent match (signalMatches default arm)', () => {
    const projectRoot = mkTempDir('toolchain-detect-unknown-signal-');
    initGitRepo(projectRoot);
    setGitRemote(projectRoot, 'https://github.com/example/repo.git');

    writeInstalledAdapter(
      projectRoot,
      'fixture-pkg',
      'unknown-signal-fixture',
      fixtureManifest({
        adapter: 'unknown-signal-fixture',
        categories: ['host'],
        detect: [{ signal: 'totally_unrecognized_signal_type', pattern: 'github\\.com' }]
      })
    );

    const result = resolveCategory('host', { projectRoot, env: {}, detect: detectAdapter });

    expect(result.source).toBe('default');
  });

  test('the same adapter id installed under two different package roots is deduplicated, never double-counted toward ambiguity', () => {
    const projectRoot = mkTempDir('toolchain-detect-dedup-');
    fs.mkdirSync(path.join(projectRoot, 'shared-marker'), { recursive: true });

    writeInstalledAdapter(
      projectRoot,
      'fixture-pkg-a',
      'dup-fixture',
      fixtureManifest({
        adapter: 'dup-fixture',
        categories: ['host'],
        detect: [{ signal: 'dir_exists', path: 'shared-marker' }]
      })
    );
    writeInstalledAdapter(
      projectRoot,
      'fixture-pkg-b',
      'dup-fixture-copy',
      fixtureManifest({
        adapter: 'dup-fixture',
        categories: ['host'],
        detect: [{ signal: 'dir_exists', path: 'shared-marker' }]
      })
    );

    const result = detectAdapter('host', { projectRoot, env: {} });

    expect(result).toEqual({ value: 'dup-fixture', source: 'detection' });
  });
});

describe('production wiring: main() uses the real detectAdapter via its unmodified default ctx', () => {
  test("toolchain-cli resolve --json detects a real adapter through main()'s omitted-ctx default (TRD-016 production reachability)", () => {
    const projectRoot = mkTempDir('toolchain-detect-main-wiring-');
    initGitRepo(projectRoot);
    setGitRemote(projectRoot, 'https://github.com/example/repo.git');

    writeInstalledAdapter(
      projectRoot,
      'fixture-pkg',
      'github-fixture',
      fixtureManifest({
        adapter: 'github-fixture',
        categories: ['host'],
        detect: [{ signal: 'remote_url_matches', pattern: 'github\\.com' }]
      })
    );

    // A fresh, empty XDG config root so this test's result can never depend on whatever
    // toolchain.yaml (if any) happens to exist on the machine actually running the suite.
    const xdgConfigHome = mkTempDir('toolchain-detect-main-wiring-xdg-');

    const originalCwd = process.cwd();
    const originalEnv = process.env;
    let stdout;
    try {
      process.env = { ...originalEnv, XDG_CONFIG_HOME: xdgConfigHome };
      process.chdir(projectRoot);
      stdout = captureStdout(() => {
        const code = main(['resolve', '--json']);
        expect(code).toBe(0);
      });
    } finally {
      process.chdir(originalCwd);
      process.env = originalEnv;
    }

    const parsed = JSON.parse(stdout.trim());
    expect(parsed.ok).toBe(true);
    expect(parsed.data.host).toEqual({ adapter: 'github-fixture', source: 'detection' });
  });

  test('an AMBIGUOUS_PROVIDER thrown by detection reaches toolchain-cli resolve --json with its original code, not RESOLVE_FAILED', () => {
    const projectRoot = mkTempDir('toolchain-detect-main-wiring-ambiguous-');
    initGitRepo(projectRoot);
    setGitRemote(projectRoot, 'https://example.invalid/x.git');

    writeInstalledAdapter(
      projectRoot,
      'fixture-pkg',
      'github-fixture',
      fixtureManifest({
        adapter: 'github-fixture',
        categories: ['host'],
        detect: [{ signal: 'remote_url_matches', pattern: 'github\\.com' }]
      })
    );

    const xdgConfigHome = mkTempDir('toolchain-detect-main-wiring-ambiguous-xdg-');

    const originalCwd = process.cwd();
    const originalEnv = process.env;
    let stdout;
    try {
      process.env = { ...originalEnv, XDG_CONFIG_HOME: xdgConfigHome };
      process.chdir(projectRoot);
      stdout = captureStdout(() => {
        const code = main(['resolve', '--json']);
        expect(code).toBe(1);
      });
    } finally {
      process.chdir(originalCwd);
      process.env = originalEnv;
    }

    const parsed = JSON.parse(stdout.trim());
    expect(parsed).toEqual({
      ok: false,
      error: { code: 'AMBIGUOUS_PROVIDER', message: expect.any(String) }
    });
  });
});

/**
 * TRD-2026-8d825f54 PR 4 review Finding 4: `remote_url_matches` pattern evaluation is bounded
 * by a hard wall-clock deadline (`./detect.js#testRemoteUrlPattern`), never silently swallowed
 * on failure. A deliberately catastrophic-backtracking pattern (`^(a+)+$`) is only exercised
 * against a real near-matching ORIGIN URL (no scheme/host prefix): the pattern is anchored
 * (`^...$`), so a prefixed URL like `https://evil.example.com/aaa...a!` never even enters the
 * backtracking group (`^` fails to match at position 0 against `h`) -- the catastrophic case
 * requires the WHOLE origin URL to be the near-matching string, matching the bead's own worked
 * example (`'a'.repeat(40) + '!'`).
 */
describe('remote_url_matches: bounded regex evaluation (PR 4 review Finding 4)', () => {
  test('a catastrophic-backtracking pattern against a real near-matching origin URL throws a named DETECTION_SIGNAL_ERROR within a few hundred ms, never hangs', () => {
    const projectRoot = mkTempDir('toolchain-detect-regex-deadline-');
    initGitRepo(projectRoot);
    setGitRemote(projectRoot, 'a'.repeat(40) + '!');

    writeInstalledAdapter(
      projectRoot,
      'fixture-pkg',
      'fixture-evil',
      fixtureManifest({
        adapter: 'fixture-evil',
        categories: ['tracker'],
        detect: [{ signal: 'remote_url_matches', pattern: '^(a+)+$' }]
      })
    );

    const start = Date.now();
    let thrown;
    try {
      detectAdapter('tracker', { projectRoot });
    } catch (error) {
      thrown = error;
    }
    const elapsedMs = Date.now() - start;

    expect(thrown).toBeDefined();
    expect(thrown.code).toBe('DETECTION_SIGNAL_ERROR');
    expect(thrown.message).toContain('fixture-evil');
    expect(thrown.message).toContain('remote_url_matches');
    expect(thrown.message).toContain('^(a+)+$');
    // Generous margin above the ~200ms deadline: proves this returns promptly, never hangs.
    expect(elapsedMs).toBeLessThan(2000);
  });

  test('an oversized pattern is rejected by name, never evaluated', () => {
    const projectRoot = mkTempDir('toolchain-detect-regex-oversize-');
    initGitRepo(projectRoot);
    setGitRemote(projectRoot, 'https://github.com/example/repo.git');

    writeInstalledAdapter(
      projectRoot,
      'fixture-pkg',
      'fixture-oversize',
      fixtureManifest({
        adapter: 'fixture-oversize',
        categories: ['tracker'],
        detect: [{ signal: 'remote_url_matches', pattern: 'a'.repeat(600) }]
      })
    );

    expect(() => detectAdapter('tracker', { projectRoot })).toThrow(
      expect.objectContaining({ code: 'DETECTION_SIGNAL_ERROR' })
    );
  });

  test('an invalid regex pattern is rejected by name, never silently treated as no-match', () => {
    const projectRoot = mkTempDir('toolchain-detect-regex-invalid-');
    initGitRepo(projectRoot);
    setGitRemote(projectRoot, 'https://github.com/example/repo.git');

    writeInstalledAdapter(
      projectRoot,
      'fixture-pkg',
      'fixture-badregex',
      fixtureManifest({
        adapter: 'fixture-badregex',
        categories: ['tracker'],
        detect: [{ signal: 'remote_url_matches', pattern: '(unterminated' }]
      })
    );

    expect(() => detectAdapter('tracker', { projectRoot })).toThrow(
      expect.objectContaining({ code: 'DETECTION_SIGNAL_ERROR' })
    );
  });

  test('a well-formed, fast pattern still matches normally -- the deadline never affects ordinary detection', () => {
    const projectRoot = mkTempDir('toolchain-detect-regex-normal-');
    initGitRepo(projectRoot);
    setGitRemote(projectRoot, 'https://github.com/example/repo.git');

    writeInstalledAdapter(
      projectRoot,
      'fixture-pkg',
      'fixture-normal',
      fixtureManifest({
        adapter: 'fixture-normal',
        categories: ['tracker'],
        detect: [{ signal: 'remote_url_matches', pattern: 'github\\.com' }]
      })
    );

    expect(detectAdapter('tracker', { projectRoot })).toEqual({
      value: 'fixture-normal',
      source: 'detection'
    });
  });

  test('production wiring: a catastrophic pattern reaches a real "toolchain-cli resolve --json" subprocess as a named error, not a hang', () => {
    const projectRoot = mkTempDir('toolchain-detect-regex-cli-');
    initGitRepo(projectRoot);
    setGitRemote(projectRoot, 'a'.repeat(40) + '!');

    writeInstalledAdapter(
      projectRoot,
      'fixture-pkg',
      'fixture-evil-cli',
      fixtureManifest({
        adapter: 'fixture-evil-cli',
        categories: ['tracker'],
        detect: [{ signal: 'remote_url_matches', pattern: '^(a+)+$' }]
      })
    );

    const xdgConfigHome = mkTempDir('toolchain-detect-regex-cli-xdg-');
    const result = spawnSync('node', [CLI, 'resolve', '--json'], {
      cwd: projectRoot,
      env: { PATH: process.env.PATH, XDG_CONFIG_HOME: xdgConfigHome },
      encoding: 'utf8',
      timeout: 5000
    });

    // Never killed by the 5s subprocess timeout: the real deadline bounds this to a few
    // hundred ms, nowhere near the kill timeout.
    expect(result.signal).toBeNull();
    expect(result.status).toBe(1);
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toEqual({
      ok: false,
      error: { code: 'DETECTION_SIGNAL_ERROR', message: expect.any(String) }
    });
    expect(parsed.error.message).toContain('fixture-evil-cli');
  });

  describe('mutation-proof: removing the vm timeout lets a catastrophic pattern hang', () => {
    test('a mutant detect.js without the timeout option never completes within a 2s kill window for the same pattern the real code bounds to ~200ms', () => {
      const mutantRoot = makeMutantToolchainRoot();
      try {
        const needle = '    script.runInContext(sandbox, { timeout: REMOTE_URL_MATCH_TIMEOUT_MS });';
        const replacement = '    script.runInContext(sandbox);';
        // Write the mutation to disk (never `require()` it in THIS process -- calling the
        // mutated detectAdapter here would hang the Jest worker itself). A fresh child
        // process requires and calls it instead, bounded by `spawnSync`'s own `timeout`.
        const original = fs.readFileSync(mutantRoot.toolchainLibDir + '/detect.js', 'utf8');
        if (!original.includes(needle)) {
          throw new Error('mutation needle not found in detect.js');
        }
        fs.writeFileSync(mutantRoot.toolchainLibDir + '/detect.js', original.replace(needle, replacement));

        const projectRoot = mkTempDir('toolchain-detect-regex-mutant-');
        initGitRepo(projectRoot);
        setGitRemote(projectRoot, 'a'.repeat(40) + '!');
        writeInstalledAdapter(
          projectRoot,
          'fixture-pkg',
          'fixture-evil-mutant',
          fixtureManifest({
            adapter: 'fixture-evil-mutant',
            categories: ['tracker'],
            detect: [{ signal: 'remote_url_matches', pattern: '^(a+)+$' }]
          })
        );

        const detectPath = mutantRoot.toolchainLibDir + '/detect.js';
        const script =
          `const { detectAdapter } = require(${JSON.stringify(detectPath)});\n` +
          `detectAdapter('tracker', { projectRoot: ${JSON.stringify(projectRoot)} });\n` +
          `process.stdout.write('completed');\n`;

        const child = spawnSync(process.execPath, ['-e', script], {
          timeout: 2000,
          encoding: 'utf8'
        });

        // With the deadline removed, the mutant never finishes within the 2s kill window --
        // spawnSync reports it was killed (signal set / ETIMEDOUT), and it never printed
        // 'completed' -- exactly what the real (unmutated) "within a few hundred ms" test
        // above disproves.
        expect(child.stdout).not.toBe('completed');
        expect(child.signal !== null || (child.error && child.error.code === 'ETIMEDOUT')).toBe(
          true
        );
      } finally {
        mutantRoot.cleanup();
      }
    });
  });
});
