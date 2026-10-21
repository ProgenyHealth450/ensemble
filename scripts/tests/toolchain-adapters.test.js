'use strict';
/**
 * Tests for TRD-2026-8d825f54 TRD-006: `discoverAdapters(ctx)` / `loadAdapter(name, ctx)` in
 * packages/development/lib/toolchain/adapters.js, covering repo-local, user and installed
 * adapter discovery, origin-priority and duplicate-id tie-break, the `NOT_INSTALLED` failure,
 * the repo-local non-interactive trust rule (TRD interpretation I5) including its
 * `CONFIG_INVALID` and `ctx.env`-replaces-`process.env` edges, the no-cache/no-build
 * read-fresh-every-call behavior for both `adapter.yaml` and `SKILL.md` (PRD REQ-005 AC-005-1,
 * REQ-007 AC-007-1/2/3), symlinked adapter directories, and resilient listing that never throws
 * a raw filesystem error.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');

const { discoverAdapters, loadAdapter } = require('../../packages/development/lib/toolchain/adapters');
const { getUserToolchainConfigPath } = require('../../packages/development/lib/toolchain/config-path');

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

const SKILL_MD = ['# Example Adapter', '', '## Vocabulary', '', '- show: read a work item by id', ''].join('\n');

function validAdapterManifest(overrides = {}) {
  return {
    adapter: 'example-adapter',
    version: '1.0.0',
    categories: ['tracker'],
    contract: { tracker: '1.0' },
    binaries: ['example-tool'],
    allowlist: [{ bin: 'example-tool', sub: ['show'] }],
    env: [],
    health: [{ id: 'version', run: ['example-tool', '--version'], timeoutMs: 5000 }],
    detect: [],
    capabilities: {
      'tracker.show': {
        run: ['example-tool', 'show', '--id', '${id}'],
        parse: { format: 'json', root: '$' }
      }
    },
    ...overrides
  };
}

/**
 * Write a realistic adapter skill directory (`adapter.yaml` plus `SKILL.md`), mirroring the
 * fixture pattern of scripts/tests/toolchain-manifest.test.js.
 */
function writeAdapterDir(dir, manifest, skillMd = SKILL_MD) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'adapter.yaml'), yaml.dump(manifest));
  fs.writeFileSync(path.join(dir, 'SKILL.md'), skillMd);
  return dir;
}

/** The user adapters directory for one adapter name, derived the same way adapters.js does. */
function userAdapterDir(xdgConfigHome, name) {
  const configPath = getUserToolchainConfigPath({ XDG_CONFIG_HOME: xdgConfigHome });
  return path.join(path.dirname(configPath), 'adapters', name);
}

function writeUserToolchainConfig(xdgConfigHome, configObject) {
  const configPath = getUserToolchainConfigPath({ XDG_CONFIG_HOME: xdgConfigHome });
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, yaml.dump(configObject));
  return configPath;
}

describe('loadAdapter: user-level adapters', () => {
  test('AC-005-1/AC-007-1: an adapter under the user adapters/ dir resolves with origin user and stays under the temp XDG root', () => {
    const projectRoot = mkTempDir('ensemble-adapters-user-project-');
    const xdgConfigHome = mkTempDir('ensemble-adapters-user-xdg-');

    const dir = userAdapterDir(xdgConfigHome, 'bar');
    writeAdapterDir(dir, validAdapterManifest({ adapter: 'bar' }));

    const result = loadAdapter('bar', { projectRoot, env: { XDG_CONFIG_HOME: xdgConfigHome } });

    expect(result.origin).toBe('user');
    expect(result.dir).toBe(dir);
    // The resolved directory lives entirely under the temp XDG root, so this call could not
    // have read or written anything under the real repository's packages/ tree.
    expect(result.dir.startsWith(xdgConfigHome)).toBe(true);
    expect(result.manifest.adapter).toBe('bar');
  });
});

describe('loadAdapter: origin priority (user wins over installed)', () => {
  test('AC-007-1/I5: the same adapter id declared in both the user adapters dir and an installed packages/*/skills dir resolves with origin user', () => {
    const projectRoot = mkTempDir('ensemble-adapters-priority-project-');
    const xdgConfigHome = mkTempDir('ensemble-adapters-priority-xdg-');

    const userDir = userAdapterDir(xdgConfigHome, 'shared-owner');
    writeAdapterDir(userDir, validAdapterManifest({ adapter: 'shared-adapter' }));

    const installedDir = path.join(projectRoot, 'packages', 'some-pkg', 'skills', 'shared-skill');
    writeAdapterDir(installedDir, validAdapterManifest({ adapter: 'shared-adapter' }));

    const result = loadAdapter('shared-adapter', { projectRoot, env: { XDG_CONFIG_HOME: xdgConfigHome } });

    expect(result.origin).toBe('user');
    expect(result.dir).toBe(userDir);
  });
});

