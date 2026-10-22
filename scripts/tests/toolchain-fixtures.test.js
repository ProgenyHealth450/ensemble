'use strict';
/**
 * Tests for TRD-2026-8d825f54 TRD-009 (PRD REQ-008, AC-008-3): proves the full toolchain
 * validator pipeline (`validateManifest`, `checkVocabularyBlock`, `validateAllowlist`,
 * `scanCredentials`, `validateConformance`, `validateAdapterDir` in
 * packages/development/lib/toolchain/validate.js, plus the `toolchain-cli validate`
 * subcommand entry point in packages/development/lib/toolchain-cli.js) against two STATIC
 * fixture adapter directories on disk under `scripts/tests/fixtures/toolchain/` rather than a
 * built `fs.mkdtempSync` temp dir, per the TRD.
 *
 * Note: `npm run validate` (scripts/validate-all.js) only walks `packages/**`, so these
 * fixtures under `scripts/tests/fixtures/` are never discovered as real installed adapters.
 *
 * The `validateAdapterDir` describe blocks below additionally prove a PR-level review
 * finding: `toolchain-cli validate` used to call only `validateManifest` +
 * `validateConformance`, so an adapter calling an undeclared binary or embedding a literal
 * credential passed `validate` with exit 0. `validateAdapterDir` is the single composed gate
 * all four checks now go through; these tests mutate a temp copy of `good-adapter` (never the
 * static fixture itself) to reproduce that bypass and prove it is closed, both through the
 * exported `validateAdapterDir`/`cliValidate` functions and through a real
 * `node toolchain-cli.js validate` subprocess.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const yaml = require('js-yaml');

const {
  validateManifest,
  checkVocabularyBlock,
  validateAllowlist,
  scanCredentials,
  validateConformance,
  validateAdapterDir
} = require('../../packages/development/lib/toolchain/validate');
const { loadContracts } = require('../../packages/development/lib/toolchain/contracts');
const { validate: cliValidate } = require('../../packages/development/lib/toolchain-cli');

const FIXTURES_ROOT = path.join(__dirname, 'fixtures', 'toolchain');
const GOOD_DIR = path.join(FIXTURES_ROOT, 'good-adapter');
const BROKEN_DIR = path.join(FIXTURES_ROOT, 'broken-adapter');
const CLI_PATH = path.join(__dirname, '..', '..', 'packages', 'development', 'lib', 'toolchain-cli.js');

function loadManifest(dir) {
  return yaml.load(fs.readFileSync(path.join(dir, 'adapter.yaml'), 'utf8'));
}

function adapterFiles(dir) {
  return [path.join(dir, 'adapter.yaml'), path.join(dir, 'SKILL.md')];
}

const tempDirs = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

/**
 * Copy the `good-adapter` fixture into a fresh temp directory outside the repo tree so a test
 * can mutate `adapter.yaml`/`SKILL.md` without ever touching the static fixture on disk.
 * @returns {string} the temp adapter directory
 */
function mkMutableGoodAdapterCopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toolchain-adapter-dir-'));
  tempDirs.push(dir);
  fs.cpSync(GOOD_DIR, dir, { recursive: true });
  return dir;
}

function replaceInFile(filePath, searchValue, replaceValue) {
  const content = fs.readFileSync(filePath, 'utf8');
  if (!content.includes(searchValue)) {
    throw new Error(`replaceInFile: ${filePath} does not contain ${JSON.stringify(searchValue)}`);
  }
  fs.writeFileSync(filePath, content.replace(searchValue, replaceValue));
}

describe('TRD-009-TEST: good-adapter fixture passes every validator with zero errors', () => {
  const manifest = loadManifest(GOOD_DIR);

  test('validateManifest returns {valid:true, errors:[]}', () => {
    expect(validateManifest(GOOD_DIR)).toEqual({ valid: true, errors: [] });
  });

  test('checkVocabularyBlock returns {ok:true}', () => {
    expect(checkVocabularyBlock(path.join(GOOD_DIR, 'SKILL.md'))).toEqual({ ok: true });
  });

  test('validateAllowlist returns {valid:true, errors:[]}', () => {
    expect(validateAllowlist(manifest)).toEqual({ valid: true, errors: [] });
  });

  test('scanCredentials returns {valid:true, errors:[]}', () => {
    expect(scanCredentials(adapterFiles(GOOD_DIR))).toEqual({ valid: true, errors: [] });
  });

  test('validateConformance returns {ok:true, errors:[]}', () => {
    expect(validateConformance(manifest, loadContracts())).toEqual({ ok: true, errors: [] });
  });

  test('toolchain-cli validate subcommand returns {ok:true, errors:[]} end to end', () => {
    expect(cliValidate({}, [GOOD_DIR])).toEqual({ ok: true, errors: [] });
  });
});

