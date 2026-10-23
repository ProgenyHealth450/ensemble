'use strict';
/**
 * Tests for `packages/git/skills/adapter-host-github` (TRD-2026-8d825f54 TRD-036,
 * TRD-036-TEST, PRD REQ-006/REQ-024): the GitHub `host` adapter.
 *
 * Covers the manifest's own static correctness (schema, allowlist, `SKILL.md` vocabulary
 * block, names-only `env`), that the toolchain resolver actually LOADS it (no
 * `NOT_INSTALLED`), the shipped-default-selection AC, and a mutation-proof guard test proving
 * the validators are capable of failing (same pattern as
 * `toolchain-adapter-tracker-azure-boards-manifest.test.js`).
 *
 * No test here spawns a real `gh` process: `validateAdapterDir`/`loadAdapter` never execute
 * the manifest's `run[]` templates; the one real subprocess this file spawns is the
 * `toolchain-cli.js validate` CLI itself (a static check), never `gh`.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const yaml = require('js-yaml');

const { validateAdapterDir, checkVocabularyBlock } = require('../../packages/development/lib/toolchain/validate');
const { loadAdapter } = require('../../packages/development/lib/toolchain/adapters');
const { runCapability } = require('../../packages/development/lib/toolchain/runner');

const REPO_ROOT = path.join(__dirname, '..', '..');
const ADAPTER_DIR = path.join(REPO_ROOT, 'packages', 'git', 'skills', 'adapter-host-github');
const CLI_PATH = path.join(REPO_ROOT, 'packages', 'development', 'lib', 'toolchain-cli.js');
const DEFAULT_TOOLCHAIN_PATH = path.join(REPO_ROOT, 'packages', 'development', 'toolchain', 'toolchain.default.yaml');

const EXPECTED_CAPABILITIES = [
  'host.auth-status',
  'host.change-request-create',
  'host.change-request-view',
  'host.change-request-list',
  'host.change-request-checks',
  'host.change-request-threads',
  'host.change-request-merge'
];

const tempDirs = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

function mkTempDir(prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

/** Copy the real adapter directory (adapter.yaml + SKILL.md only) into a fresh tmpdir so a test can mutate it safely. */
function mkMutableAdapterCopy() {
  const dir = mkTempDir('adapter-host-github-mut-');
  fs.copyFileSync(path.join(ADAPTER_DIR, 'adapter.yaml'), path.join(dir, 'adapter.yaml'));
  fs.copyFileSync(path.join(ADAPTER_DIR, 'SKILL.md'), path.join(dir, 'SKILL.md'));
  return dir;
}

function loadMutableManifest(dir) {
  return yaml.load(fs.readFileSync(path.join(dir, 'adapter.yaml'), 'utf8'));
}

function writeMutableManifest(dir, manifest) {
  fs.writeFileSync(path.join(dir, 'adapter.yaml'), yaml.dump(manifest));
}

