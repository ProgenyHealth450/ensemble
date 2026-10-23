'use strict';
/**
 * Tests for `packages/infrastructure/skills/adapter-tracker-azure-boards` (TRD-2026-8d825f54
 * TRD-033, TRD-033-TEST, PRD REQ-016/REQ-017): the Azure Boards (Azure DevOps Services)
 * `tracker` adapter.
 *
 * This file covers the manifest's own static correctness (schema, allowlist -- including the
 * MULTI-WORD `allowlist[].sub` entries this wave's engine fix
 * (`validate.js`/`runner.js#matchesSubcommandWords`) exists to permit -- conformance,
 * `SKILL.md` vocabulary block, names-only `env`), that the toolchain resolver actually LOADS
 * it (no `NOT_INSTALLED`), the allowlist-vs-recorded-help-fixture AC (Implementation AC 4),
 * and a mutation-proof guard test proving the validators are capable of failing.
 * Capability-by-capability `run[]`/`parse[]` behavior against a stub `az` lives in
 * `scripts/tests/toolchain-adapter-tracker-azure-boards-capabilities.test.js`.
 *
 * No test here spawns a real `az`, `jira`, `br` or `bv` process: the static checks below
 * (`validateAdapterDir`, `loadAdapter`) never execute the manifest's `run[]` templates at all;
 * the one real subprocess this file spawns is the `toolchain-cli.js validate` CLI itself (a
 * static check), never `az`.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const yaml = require('js-yaml');

const { validateAdapterDir, checkVocabularyBlock } = require('../../packages/development/lib/toolchain/validate');
const { loadAdapter } = require('../../packages/development/lib/toolchain/adapters');

const REPO_ROOT = path.join(__dirname, '..', '..');
const ADAPTER_DIR = path.join(REPO_ROOT, 'packages', 'infrastructure', 'skills', 'adapter-tracker-azure-boards');
const CLI_PATH = path.join(REPO_ROOT, 'packages', 'development', 'lib', 'toolchain-cli.js');
const HELP_FIXTURE_PATH = path.join(ADAPTER_DIR, 'fixtures', 'az-boards-help.txt');

const EXPECTED_CAPABILITIES = [
  'tracker.show',
  'tracker.list',
  'tracker.create',
  'tracker.update',
  'tracker.close',
  'tracker.comment',
  'tracker.dep-add'
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
  const dir = mkTempDir('adapter-tracker-azure-boards-mut-');
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

describe('TRD-033-TEST: adapter-tracker-azure-boards manifest passes every static validator', () => {
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

  test('real `node toolchain-cli.js validate` subprocess (non-json) prints "ok"', () => {
    const proc = spawnSync(process.execPath, [CLI_PATH, 'validate', ADAPTER_DIR], { encoding: 'utf8' });
    expect(proc.status).toBe(0);
    expect(proc.stdout.trim()).toBe('ok');
  });

  test('SKILL.md has a ## Vocabulary heading', () => {
    const result = checkVocabularyBlock(path.join(ADAPTER_DIR, 'SKILL.md'));
    expect(result.ok).toBe(true);
  });

  test('SKILL.md names adapter.yaml, documents every declared capability, and documents the known-limit decisions', () => {
    const skillMd = fs.readFileSync(path.join(ADAPTER_DIR, 'SKILL.md'), 'utf8');
    expect(skillMd).toContain('adapter.yaml');
    for (const capability of EXPECTED_CAPABILITIES) {
      expect(skillMd).toContain(capability);
    }
    expect(skillMd).toMatch(/## Known limits/);
    // The dotted-field-vs-mapping-engine decision (JMESPath `--query`, not an engine change).
    expect(skillMd).toMatch(/--query/);
    expect(skillMd).toMatch(/JMESPath/);
    // The tracker.update "fields" destination choice.
    expect(skillMd).toMatch(/--state/);
    // The dependencies[].id-is-a-full-URL limitation.
    expect(skillMd).toMatch(/full relation `url`|not a bare work-item id|full URL/);
    // The synthetic-help-fixture limitation.
    expect(skillMd).toMatch(/synthetic\s+reconstruction/i);
  });

  test('the manifest declares adapter "azure-boards", the tracker-only category, its contract version, names-only env, and exactly the capabilities SKILL.md documents', () => {
    const manifest = yaml.load(fs.readFileSync(path.join(ADAPTER_DIR, 'adapter.yaml'), 'utf8'));
    expect(manifest.adapter).toBe('azure-boards');
    expect(manifest.categories).toEqual(['tracker']);
    expect(manifest.contract).toEqual({ tracker: '1.0' });
    expect(Object.keys(manifest.capabilities).sort()).toEqual([...EXPECTED_CAPABILITIES].sort());
    // env: names only (PRD REQ-022) -- every entry matches the manifest schema's
    // ^[A-Z][A-Z0-9_]*$ pattern, never a literal credential value.
    expect(manifest.env).toEqual(['AZURE_DEVOPS_EXT_PAT']);
    for (const name of manifest.env) {
      expect(name).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
    expect(manifest.detect).toEqual([{ signal: 'remote_url_matches', pattern: 'dev\\.azure\\.com|visualstudio\\.com' }]);
  });

  test('every health check is declared with id/run/timeoutMs, and az-boards-reachable has a 10s timeout', () => {
    const manifest = yaml.load(fs.readFileSync(path.join(ADAPTER_DIR, 'adapter.yaml'), 'utf8'));
    for (const check of manifest.health) {
      expect(typeof check.id).toBe('string');
      expect(Array.isArray(check.run)).toBe(true);
      expect(check.timeoutMs).toBeGreaterThan(0);
    }
    const reachable = manifest.health.find((h) => h.id === 'az-boards-reachable');
    expect(reachable).toBeDefined();
    expect(reachable.timeoutMs).toBe(10000);
    expect(reachable.run).toEqual(['az', 'boards', 'query', '--wiql', 'SELECT [System.Id] FROM WorkItems', '--top', '1']);
  });

  test('the allowlist uses TRD-033\'s multi-word subcommand entries, plus the two health-check-only additions', () => {
    const manifest = yaml.load(fs.readFileSync(path.join(ADAPTER_DIR, 'adapter.yaml'), 'utf8'));
    const azAllowlist = manifest.allowlist.find((e) => e.bin === 'az');
    expect(azAllowlist).toBeDefined();
    expect(azAllowlist.sub.sort()).toEqual(
      [
        'boards work-item show',
        'boards work-item create',
        'boards work-item update',
        'boards query',
        'boards work-item relation add',
        'devops configure',
        'account show',
        '--version',
        'extension show'
      ].sort()
    );
    // At least one entry is genuinely multi-word (space-separated), the thing this wave's
    // engine fix exists to permit.
    expect(azAllowlist.sub.some((sub) => sub.includes(' ') && sub.split(' ').length >= 3)).toBe(true);
  });
});

describe('TRD-033-TEST: every allowlist entry matches the recorded az-boards-help.txt fixture (Implementation AC 4)', () => {
  test('fixtures/az-boards-help.txt exists, is labeled synthetic, and every allowlist[].sub word (including multi-word entries) is a documented subcommand', () => {
    const helpText = fs.readFileSync(HELP_FIXTURE_PATH, 'utf8');
    expect(helpText).toMatch(/SYNTHETIC RECONSTRUCTION/);
    expect(helpText).toMatch(/NOT a captured live/);

    const manifest = yaml.load(fs.readFileSync(path.join(ADAPTER_DIR, 'adapter.yaml'), 'utf8'));
    const azAllowlist = manifest.allowlist.find((e) => e.bin === 'az');
    expect(azAllowlist).toBeDefined();
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

describe('TRD-033-TEST: `az repos` (a host-adapter subcommand) is rejected by this allowlist', () => {
  test('validateAllowlist fails a mutated manifest whose tracker.show calls "az repos show" instead', () => {
    const { validateAllowlist } = require('../../packages/development/lib/toolchain/validate');
    const manifest = yaml.load(fs.readFileSync(path.join(ADAPTER_DIR, 'adapter.yaml'), 'utf8'));
    manifest.capabilities['tracker.show'] = {
      ...manifest.capabilities['tracker.show'],
      run: ['az', 'repos', 'show', '--id', '${id}']
    };
    const result = validateAllowlist(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("'az repos'") && e.includes('not in the allowlist'))).toBe(true);
  });

  test('denyRuntimeAllowlist (the runtime counterpart) also rejects a substituted "az repos ..." argv', () => {
    const { runCapability } = require('../../packages/development/lib/toolchain/runner');
    return (async () => {
      const manifest = yaml.load(fs.readFileSync(path.join(ADAPTER_DIR, 'adapter.yaml'), 'utf8'));
      manifest.capabilities['tracker.show'] = {
        ...manifest.capabilities['tracker.show'],
        run: ['az', 'repos', 'show', '--id', '${id}']
      };
      const result = await runCapability(manifest, 'tracker.show', { id: '123' }, { timeoutMs: 5000 });
      expect(result.ok).toBe(false);
      expect(result.error.code).toBe('NOT_ALLOWED');
      expect(result.error.message).toMatch(/not permitted by the allowlist/);
    })();
  });
});

describe('TRD-033-TEST: the toolchain resolver actually loads adapter "azure-boards" (no NOT_INSTALLED)', () => {
  test('loadAdapter("azure-boards") resolves to the real installed skill directory', () => {
    const result = loadAdapter('azure-boards', { projectRoot: REPO_ROOT });
    expect(result.origin).toBe('installed');
    expect(fs.realpathSync(result.dir)).toBe(fs.realpathSync(ADAPTER_DIR));
    expect(result.manifest.adapter).toBe('azure-boards');
    expect(result.manifest.categories).toEqual(['tracker']);
  });
});

describe('TRD-033-TEST: mutation check proves the validators are capable of failing', () => {
  test('removing "boards work-item show" from the allowlist makes validateAdapterDir fail, naming tracker.show', () => {
    const dir = mkMutableAdapterCopy();
    const manifest = loadMutableManifest(dir);
    const azEntry = manifest.allowlist.find((e) => e.bin === 'az');
    azEntry.sub = azEntry.sub.filter((s) => s !== 'boards work-item show');
    writeMutableManifest(dir, manifest);

    const result = validateAdapterDir(dir);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("capability 'tracker.show'") && e.includes('allowlist'))).toBe(true);
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

  test('setting a literal (non-env-reference) value on a credential-shaped key fails scanCredentials', () => {
    const dir = mkMutableAdapterCopy();
    fs.appendFileSync(
      path.join(dir, 'SKILL.md'),
      '\n```\napi_key: hardcoded-plain-text-secret-value\n```\n'
    );

    const result = validateAdapterDir(dir);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('api_key') && e.includes('literal value'))).toBe(true);
  });

  test('swapping "boards work-item show" for the different 3-word phrase "boards work-item create" still fails (word-for-word positional proof, not just presence)', () => {
    const dir = mkMutableAdapterCopy();
    const manifest = loadMutableManifest(dir);
    const azEntry = manifest.allowlist.find((e) => e.bin === 'az');
    azEntry.sub = azEntry.sub.map((s) => (s === 'boards work-item show' ? 'boards work-item create' : s));
    writeMutableManifest(dir, manifest);

    const result = validateAdapterDir(dir);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("capability 'tracker.show'") && e.includes('allowlist'))).toBe(true);
  });
});
