'use strict';
/**
 * Tests for TRD-2026-8d825f54 TRD-005: `validateManifest(dir)` / `checkVocabularyBlock(skillMdPath)`
 * in packages/development/lib/toolchain/validate.js, validating `adapter.yaml` against
 * `packages/development/toolchain/schemas/adapter-manifest-schema.json` and requiring a
 * `## Vocabulary` block in the adapter's `SKILL.md` (PRD REQ-005, AC-005-2).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');

const { validateManifest, checkVocabularyBlock } = require('../../packages/development/lib/toolchain/validate');

const tempDirs = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

const VALID_SKILL_MD = ['# Example Tracker Adapter', '', '## Vocabulary', '', '- show: read a work item by id', ''].join(
  '\n'
);

const NO_VOCABULARY_SKILL_MD = ['# Example Tracker Adapter', '', '## Usage', '', 'Nothing here names a vocabulary.', ''].join(
  '\n'
);

function validManifest(overrides = {}) {
  return {
    adapter: 'example-tracker',
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

function mkAdapterDir({ manifest, manifestRaw, skillMd = VALID_SKILL_MD, skillMdIsDir = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-'));
  tempDirs.push(dir);
  if (manifestRaw !== undefined) {
    fs.writeFileSync(path.join(dir, 'adapter.yaml'), manifestRaw);
  } else if (manifest !== null) {
    fs.writeFileSync(path.join(dir, 'adapter.yaml'), yaml.dump(manifest));
  }
  if (skillMdIsDir) {
    fs.mkdirSync(path.join(dir, 'SKILL.md'));
  } else if (skillMd !== null) {
    fs.writeFileSync(path.join(dir, 'SKILL.md'), skillMd);
  }
  return dir;
}

describe('checkVocabularyBlock', () => {
  test('AC-005-2: a SKILL.md missing the ## Vocabulary heading fails naming the file and the missing block', () => {
    const dir = mkAdapterDir({ manifest: validManifest(), skillMd: NO_VOCABULARY_SKILL_MD });
    const skillMdPath = path.join(dir, 'SKILL.md');

    const result = checkVocabularyBlock(skillMdPath);

    expect(result.ok).toBe(false);
    expect(result.error).toContain(skillMdPath);
    expect(result.error).toContain('Vocabulary');
  });

  test('a SKILL.md with a ## Vocabulary heading passes', () => {
    const dir = mkAdapterDir({ manifest: validManifest() });

    const result = checkVocabularyBlock(path.join(dir, 'SKILL.md'));

    expect(result).toEqual({ ok: true });
  });
});

describe('validateManifest', () => {
  test('a valid manifest and SKILL.md returns no errors', () => {
    const dir = mkAdapterDir({ manifest: validManifest() });

    const result = validateManifest(dir);

    expect(result).toEqual({ valid: true, errors: [] });
  });

  test('AC-005-2: a SKILL.md missing the ## Vocabulary heading fails validation naming the file and the missing block', () => {
    const dir = mkAdapterDir({ manifest: validManifest(), skillMd: NO_VOCABULARY_SKILL_MD });

    const result = validateManifest(dir);

    const skillMdPath = path.join(dir, 'SKILL.md');
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes(skillMdPath) && error.includes('Vocabulary'))).toBe(true);
  });

  test("an adapter.yaml missing 'allowlist' fails validation naming the file and the missing property", () => {
    const manifest = validManifest();
    delete manifest.allowlist;
    const dir = mkAdapterDir({ manifest });

    const result = validateManifest(dir);

    const manifestPath = path.join(dir, 'adapter.yaml');
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes(manifestPath) && error.includes('allowlist'))).toBe(true);
  });

  test('a capability variants selector not declared as a contract input fails naming the capability and the selector', () => {
    const manifest = validManifest({
      capabilities: {
        'tracker.show': {
          run: ['example-tool', 'show'],
          variants: {
            notaninput: { foo: ['example-tool', 'show-foo'] }
          }
        }
      }
    });
    const dir = mkAdapterDir({ manifest });

    const result = validateManifest(dir);

    expect(result.valid).toBe(false);
    expect(
      result.errors.some((error) => error.includes("'tracker.show'") && error.includes("'notaninput'"))
    ).toBe(true);
  });

  test("a capability variants selector declared as a contract input ('tracker.show' input 'id') passes", () => {
    const manifest = validManifest({
      capabilities: {
        'tracker.show': {
          run: ['example-tool', 'show'],
          variants: {
            id: { foo: ['example-tool', 'show', 'foo'] }
          }
        }
      }
    });
    const dir = mkAdapterDir({ manifest });

    const result = validateManifest(dir);

    expect(result).toEqual({ valid: true, errors: [] });
  });

  test('a missing adapter.yaml fails validation naming the file', () => {
    const dir = mkAdapterDir({ manifest: null, skillMd: VALID_SKILL_MD });

    const result = validateManifest(dir);

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes(path.join(dir, 'adapter.yaml')))).toBe(true);
  });
  test("a capability with 'variants' not declared in its category contract at all fails naming the capability (not a sibling capability's inputs)", () => {
    const manifest = validManifest({
      capabilities: {
        'tracker.list': {
          run: ['example-tool', 'list'],
          // 'title' IS a declared input of the sibling tracker.create capability, so a bug that
          // fell back to the wrong capability's inputs (or to []) must not silently pass this.
          variants: {
            title: { foo: ['example-tool', 'list', '--title', 'foo'] }
          }
        }
      }
    });
    const dir = mkAdapterDir({ manifest });

    const result = validateManifest(dir);

    expect(result.valid).toBe(false);
    expect(
      result.errors.some((error) => error.includes("'tracker.list'") && error.includes('not declared in the'))
    ).toBe(true);
  });

  test("a declared category with no matching 'contract' entry fails naming the category", () => {
    const manifest = validManifest({ categories: ['tracker', 'lint'] });
    const dir = mkAdapterDir({ manifest });

    const result = validateManifest(dir);

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes("'lint'") && error.includes("'contract'"))).toBe(true);
  });

  test("a 'contract' entry for a category not declared in 'categories' fails", () => {
    const manifest = validManifest({ contract: { tracker: '1.0', bogus: '1.0' } });
    const dir = mkAdapterDir({ manifest });

    const result = validateManifest(dir);

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes("'bogus'") && error.includes("'categories'"))).toBe(true);
  });

  test('a malformed adapter.yaml (invalid YAML) fails validation naming the file instead of throwing', () => {
    const dir = mkAdapterDir({ manifestRaw: 'detect: []\n  : : bad\n' });

    const result = validateManifest(dir);

    const manifestPath = path.join(dir, 'adapter.yaml');
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes(manifestPath))).toBe(true);
  });

  test('a SKILL.md that is a directory fails validation naming the file instead of throwing', () => {
    const dir = mkAdapterDir({ manifest: validManifest(), skillMdIsDir: true });

    const result = validateManifest(dir);

    const skillMdPath = path.join(dir, 'SKILL.md');
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes(skillMdPath))).toBe(true);
  });

  test('a SKILL.md with a suffixed ## Vocabulary heading (e.g. "## Vocabulary of Terms") passes', () => {
    const skillMd = ['# Example Tracker Adapter', '', '## Vocabulary of Terms', '', '- show: read a work item by id', ''].join(
      '\n'
    );
    const dir = mkAdapterDir({ manifest: validManifest(), skillMd });

    const result = validateManifest(dir);

    expect(result).toEqual({ valid: true, errors: [] });
  });

  test('an h3 "### Vocabulary" heading still fails (not a ## Vocabulary block)', () => {
    const skillMd = ['# Example Tracker Adapter', '', '### Vocabulary', '', '- show: read a work item by id', ''].join(
      '\n'
    );
    const dir = mkAdapterDir({ manifest: validManifest(), skillMd });

    const result = validateManifest(dir);

    expect(result.valid).toBe(false);
  });

  test('duplicate entries in categories fail schema validation', () => {
    const manifest = validManifest({ categories: ['tracker', 'tracker'] });
    const dir = mkAdapterDir({ manifest });

    const result = validateManifest(dir);

    expect(result.valid).toBe(false);
  });

  test('an env entry that is not an uppercase name fails schema validation', () => {
    const manifest = validManifest({ env: ['not_a_valid_name'] });
    const dir = mkAdapterDir({ manifest });

    const result = validateManifest(dir);

    expect(result.valid).toBe(false);
  });

  test('a health entry missing timeoutMs fails schema validation naming the missing property', () => {
    const manifest = validManifest({ health: [{ id: 'version', run: ['example-tool', '--version'] }] });
    const dir = mkAdapterDir({ manifest });

    const result = validateManifest(dir);

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes('timeoutMs'))).toBe(true);
  });

  test('a detect entry with an unrecognized signal fails schema validation', () => {
    const manifest = validManifest({ detect: [{ signal: 'not_a_real_signal' }] });
    const dir = mkAdapterDir({ manifest });

    const result = validateManifest(dir);

    expect(result.valid).toBe(false);
  });
});