describe('TRD-036-TEST: adapter-host-github manifest passes every static validator', () => {
  test('validateAdapterDir(real dir) reports zero errors', () => {
    const result = validateAdapterDir(ADAPTER_DIR);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  test('real `node toolchain-cli.js validate` subprocess exits 0 and prints {ok:true}', () => {
    const proc = spawnSync(process.execPath, [CLI_PATH, 'validate', ADAPTER_DIR, '--json'], {
      encoding: 'utf8'
    });
    expect(proc.status).toBe(0);
    expect(JSON.parse(proc.stdout.trim())).toEqual({ ok: true, errors: [] });
  });

  test('SKILL.md has a ## Vocabulary heading', () => {
    const result = checkVocabularyBlock(path.join(ADAPTER_DIR, 'SKILL.md'));
    expect(result.ok).toBe(true);
  });

  test('SKILL.md names adapter.yaml and documents every declared capability', () => {
    const skillMd = fs.readFileSync(path.join(ADAPTER_DIR, 'SKILL.md'), 'utf8');
    expect(skillMd).toContain('adapter.yaml');
    for (const capability of EXPECTED_CAPABILITIES) {
      expect(skillMd).toContain(capability);
    }
    expect(skillMd).toMatch(/## Known limits/);
  });

  test('the manifest declares adapter "github", the host-only category, its contract version, names-only env, and exactly the capabilities SKILL.md documents', () => {
    const manifest = yaml.load(fs.readFileSync(path.join(ADAPTER_DIR, 'adapter.yaml'), 'utf8'));
    expect(manifest.adapter).toBe('github');
    expect(manifest.categories).toEqual(['host']);
    expect(manifest.contract).toEqual({ host: '1.0' });
    expect(Object.keys(manifest.capabilities).sort()).toEqual([...EXPECTED_CAPABILITIES].sort());
    // host.change-request-link-work-item (optional, no fallback) is intentionally NOT declared.
    expect(manifest.capabilities['host.change-request-link-work-item']).toBeUndefined();
    // env: names only (PRD REQ-022).
    expect(manifest.env).toEqual(['GH_TOKEN']);
    for (const name of manifest.env) {
      expect(name).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
    expect(manifest.detect).toEqual([{ signal: 'remote_url_matches', pattern: 'github\\.com' }]);
  });

  test('every health check is declared with id/run/timeoutMs', () => {
    const manifest = yaml.load(fs.readFileSync(path.join(ADAPTER_DIR, 'adapter.yaml'), 'utf8'));
    for (const check of manifest.health) {
      expect(typeof check.id).toBe('string');
      expect(Array.isArray(check.run)).toBe(true);
      expect(check.timeoutMs).toBeGreaterThan(0);
    }
    const ids = manifest.health.map((h) => h.id);
    expect(ids).toEqual(expect.arrayContaining(['gh-installed', 'gh-auth-status']));
  });

  test('the allowlist uses TRD-036\'s directed 7-entry list plus "--version"', () => {
    const manifest = yaml.load(fs.readFileSync(path.join(ADAPTER_DIR, 'adapter.yaml'), 'utf8'));
    const ghAllowlist = manifest.allowlist.find((e) => e.bin === 'gh');
    expect(ghAllowlist).toBeDefined();
    expect(ghAllowlist.sub.sort()).toEqual(
      ['pr create', 'pr view', 'pr list', 'pr checks', 'pr merge', 'auth status', 'api', '--version'].sort()
    );
  });
});

describe('TRD-036-TEST: the toolchain resolver actually loads adapter "github" (no NOT_INSTALLED)', () => {
  test('loadAdapter("github") resolves to the real installed skill directory', () => {
    const result = loadAdapter('github', { projectRoot: REPO_ROOT });
    expect(result.origin).toBe('installed');
    expect(fs.realpathSync(result.dir)).toBe(fs.realpathSync(ADAPTER_DIR));
    expect(result.manifest.adapter).toBe('github');
    expect(result.manifest.categories).toEqual(['host']);
  });
});

describe('TRD-036-TEST: Scenario "Manifests validate and defaults are named" -- the shipped toolchain.default.yaml names the "github" host default', () => {
  test('toolchain.default.yaml declares host: github', () => {
    const defaults = yaml.load(fs.readFileSync(DEFAULT_TOOLCHAIN_PATH, 'utf8'));
    expect(defaults.host).toBe('github');
  });
});

describe('TRD-036-TEST: mutation check proves the validators are capable of failing', () => {
  test('removing "pr view" from the allowlist makes validateAdapterDir fail, naming host.change-request-view', () => {
    const dir = mkMutableAdapterCopy();
    const manifest = loadMutableManifest(dir);
    const ghEntry = manifest.allowlist.find((e) => e.bin === 'gh');
    ghEntry.sub = ghEntry.sub.filter((s) => s !== 'pr view');
    writeMutableManifest(dir, manifest);

    const result = validateAdapterDir(dir);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("capability 'host.change-request-view'") && e.includes('allowlist'))).toBe(
      true
    );
  });

  test('deleting the required "adapter" field makes validateAdapterDir fail with a schema error', () => {
    const dir = mkMutableAdapterCopy();
    const manifest = loadMutableManifest(dir);
    delete manifest.adapter;
    writeMutableManifest(dir, manifest);

    const result = validateAdapterDir(dir);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("missing required property 'adapter'"))).toBe(true);
  });
});

describe('TRD-036-TEST: Scenario "Merge denied outside allowlist" -- host.change-request-merge is rejected when the allowlist omits "pr merge"', () => {
  test('runCapability("host.change-request-merge") against an allowlist with "pr merge" stripped returns NOT_ALLOWED, never spawning gh', async () => {
    const manifest = yaml.load(fs.readFileSync(path.join(ADAPTER_DIR, 'adapter.yaml'), 'utf8'));
    const ghEntry = manifest.allowlist.find((e) => e.bin === 'gh');
    ghEntry.sub = ghEntry.sub.filter((s) => s !== 'pr merge');

    // Point PATH at an empty tmpdir: if the runner ever attempted to spawn `gh` despite the
    // stripped allowlist entry, there would be no `gh` binary reachable to run at all, which
    // would surface as TOOL_FAILED/ENOENT, not NOT_ALLOWED -- proving the denial happens
    // before any process is spawned.
    const emptyBinDir = mkTempDir('adapter-host-github-empty-bin-');
    const result = await runCapability(manifest, 'host.change-request-merge', { id: '190' }, {
      parentEnv: { ...process.env, PATH: emptyBinDir },
      timeoutMs: 5000
    });

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('NOT_ALLOWED');
    expect(result.error.message).toMatch(/not permitted by the allowlist/);
  });

  test('validateAllowlist (the static counterpart) also rejects the same stripped-allowlist manifest, naming host.change-request-merge', () => {
    const { validateAllowlist } = require('../../packages/development/lib/toolchain/validate');
    const manifest = yaml.load(fs.readFileSync(path.join(ADAPTER_DIR, 'adapter.yaml'), 'utf8'));
    const ghEntry = manifest.allowlist.find((e) => e.bin === 'gh');
    ghEntry.sub = ghEntry.sub.filter((s) => s !== 'pr merge');

    const result = validateAllowlist(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("capability 'host.change-request-merge'") && e.includes('not in the allowlist'))).toBe(
      true
    );
  });
});