describe('TRD-009-TEST: broken-adapter fixture is structurally valid but fails conformance/allowlist/credential checks', () => {
  const manifest = loadManifest(BROKEN_DIR);

  test('validateManifest still returns {valid:true, errors:[]} (the three defects are not structural-schema violations)', () => {
    expect(validateManifest(BROKEN_DIR)).toEqual({ valid: true, errors: [] });
  });

  test('validateAllowlist fails naming both the undeclared binary and the capability that calls it', () => {
    const result = validateAllowlist(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('rogue-tool') && e.includes('tracker.show'))).toBe(true);
  });

  test('scanCredentials fails naming the SKILL.md credential file', () => {
    const result = scanCredentials(adapterFiles(BROKEN_DIR));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('SKILL.md'))).toBe(true);
  });

  test('validateConformance fails naming the missing required capability', () => {
    const result = validateConformance(manifest, loadContracts());
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('tracker.close'))).toBe(true);
  });

  test('toolchain-cli validate subcommand surfaces the conformance defect end to end', () => {
    const result = cliValidate({}, [BROKEN_DIR]);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('tracker.close'))).toBe(true);
  });

  test('combined errors from validateAllowlist + scanCredentials + validateConformance list all three defects (Implementation AC 1)', () => {
    const combined = [
      ...validateAllowlist(manifest).errors,
      ...scanCredentials(adapterFiles(BROKEN_DIR)).errors,
      ...validateConformance(manifest, loadContracts()).errors
    ];
    expect(combined.some((e) => e.includes('tracker.close'))).toBe(true);
    expect(combined.some((e) => e.includes('rogue-tool'))).toBe(true);
    expect(combined.some((e) => e.includes('SKILL.md'))).toBe(true);
  });
});

describe('TRD-009-TEST: mutation check proves the broken-fixture assertion is capable of failing (Implementation AC 3)', () => {
  /**
   * Encapsulates the "broken fixture must fail conformance naming tracker.close" assertion
   * behind an injectable `validateConformanceFn`, so the check itself can be proven
   * discriminating: it passes against the real `validateConformance` and throws when a
   * no-op "always pass" stub is substituted for it.
   */
  function assertBrokenFixtureFails(validateConformanceFn) {
    const manifest = loadManifest(BROKEN_DIR);
    const result = validateConformanceFn(manifest, loadContracts());
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('tracker.close'))).toBe(true);
  }

  test('the real validateConformance makes the helper pass', () => {
    expect(() => assertBrokenFixtureFails(validateConformance)).not.toThrow();
  });

  test('an always-pass stub in place of validateConformance makes the helper throw', () => {
    const alwaysPassStub = () => ({ ok: true, errors: [] });
    expect(() => assertBrokenFixtureFails(alwaysPassStub)).toThrow();
  });

  test('a stub that still fails but names the wrong capability makes the helper throw (proves the specific-capability-name clause is load-bearing, not just the ok:false gate)', () => {
    const wrongCapabilityStub = () => ({
      ok: false,
      errors: ["fixture-broken-tracker: missing required capability 'tracker.show' for category 'tracker'"]
    });
    expect(() => assertBrokenFixtureFails(wrongCapabilityStub)).toThrow();
  });

  /**
   * Same discriminating-power proof as `assertBrokenFixtureFails` above, but for the
   * combined-errors assertion (Implementation AC 1) rather than `validateConformance` alone:
   * encapsulates the "all three defects are named somewhere in the combined errors" check
   * behind injectable validator functions so it can be shown to pass against the real
   * validators and throw when they are replaced by always-pass stubs.
   */
  function assertCombinedDefectsPresent(allowlistFn, scanCredentialsFn, conformanceFn) {
    const manifest = loadManifest(BROKEN_DIR);
    const combined = [
      ...allowlistFn(manifest).errors,
      ...scanCredentialsFn(adapterFiles(BROKEN_DIR)).errors,
      ...conformanceFn(manifest, loadContracts()).errors
    ];
    expect(combined.some((e) => e.includes('tracker.close'))).toBe(true);
    expect(combined.some((e) => e.includes('rogue-tool'))).toBe(true);
    expect(combined.some((e) => e.includes('SKILL.md'))).toBe(true);
  }

  test('the real validators make the combined-defects helper pass', () => {
    expect(() => assertCombinedDefectsPresent(validateAllowlist, scanCredentials, validateConformance)).not.toThrow();
  });

  test('always-pass stubs for all three validators make the combined-defects helper throw', () => {
    const alwaysPassValid = () => ({ valid: true, errors: [] });
    const alwaysPassOk = () => ({ ok: true, errors: [] });
    expect(() => assertCombinedDefectsPresent(alwaysPassValid, alwaysPassValid, alwaysPassOk)).toThrow();
  });
});