describe('loadAdapter: duplicate-id tie-break (first by origin priority, then sorted directory name)', () => {
  test('two installed packages declaring the same adapter id resolve to the lexicographically-first package directory', () => {
    const projectRoot = mkTempDir('ensemble-adapters-duptie-project-');
    const xdgConfigHome = mkTempDir('ensemble-adapters-duptie-xdg-');

    const firstDir = path.join(projectRoot, 'packages', 'pkg-a', 'skills', 'dup-skill');
    writeAdapterDir(firstDir, validAdapterManifest({ adapter: 'dup-adapter' }));
    const secondDir = path.join(projectRoot, 'packages', 'pkg-b', 'skills', 'dup-skill');
    writeAdapterDir(secondDir, validAdapterManifest({ adapter: 'dup-adapter' }));

    const result = loadAdapter('dup-adapter', {
      projectRoot,
      env: { XDG_CONFIG_HOME: xdgConfigHome },
      interactive: true
    });

    expect(result.origin).toBe('installed');
    expect(result.dir).toBe(firstDir);
  });
});

describe('loadAdapter: NOT_INSTALLED', () => {
  test('AC-007-2: a name found in no search location fails with code NOT_INSTALLED naming the adapter, all three search locations, and a marketplace install hint', () => {
    const projectRoot = mkTempDir('ensemble-adapters-missing-project-');
    const xdgConfigHome = mkTempDir('ensemble-adapters-missing-xdg-');
    const name = 'totally-unknown-adapter';

    const expectedRepoLocalDir = path.join(projectRoot, '.ensemble', 'adapters', name);
    const expectedUserDir = userAdapterDir(xdgConfigHome, name);
    const expectedPackagesRoot = path.join(projectRoot, 'packages');

    expect.assertions(6);
    try {
      loadAdapter(name, { projectRoot, env: { XDG_CONFIG_HOME: xdgConfigHome } });
    } catch (error) {
      expect(error.code).toBe('NOT_INSTALLED');
      expect(error.message).toContain(name);
      expect(error.message).toContain(expectedRepoLocalDir);
      expect(error.message).toContain(expectedUserDir);
      expect(error.message).toContain(expectedPackagesRoot);
      expect(error.message.toLowerCase()).toMatch(/marketplace/);
    }
  });
});

describe('loadAdapter: repo-local trust (TRD interpretation I5)', () => {
  let projectRoot;
  let xdgConfigHome;
  let repoLocalDir;

  beforeEach(() => {
    projectRoot = mkTempDir('ensemble-adapters-repo-project-');
    xdgConfigHome = mkTempDir('ensemble-adapters-repo-xdg-');
    repoLocalDir = path.join(projectRoot, '.ensemble', 'adapters', 'foo');
    writeAdapterDir(repoLocalDir, validAdapterManifest({ adapter: 'foo' }));
  });

  test('AC-007-3: an interactive call resolves the repo-local adapter with origin repo-local', () => {
    const result = loadAdapter('foo', {
      projectRoot,
      env: { XDG_CONFIG_HOME: xdgConfigHome },
      interactive: true
    });

    expect(result.origin).toBe('repo-local');
    expect(result.dir).toBe(repoLocalDir);
    expect(result.manifest.adapter).toBe('foo');
  });

  test("I5: a non-interactive call without 'foo' in trustedRepoAdapters fails naming the adapter and the trust setting", () => {
    expect.assertions(3);
    try {
      loadAdapter('foo', { projectRoot, env: { XDG_CONFIG_HOME: xdgConfigHome }, interactive: false });
    } catch (error) {
      expect(error.code).toBe('UNTRUSTED_REPO_ADAPTER');
      expect(error.message).toContain('foo');
      expect(error.message).toContain('trustedRepoAdapters');
    }
  });

  test("AC-007-3: a non-interactive call with 'foo' in trustedRepoAdapters resolves with no packaging step", () => {
    writeUserToolchainConfig(xdgConfigHome, { trustedRepoAdapters: ['foo'] });

    const result = loadAdapter('foo', {
      projectRoot,
      env: { XDG_CONFIG_HOME: xdgConfigHome },
      interactive: false
    });

    expect(result.origin).toBe('repo-local');
    expect(result.dir).toBe(repoLocalDir);
    expect(result.manifest.adapter).toBe('foo');
  });

  test('a non-interactive call whose user toolchain.yaml fails schema validation fails with CONFIG_INVALID naming the file', () => {
    const userConfigPath = getUserToolchainConfigPath({ XDG_CONFIG_HOME: xdgConfigHome });
    fs.mkdirSync(path.dirname(userConfigPath), { recursive: true });
    // trustedRepoAdapters must be an array of strings per the toolchain config schema; a bare
    // string fails ajv validation inside loadToolchainConfigFile.
    fs.writeFileSync(userConfigPath, yaml.dump({ trustedRepoAdapters: 'foo' }));

    expect.assertions(2);
    try {
      loadAdapter('foo', { projectRoot, env: { XDG_CONFIG_HOME: xdgConfigHome }, interactive: false });
    } catch (error) {
      expect(error.code).toBe('CONFIG_INVALID');
      expect(error.message).toContain(userConfigPath);
    }
  });
});

