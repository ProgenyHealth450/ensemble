'use strict';
/**
 * Tests for TRD-2026-8d825f54 TRD-009 (PRD REQ-008, AC-008-3): proves the full toolchain
 * validator pipeline (`validateManifest`, `checkVocabularyBlock`, `validateAllowlist`,
 * `scanCredentials`, `validateConformance` in packages/development/lib/toolchain/validate.js,
 * plus the `toolchain-cli validate` subcommand entry point in
 * packages/development/lib/toolchain-cli.js) against two STATIC fixture adapter directories
 * on disk under `scripts/tests/fixtures/toolchain/` rather than a built `fs.mkdtempSync` temp
 * dir, per the TRD.
 *
 * Note: `npm run validate` (scripts/validate-all.js) only walks `packages/**`, so these
 * fixtures under `scripts/tests/fixtures/` are never discovered as real installed adapters.
 */

const fs = require('fs');
const path = require('path');

const yaml = require('js-yaml');

const {
  validateManifest,
  checkVocabularyBlock,
  validateAllowlist,
  scanCredentials,
  validateConformance
} = require('../../packages/development/lib/toolchain/validate');
const { loadContracts } = require('../../packages/development/lib/toolchain/contracts');
const { validate: cliValidate } = require('../../packages/development/lib/toolchain-cli');

const FIXTURES_ROOT = path.join(__dirname, 'fixtures', 'toolchain');
const GOOD_DIR = path.join(FIXTURES_ROOT, 'good-adapter');
const BROKEN_DIR = path.join(FIXTURES_ROOT, 'broken-adapter');

function loadManifest(dir) {
  return yaml.load(fs.readFileSync(path.join(dir, 'adapter.yaml'), 'utf8'));
}

function adapterFiles(dir) {
  return [path.join(dir, 'adapter.yaml'), path.join(dir, 'SKILL.md')];
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