describe("TRD-009-TEST: validateAdapterDir composes all four static checks (PR review finding 1: 'toolchain-cli validate' had no caller for validateAllowlist/scanCredentials)", () => {
  test('(structural) an otherwise conformant adapter missing the SKILL.md Vocabulary block fails via validateManifest, naming SKILL.md', () => {
    const dir = mkMutableGoodAdapterCopy();
    const skillMdPath = path.join(dir, 'SKILL.md');
    replaceInFile(skillMdPath, '## Vocabulary', '## Terminology');
    const result = validateAdapterDir(dir);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes(skillMdPath) && e.includes('Vocabulary'))).toBe(true);
  });

  test('(a) structurally valid, conformant adapter calling an undeclared binary fails naming the binary and the capability', () => {
    const dir = mkMutableGoodAdapterCopy();
    replaceInFile(
      path.join(dir, 'adapter.yaml'),
      'run: ["fixture-tool", "show", "--id", "${id}"]',
      'run: ["curl", "show", "--id", "${id}"]'
    );
    const result = validateAdapterDir(dir);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('curl') && e.includes("capability 'tracker.show'"))).toBe(true);
  });

  test('(b) adapter calling a declared binary with a subcommand not in its allowlist fails naming both', () => {
    const dir = mkMutableGoodAdapterCopy();
    replaceInFile(
      path.join(dir, 'adapter.yaml'),
      'run: ["fixture-tool", "show", "--id", "${id}"]',
      'run: ["fixture-tool", "destroy", "--id", "${id}"]'
    );
    const result = validateAdapterDir(dir);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("'fixture-tool destroy'") && e.includes('not in the allowlist'))).toBe(
      true
    );
  });

  test('(c) SKILL.md prose with a literal ghp_ token fails naming SKILL.md', () => {
    const dir = mkMutableGoodAdapterCopy();
    const skillMdPath = path.join(dir, 'SKILL.md');
    fs.appendFileSync(skillMdPath, '\nSupport contact token: ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n');
    const result = validateAdapterDir(dir);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes(skillMdPath) && e.includes('well-known secret token pattern'))).toBe(
      true
    );
  });

  test('(d) adapter.yaml with a credential-key literal (e.g. token: abc123literal) fails naming adapter.yaml and the key', () => {
    const dir = mkMutableGoodAdapterCopy();
    const manifestPath = path.join(dir, 'adapter.yaml');
    replaceInFile(manifestPath, 'detect: []', 'detect:\n  - signal: file_exists\n    token: abc123literal\n');
    const result = validateAdapterDir(dir);
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) => e.includes(manifestPath) && e.includes("'token'") && e.includes('literal value'))
    ).toBe(true);
  });

  test('(e) the unmodified good-adapter fixture still passes with {ok:true, errors:[]}', () => {
    expect(validateAdapterDir(GOOD_DIR)).toEqual({ ok: true, errors: [] });
  });

  test('toolchain-cli validate (cliValidate) surfaces the same four-check union as validateAdapterDir', () => {
    const dir = mkMutableGoodAdapterCopy();
    replaceInFile(
      path.join(dir, 'adapter.yaml'),
      'run: ["fixture-tool", "show", "--id", "${id}"]',
      'run: ["curl", "show", "--id", "${id}"]'
    );
    expect(cliValidate({}, [dir])).toEqual(validateAdapterDir(dir));
  });
});

