'use strict';
/**
 * Tests for `packages/infrastructure/skills/adapter-host-azure-devops` (TRD-2026-8d825f54
 * TRD-040, TRD-040-TEST, PRD REQ-017): the Azure DevOps `host` adapter.
 *
 * Covers the manifest's own static correctness (schema, allowlist, `SKILL.md` vocabulary
 * block, names-only `env`), that the toolchain resolver actually LOADS it (no
 * `NOT_INSTALLED`), a mutation-proof guard test proving the validators are capable of
 * failing, the "Merge denied without update subcommand" acceptance scenario (runtime
 * `NOT_ALLOWED` plus its static `validateAllowlist` counterpart), and the "Allowlist matches
 * the real CLI" acceptance scenario against this adapter's own `fixtures/az-repos-pr-help.txt`
 * -- same pattern as `toolchain-adapter-host-github-manifest.test.js` (TRD-036-TEST) and
 * `toolchain-adapter-tracker-azure-boards-manifest.test.js` (TRD-033-TEST, same `az` CLI
 * family's allowlist-vs-help-fixture pattern).
 *
 * `fixtures/az-repos-pr-help.txt` is a disclosed SYNTHETIC reconstruction, not a captured live
 * `az repos pr --help` run (no `az` binary is installed in this environment) -- see the
 * adapter's own `fixtures/README.md` and `SKILL.md` "Known limits"; this file treats it only
 * as "every allowlist entry names a subcommand this reconstruction documents", never as proof
 * a live `az` would behave identically.
 *
 * No test here spawns a real `az`: `validateAdapterDir`/`loadAdapter` never execute the
 * manifest's `run[]` templates, and the one `runCapability` test below points `PATH` at an
 * empty directory specifically so a stray `az` spawn would surface as `TOOL_FAILED`/`ENOENT`,
 * not `NOT_ALLOWED` -- proving the denial happens before any process is spawned. The one real
 * subprocess this file spawns is the `toolchain-cli.js validate` CLI itself (a static check),
 * never `az`.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const yaml = require('js-yaml');

const { validateAdapterDir, checkVocabularyBlock, validateAllowlist } = require('../../packages/development/lib/toolchain/validate');
const { loadAdapter } = require('../../packages/development/lib/toolchain/adapters');
const { runCapability } = require('../../packages/development/lib/toolchain/runner');

const REPO_ROOT = path.join(__dirname, '..', '..');
const ADAPTER_DIR = path.join(REPO_ROOT, 'packages', 'infrastructure', 'skills', 'adapter-host-azure-devops');
const CLI_PATH = path.join(REPO_ROOT, 'packages', 'development', 'lib', 'toolchain-cli.js');
const HELP_FIXTURE_PATH = path.join(ADAPTER_DIR, 'fixtures', 'az-repos-pr-help.txt');

const EXPECTED_CAPABILITIES = [
  'host.auth-status',
  'host.change-request-create',
  'host.change-request-view',
  'host.change-request-list',
  'host.change-request-checks',
  'host.change-request-merge',
  'host.change-request-link-work-item'
];

const EXPECTED_ALLOWLIST_SUBS = [
  'repos pr create',
  'repos pr show',
  'repos pr list',
  'repos pr update',
  'repos pr set-vote',
  'repos pr work-item add',
  'account show',
  'devops configure',
  '--version',
  'extension show'
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
  const dir = mkTempDir('adapter-host-azure-devops-mut-');
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

describe('TRD-040-TEST: adapter-host-azure-devops manifest passes every static validator', () => {
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

  test('the manifest declares adapter "azure-devops", the host-only category, its contract version, names-only env, and exactly the capabilities SKILL.md documents', () => {
    const manifest = yaml.load(fs.readFileSync(path.join(ADAPTER_DIR, 'adapter.yaml'), 'utf8'));
    expect(manifest.adapter).toBe('azure-devops');
    expect(manifest.categories).toEqual(['host']);
    expect(manifest.contract).toEqual({ host: '1.0' });
    expect(Object.keys(manifest.capabilities).sort()).toEqual([...EXPECTED_CAPABILITIES].sort());
    // host.change-request-threads (optional, no fallback) is intentionally NOT declared: this
    // adapter has no CLI surface for diff-level review-thread comments (SKILL.md Vocabulary).
    expect(manifest.capabilities['host.change-request-threads']).toBeUndefined();
    // env: names only (PRD REQ-022).
    expect(manifest.env).toEqual(['AZURE_DEVOPS_EXT_PAT']);
    for (const name of manifest.env) {
      expect(name).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
    expect(manifest.detect).toEqual([{ signal: 'remote_url_matches', pattern: 'dev\\.azure\\.com|visualstudio\\.com' }]);
  });

  test('every health check is declared with id/run/timeoutMs', () => {
    const manifest = yaml.load(fs.readFileSync(path.join(ADAPTER_DIR, 'adapter.yaml'), 'utf8'));
    for (const check of manifest.health) {
      expect(typeof check.id).toBe('string');
      expect(Array.isArray(check.run)).toBe(true);
      expect(check.timeoutMs).toBeGreaterThan(0);
    }
    const ids = manifest.health.map((h) => h.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'az-installed',
        'az-devops-extension-installed',
        'az-devops-defaults-configured',
        'az-repos-pr-reachable'
      ])
    );
  });

  test('the allowlist uses TRD-040\'s directed 8-entry list plus "--version"/"extension show"', () => {
    const manifest = yaml.load(fs.readFileSync(path.join(ADAPTER_DIR, 'adapter.yaml'), 'utf8'));
    const azAllowlist = manifest.allowlist.find((e) => e.bin === 'az');
    expect(azAllowlist).toBeDefined();
    expect(azAllowlist.sub.sort()).toEqual([...EXPECTED_ALLOWLIST_SUBS].sort());
  });
});

describe('TRD-040-TEST: the toolchain resolver actually loads adapter "azure-devops" (no NOT_INSTALLED)', () => {
  test('loadAdapter("azure-devops") resolves to the real installed skill directory', () => {
    const result = loadAdapter('azure-devops', { projectRoot: REPO_ROOT });
    expect(result.origin).toBe('installed');
    expect(fs.realpathSync(result.dir)).toBe(fs.realpathSync(ADAPTER_DIR));
    expect(result.manifest.adapter).toBe('azure-devops');
    expect(result.manifest.categories).toEqual(['host']);
  });
});

describe('TRD-040-TEST: mutation check proves the validators are capable of failing', () => {
  test('removing "repos pr show" from the allowlist makes validateAdapterDir fail, naming host.change-request-view', () => {
    const dir = mkMutableAdapterCopy();
    const manifest = loadMutableManifest(dir);
    const azEntry = manifest.allowlist.find((e) => e.bin === 'az');
    azEntry.sub = azEntry.sub.filter((s) => s !== 'repos pr show');
    writeMutableManifest(dir, manifest);

    const result = validateAdapterDir(dir);
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) => e.includes("capability 'host.change-request-view'") && e.includes('allowlist'))
    ).toBe(true);
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

describe('TRD-040-TEST: Scenario "Merge denied without update subcommand" -- host.change-request-merge is rejected when the allowlist omits "repos pr update"', () => {
  test('runCapability("host.change-request-merge") against an allowlist with "repos pr update" stripped returns NOT_ALLOWED, never spawning az', async () => {
    const manifest = yaml.load(fs.readFileSync(path.join(ADAPTER_DIR, 'adapter.yaml'), 'utf8'));
    const azEntry = manifest.allowlist.find((e) => e.bin === 'az');
    azEntry.sub = azEntry.sub.filter((s) => s !== 'repos pr update');

    // Point PATH at an empty tmpdir: if the runner ever attempted to spawn `az` despite the
    // stripped allowlist entry, there would be no `az` binary reachable to run at all, which
    // would surface as TOOL_FAILED/ENOENT, not NOT_ALLOWED -- proving the denial happens
    // before any process is spawned.
    const emptyBinDir = mkTempDir('adapter-host-azure-devops-empty-bin-');
    const result = await runCapability(manifest, 'host.change-request-merge', { id: '42' }, {
      parentEnv: { ...process.env, PATH: emptyBinDir },
      timeoutMs: 5000
    });

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('NOT_ALLOWED');
    expect(result.error.message).toMatch(/not permitted by the allowlist/);
  });

  test('validateAllowlist (the static counterpart) also rejects the same stripped-allowlist manifest, naming host.change-request-merge', () => {
    const manifest = yaml.load(fs.readFileSync(path.join(ADAPTER_DIR, 'adapter.yaml'), 'utf8'));
    const azEntry = manifest.allowlist.find((e) => e.bin === 'az');
    azEntry.sub = azEntry.sub.filter((s) => s !== 'repos pr update');

    const result = validateAllowlist(manifest);
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.includes("capability 'host.change-request-merge'") && e.includes('not in the allowlist'))
    ).toBe(true);
  });
});

describe('TRD-040-TEST: Scenario "Allowlist matches the real CLI" -- every allowlist entry names a subcommand documented in the recorded (disclosed-synthetic) az-repos-pr-help.txt fixture (Implementation AC 4)', () => {
  test('fixtures/README.md discloses az-repos-pr-help.txt as a synthetic reconstruction, not a captured live run', () => {
    const readme = fs.readFileSync(path.join(ADAPTER_DIR, 'fixtures', 'README.md'), 'utf8');
    expect(readme).toMatch(/synthetic/i);
    expect(readme).toContain('az-repos-pr-help.txt');
    expect(readme).toMatch(/No\s+`az`\s+binary is installed in this environment/);
  });

  test('every allowlist[].sub word (including multi-word entries) is a documented subcommand in the fixture', () => {
    const helpText = fs.readFileSync(HELP_FIXTURE_PATH, 'utf8');
    const manifest = yaml.load(fs.readFileSync(path.join(ADAPTER_DIR, 'adapter.yaml'), 'utf8'));
    const azAllowlist = manifest.allowlist.find((e) => e.bin === 'az');
    expect(azAllowlist.sub.length).toBeGreaterThan(0);

    for (const sub of azAllowlist.sub) {
      // Every allowlist word (or, for a multi-word entry, the exact contiguous phrase) must
      // appear in the recorded `--help` output as a real subcommand/invocation, not merely as
      // a substring of an unrelated word.
      const pattern = new RegExp(`(^|[\\s])${sub.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([\\s]|$)`, 'm');
      expect(helpText).toMatch(pattern);
    }
  });

  test('every capability\'s run[] subcommand phrase is documented in the fixture', () => {
    const helpText = fs.readFileSync(HELP_FIXTURE_PATH, 'utf8');
    const manifest = yaml.load(fs.readFileSync(path.join(ADAPTER_DIR, 'adapter.yaml'), 'utf8'));
    const azAllowlist = manifest.allowlist.find((e) => e.bin === 'az');

    for (const [capabilityId, capability] of Object.entries(manifest.capabilities)) {
      const argvAfterBin = capability.run.slice(1);
      const matchedSub = azAllowlist.sub.find((sub) => {
        const words = sub.split(' ');
        return words.length <= argvAfterBin.length && words.every((word, i) => argvAfterBin[i] === word);
      });
      expect(matchedSub).toBeDefined();
      expect(helpText).toContain(matchedSub);
      // Document which capability was checked, for a clearer failure message.
      expect(typeof capabilityId).toBe('string');
    }
  });
});