describe('loadAdapter: ctx.env replaces process.env wholesale for the trust lookup', () => {
  test('a partial ctx.env cannot read the developer real trustedRepoAdapters resolved from process.env', () => {
    const projectRoot = mkTempDir('ensemble-adapters-envreplace-project-');
    const repoLocalDir = path.join(projectRoot, '.ensemble', 'adapters', 'env-trust-adapter');
    writeAdapterDir(repoLocalDir, validAdapterManifest({ adapter: 'env-trust-adapter' }));

    // Simulate the developer's real environment: process.env.XDG_CONFIG_HOME points at a
    // config that trusts this adapter, and process.env.HOME is pinned to a fresh directory
    // with no pre-existing `.config`, so config-path.js's own fallback chain stays isolated
    // from the real machine running this test.
    const developerXdgConfigHome = mkTempDir('ensemble-adapters-envreplace-real-xdg-');
    writeUserToolchainConfig(developerXdgConfigHome, { trustedRepoAdapters: ['env-trust-adapter'] });
    const fakeHome = mkTempDir('ensemble-adapters-envreplace-home-');

    const savedXdg = process.env.XDG_CONFIG_HOME;
    const savedHome = process.env.HOME;
    process.env.XDG_CONFIG_HOME = developerXdgConfigHome;
    process.env.HOME = fakeHome;
    try {
      // ctx.env carries no XDG_CONFIG_HOME at all. If it replaces process.env wholesale (as
      // documented), the trust lookup falls back through config-path.js's own chain to
      // <fakeHome>/.ensemble/toolchain.yaml, which was never written, so trustedRepoAdapters
      // is empty and this non-interactive call is rejected. If it instead merged with
      // process.env, the developer's real XDG_CONFIG_HOME would leak through and the call
      // would resolve the adapter as trusted with no error.
      expect.assertions(1);
      try {
        loadAdapter('env-trust-adapter', { projectRoot, env: {}, interactive: false });
        throw new Error('expected loadAdapter to reject the untrusted repo-local adapter');
      } catch (error) {
        expect(error.code).toBe('UNTRUSTED_REPO_ADAPTER');
      }
    } finally {
      if (savedXdg === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = savedXdg;
      }
      if (savedHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = savedHome;
      }
    }
  });
});