describe('TRD-009-TEST: real `node toolchain-cli.js validate` subprocess (PR review finding 1)', () => {
  test('(f) broken-adapter fixture: non-zero exit, stdout JSON names rogue-tool, SKILL.md and tracker.close', () => {
    const result = spawnSync(process.execPath, [CLI_PATH, 'validate', BROKEN_DIR, '--json'], { encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.errors.some((e) => e.includes('rogue-tool'))).toBe(true);
    expect(parsed.errors.some((e) => e.includes('SKILL.md'))).toBe(true);
    expect(parsed.errors.some((e) => e.includes('tracker.close'))).toBe(true);
  });

  test('good-adapter fixture: exit 0, stdout JSON {ok:true, errors:[]}', () => {
    const result = spawnSync(process.execPath, [CLI_PATH, 'validate', GOOD_DIR, '--json'], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ok: true, errors: [] });
  });
});

describe('TRD-009-TEST: credential-scan caps fail closed instead of silently dropping files (independent re-review finding 1)', () => {
  test('a planted credential past MAX_SCAN_FILES yields ok:false naming the cap, never a silent ok:true', () => {
    const dir = mkMutableGoodAdapterCopy();
    const fillerDir = path.join(dir, 'filler');
    fs.mkdirSync(fillerDir);
    for (let i = 0; i < 510; i += 1) {
      fs.writeFileSync(path.join(fillerDir, `filler-${i}.txt`), 'nothing to see here\n');
    }
    const secretDir = path.join(dir, 'zz');
    fs.mkdirSync(secretDir);
    fs.writeFileSync(path.join(secretDir, 'secret.yaml'), 'password: hunter2secret\n');

    const result = validateAdapterDir(dir);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('MAX_SCAN_FILES') && e.includes('500'))).toBe(true);
  });

  test('a file over MAX_SCAN_FILE_BYTES yields ok:false naming that file', () => {
    const dir = mkMutableGoodAdapterCopy();
    const bigFilePath = path.join(dir, 'oversized.txt');
    fs.writeFileSync(bigFilePath, 'a'.repeat(1024 * 1024 + 1));

    const result = validateAdapterDir(dir);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes(bigFilePath) && e.includes('MAX_SCAN_FILE_BYTES'))).toBe(true);
  });

  test('nesting deeper than MAX_SCAN_DEPTH yields ok:false naming the cap', () => {
    const dir = mkMutableGoodAdapterCopy();
    let nested = dir;
    for (let i = 0; i < 7; i += 1) {
      nested = path.join(nested, `d${i}`);
      fs.mkdirSync(nested);
    }
    fs.writeFileSync(path.join(nested, 'unreachable.txt'), 'password: hunter2secret\n');

    const result = validateAdapterDir(dir);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('MAX_SCAN_DEPTH') && e.includes('6'))).toBe(true);
  });
});

describe('TRD-009-TEST: credential-scan walk never follows symlinks out of the adapter directory (independent re-review finding 2)', () => {
  test('a symlinked file and a symlinked directory pointing outside the adapter, each hiding a planted credential, are not followed', () => {
    const dir = mkMutableGoodAdapterCopy();

    const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'toolchain-external-'));
    tempDirs.push(externalRoot);
    const externalFile = path.join(externalRoot, 'external-secret.yaml');
    fs.writeFileSync(externalFile, 'password: hunter2secret\n');
    const externalDir = path.join(externalRoot, 'external-dir');
    fs.mkdirSync(externalDir);
    fs.writeFileSync(path.join(externalDir, 'nested-secret.yaml'), 'password: hunter2secret\n');

    fs.symlinkSync(externalFile, path.join(dir, 'linked-file.yaml'), 'file');
    fs.symlinkSync(externalDir, path.join(dir, 'linked-dir'), 'dir');

    expect(cliValidate({}, [dir])).toEqual({ ok: true, errors: [] });
  });
});