describe('loadAdapter: no caching (Implementation AC 4)', () => {
  test('an edited capability run template between two calls in the same process is reflected on the second call', () => {
    const projectRoot = mkTempDir('ensemble-adapters-fresh-project-');
    const xdgConfigHome = mkTempDir('ensemble-adapters-fresh-xdg-');
    const dir = path.join(projectRoot, '.ensemble', 'adapters', 'freshy');
    writeAdapterDir(dir, validAdapterManifest({ adapter: 'freshy' }));

    const ctx = { projectRoot, env: { XDG_CONFIG_HOME: xdgConfigHome }, interactive: true };

    const first = loadAdapter('freshy', ctx);
    expect(first.manifest.capabilities['tracker.show'].run).toEqual(['example-tool', 'show', '--id', '${id}']);

    const edited = validAdapterManifest({
      adapter: 'freshy',
      capabilities: {
        'tracker.show': {
          run: ['example-tool', 'show', '--id', '${id}', '--verbose'],
          parse: { format: 'json', root: '$' }
        }
      }
    });
    fs.writeFileSync(path.join(dir, 'adapter.yaml'), yaml.dump(edited));

    const second = loadAdapter('freshy', ctx);

    expect(second.manifest.capabilities['tracker.show'].run).toEqual([
      'example-tool',
      'show',
      '--id',
      '${id}',
      '--verbose'
    ]);
    expect(second.manifest.capabilities['tracker.show'].run).not.toEqual(
      first.manifest.capabilities['tracker.show'].run
    );
  });

  test('PRD REQ-005 AC-005-1: SKILL.md content is returned on the loaded adapter and an edit between two calls is visible', () => {
    const projectRoot = mkTempDir('ensemble-adapters-skillmd-project-');
    const xdgConfigHome = mkTempDir('ensemble-adapters-skillmd-xdg-');
    const dir = path.join(projectRoot, '.ensemble', 'adapters', 'skillmd-adapter');
    writeAdapterDir(dir, validAdapterManifest({ adapter: 'skillmd-adapter' }));

    const ctx = { projectRoot, env: { XDG_CONFIG_HOME: xdgConfigHome }, interactive: true };

    const first = loadAdapter('skillmd-adapter', ctx);
    expect(first.skillMd.ok).toBe(true);
    expect(first.skillMd.content).toBe(SKILL_MD);

    const editedSkillMd = ['# Example Adapter', '', '## Vocabulary', '', '- show: edited behavior', ''].join('\n');
    fs.writeFileSync(path.join(dir, 'SKILL.md'), editedSkillMd);

    const second = loadAdapter('skillmd-adapter', ctx);
    expect(second.skillMd.ok).toBe(true);
    expect(second.skillMd.content).toBe(editedSkillMd);
    expect(second.skillMd.content).not.toBe(first.skillMd.content);
  });

  test('a missing SKILL.md is reported clearly on the loaded adapter instead of throwing', () => {
    const projectRoot = mkTempDir('ensemble-adapters-skillmd-missing-project-');
    const xdgConfigHome = mkTempDir('ensemble-adapters-skillmd-missing-xdg-');
    const dir = path.join(projectRoot, '.ensemble', 'adapters', 'no-skillmd');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'adapter.yaml'), yaml.dump(validAdapterManifest({ adapter: 'no-skillmd' })));
    // Deliberately no SKILL.md written.

    let result;
    expect(() => {
      result = loadAdapter('no-skillmd', {
        projectRoot,
        env: { XDG_CONFIG_HOME: xdgConfigHome },
        interactive: true
      });
    }).not.toThrow();

    expect(result.origin).toBe('repo-local');
    expect(result.skillMd.ok).toBe(false);
    expect(result.skillMd.error).toContain(path.join(dir, 'SKILL.md'));
    expect(result.skillMd.error.toLowerCase()).toMatch(/missing or unreadable/);
  });
});

describe('loadAdapter/discoverAdapters: symlinked adapter directories', () => {
  test('a symlinked adapter directory under the repo-local root resolves like a real directory', () => {
    const projectRoot = mkTempDir('ensemble-adapters-symlink-project-');
    const xdgConfigHome = mkTempDir('ensemble-adapters-symlink-xdg-');
    const externalDir = mkTempDir('ensemble-adapters-symlink-target-');
    writeAdapterDir(externalDir, validAdapterManifest({ adapter: 'symlinked-adapter' }));

    const repoLocalAdaptersDir = path.join(projectRoot, '.ensemble', 'adapters');
    fs.mkdirSync(repoLocalAdaptersDir, { recursive: true });
    const linkPath = path.join(repoLocalAdaptersDir, 'symlinked-adapter');
    fs.symlinkSync(externalDir, linkPath, 'dir');

    const result = loadAdapter('symlinked-adapter', {
      projectRoot,
      env: { XDG_CONFIG_HOME: xdgConfigHome },
      interactive: true
    });

    expect(result.origin).toBe('repo-local');
    expect(result.dir).toBe(linkPath);
    expect(result.manifest.adapter).toBe('symlinked-adapter');
    expect(result.skillMd.ok).toBe(true);
  });
});

describe('discoverAdapters: resilient listing (never throws a raw fs error)', () => {
  test('a missing adapters root is skipped, not thrown', () => {
    const projectRoot = mkTempDir('ensemble-adapters-missing-root-project-');
    const xdgConfigHome = mkTempDir('ensemble-adapters-missing-root-xdg-');
    // No .ensemble/adapters, no user adapters dir, no packages dir exists at all.

    let result;
    expect(() => {
      result = discoverAdapters({ projectRoot, env: { XDG_CONFIG_HOME: xdgConfigHome } });
    }).not.toThrow();
    expect(result).toEqual([]);
  });

  test('a non-directory adapters root (a plain file in its place) is skipped, not thrown', () => {
    const projectRoot = mkTempDir('ensemble-adapters-file-root-project-');
    const xdgConfigHome = mkTempDir('ensemble-adapters-file-root-xdg-');
    fs.mkdirSync(path.join(projectRoot, '.ensemble'), { recursive: true });
    // .ensemble/adapters exists as a plain file, not a directory: readdirSync on it raises
    // ENOTDIR.
    fs.writeFileSync(path.join(projectRoot, '.ensemble', 'adapters'), 'not a directory');

    let result;
    expect(() => {
      result = discoverAdapters({ projectRoot, env: { XDG_CONFIG_HOME: xdgConfigHome } });
    }).not.toThrow();
    expect(result).toEqual([]);
  });

  test('a stray file inside an adapters root is skipped, not thrown and not treated as an adapter', () => {
    const projectRoot = mkTempDir('ensemble-adapters-stray-file-project-');
    const xdgConfigHome = mkTempDir('ensemble-adapters-stray-file-xdg-');
    const repoLocalRoot = path.join(projectRoot, '.ensemble', 'adapters');
    fs.mkdirSync(repoLocalRoot, { recursive: true });
    fs.writeFileSync(path.join(repoLocalRoot, 'README.md'), 'not an adapter directory');
    const realAdapterDir = path.join(repoLocalRoot, 'real-adapter');
    writeAdapterDir(realAdapterDir, validAdapterManifest({ adapter: 'real-adapter' }));

    let result;
    expect(() => {
      result = discoverAdapters({ projectRoot, env: { XDG_CONFIG_HOME: xdgConfigHome } });
    }).not.toThrow();
    expect(result).toEqual([{ name: 'real-adapter', origin: 'repo-local', dir: realAdapterDir }]);
  });

  test('a broken symlink inside an adapters root is skipped, not thrown', () => {
    const projectRoot = mkTempDir('ensemble-adapters-broken-symlink-project-');
    const xdgConfigHome = mkTempDir('ensemble-adapters-broken-symlink-xdg-');
    const repoLocalRoot = path.join(projectRoot, '.ensemble', 'adapters');
    fs.mkdirSync(repoLocalRoot, { recursive: true });
    fs.symlinkSync(path.join(projectRoot, 'does-not-exist'), path.join(repoLocalRoot, 'broken-link'), 'dir');

    let result;
    expect(() => {
      result = discoverAdapters({ projectRoot, env: { XDG_CONFIG_HOME: xdgConfigHome } });
    }).not.toThrow();
    expect(result).toEqual([]);
  });
});

describe('discoverAdapters', () => {
  test('enumerates repo-local, user and installed adapters, taking each name from its own manifest regardless of directory naming (TRD interpretation I7)', () => {
    const projectRoot = mkTempDir('ensemble-adapters-discover-project-');
    const xdgConfigHome = mkTempDir('ensemble-adapters-discover-xdg-');

    const repoLocalDir = path.join(projectRoot, '.ensemble', 'adapters', 'repo-adapter-dir');
    writeAdapterDir(repoLocalDir, validAdapterManifest({ adapter: 'repo-id' }));

    const userDir = userAdapterDir(xdgConfigHome, 'user-adapter-dir');
    writeAdapterDir(userDir, validAdapterManifest({ adapter: 'user-id' }));

    // The installed directory carries neither the manifest's declared id nor any
    // 'adapter-'-prefixed name, proving discovery selects by the manifest's declared `adapter`
    // id and does not depend on any directory-naming convention (TRD interpretation I7).
    const installedDir = path.join(projectRoot, 'packages', 'some-pkg', 'skills', 'mystery-tool');
    writeAdapterDir(
      installedDir,
      validAdapterManifest({ adapter: 'installed-id', categories: ['tracker', 'host'], contract: { tracker: '1.0', host: '1.0' } })
    );

    // A skills-directory sibling with no adapter.yaml at all must still be ignored: there is
    // nothing in it to select by.
    const emptyDir = path.join(projectRoot, 'packages', 'some-pkg', 'skills', 'not-an-adapter');
    fs.mkdirSync(emptyDir, { recursive: true });

    const result = discoverAdapters({ projectRoot, env: { XDG_CONFIG_HOME: xdgConfigHome } });

    expect(result).toEqual(
      expect.arrayContaining([
        { name: 'repo-id', origin: 'repo-local', dir: repoLocalDir },
        { name: 'user-id', origin: 'user', dir: userDir },
        { name: 'installed-id', origin: 'installed', dir: installedDir }
      ])
    );
    expect(result).toHaveLength(3);
  });
});
