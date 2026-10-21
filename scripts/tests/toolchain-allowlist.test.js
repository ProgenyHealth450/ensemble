'use strict';
/**
 * Tests for TRD-2026-8d825f54 TRD-008: `validateAllowlist(manifest)` / `scanCredentials(files)`
 * in packages/development/lib/toolchain/validate.js — static per-adapter binary/subcommand
 * allowlist validation (including `variants` run templates) and literal-credential scanning,
 * scoped to YAML files versus fenced code blocks in Markdown to reduce false positives (PRD
 * REQ-022, REQ-023; AC-022-1, AC-023-1, AC-023-3).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { validateAllowlist, scanCredentials } = require('../../packages/development/lib/toolchain/validate');

const tempDirs = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

function mkTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toolchain-allowlist-'));
  tempDirs.push(dir);
  return dir;
}

function writeFile(dir, name, content) {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content);
  return filePath;
}

function validManifest(overrides = {}) {
  return {
    adapter: 'example-tracker',
    binaries: ['example-tool'],
    allowlist: [{ bin: 'example-tool', sub: ['show', 'version'] }],
    health: [{ id: 'version', run: ['example-tool', 'version'], timeoutMs: 5000 }],
    capabilities: {
      'tracker.show': { run: ['example-tool', 'show', '--id', '${id}'] }
    },
    ...overrides
  };
}

describe('validateAllowlist', () => {
  test('a conforming manifest (capability and health both call allowlisted binary+subcommand) returns no errors', () => {
    const result = validateAllowlist(validManifest());

    expect(result).toEqual({ valid: true, errors: [] });
  });

  test('AC-023-1: a capability whose run[0] is curl while binaries lacks curl fails naming the adapter and the binary', () => {
    const manifest = validManifest({
      capabilities: {
        'tracker.fetch': { run: ['curl', 'https://example.com/issues'] }
      }
    });

    const result = validateAllowlist(manifest);

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes('example-tracker') && error.includes('curl'))).toBe(true);
  });

  test('AC-023-1: a binary absent from binaries still fails even when an allowlist entry for it exists (proves the undeclared-binary guard, not merely the allowlist-entry lookup, is what rejects it)', () => {
    const manifest = validManifest({
      binaries: ['example-tool'],
      allowlist: [
        { bin: 'example-tool', sub: ['show', 'version'] },
        { bin: 'curl', sub: ['get'] }
      ],
      health: [],
      capabilities: {
        'tracker.fetch': { run: ['curl', 'get', 'https://example.com'] }
      }
    });

    const result = validateAllowlist(manifest);

    expect(result.valid).toBe(false);
    expect(
      result.errors.some(
        (error) => error.includes('example-tracker') && error.includes('curl') && error.includes("not declared in 'binaries'")
      )
    ).toBe(true);
  });

  test("AC-023-3: a capability calling 'br' with subcommand 'delete' while the 'br' allowlist lists only 'show'/'list' fails naming the adapter and the subcommand", () => {
    const manifest = validManifest({
      binaries: ['br'],
      allowlist: [{ bin: 'br', sub: ['show', 'list'] }],
      health: [],
      capabilities: {
        'tracker.delete': { run: ['br', 'delete', '--id', '${id}'] }
      }
    });

    const result = validateAllowlist(manifest);

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes('example-tracker') && error.includes('delete'))).toBe(true);
  });

  test('a binary declared in binaries but with no allowlist entry at all fails naming the adapter and the binary, with an error distinct from the subcommand-not-allowed case', () => {
    const manifest = validManifest({
      binaries: ['curl'],
      allowlist: [],
      health: [],
      capabilities: {
        'tracker.fetch': { run: ['curl', 'get', 'https://example.com'] }
      }
    });

    const result = validateAllowlist(manifest);

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes('example-tracker') && error.includes('curl'))).toBe(true);
    expect(result.errors.some((error) => error.includes('no') && error.includes('allowlist') && error.includes('entry'))).toBe(
      true
    );
    expect(result.errors.some((error) => error.includes('is not in the allowlist for'))).toBe(false);
  });

  test('a health check calling an undeclared binary fails naming the adapter and the binary', () => {
    const manifest = validManifest({
      health: [{ id: 'ping', run: ['ping', '-c', '1', 'example.com'], timeoutMs: 2000 }]
    });

    const result = validateAllowlist(manifest);

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes('example-tracker') && error.includes('ping'))).toBe(true);
  });

  test('a health check calling an allowed binary with a subcommand not on its allowlist fails naming the adapter and the subcommand', () => {
    const manifest = validManifest({
      health: [{ id: 'reset', run: ['example-tool', 'reset'], timeoutMs: 2000 }]
    });

    const result = validateAllowlist(manifest);

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes('example-tracker') && error.includes('reset'))).toBe(true);
  });

  test("a capability variant run (variants.runner.rspec) calling 'git push --force' while the allowlist permits only 'git status' fails naming the adapter, the variant and the subcommand", () => {
    const manifest = validManifest({
      binaries: ['git'],
      allowlist: [{ bin: 'git', sub: ['status'] }],
      health: [],
      capabilities: {
        'test.run': {
          run: ['git', 'status'],
          variants: {
            runner: {
              rspec: ['git', 'push', '--force']
            }
          }
        }
      }
    });

    const result = validateAllowlist(manifest);

    expect(result.valid).toBe(false);
    expect(
      result.errors.some(
        (error) =>
          error.includes('example-tracker') &&
          error.includes("variant 'runner=rspec'") &&
          error.includes('push')
      )
    ).toBe(true);
  });

  test('a conforming capability variant run (variants.runner.rspec calling the allowlisted git status) returns no errors', () => {
    const manifest = validManifest({
      binaries: ['git'],
      allowlist: [{ bin: 'git', sub: ['status'] }],
      health: [],
      capabilities: {
        'test.run': {
          run: ['git', 'status'],
          variants: {
            runner: {
              rspec: ['git', 'status']
            }
          }
        }
      }
    });

    const result = validateAllowlist(manifest);

    expect(result).toEqual({ valid: true, errors: [] });
  });
});

describe('scanCredentials', () => {
  test('AC-022-1: an adapter.yaml containing a literal ghp_ token (36 alphanumerics) fails naming that file path', () => {
    const dir = mkTempDir();
    const filePath = writeFile(
      dir,
      'adapter.yaml',
      ['adapter: example-tracker', 'version: 1.0.0', `token: ghp_${'x'.repeat(36)}`, ''].join('\n')
    );

    const result = scanCredentials([filePath]);

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes(filePath))).toBe(true);
  });

  test('the same adapter.yaml with only env: [GITHUB_TOKEN] (no literal token) passes with no errors', () => {
    const dir = mkTempDir();
    const filePath = writeFile(
      dir,
      'adapter.yaml',
      ['adapter: example-tracker', 'version: 1.0.0', 'env: [GITHUB_TOKEN]', ''].join('\n')
    );

    const result = scanCredentials([filePath]);

    expect(result).toEqual({ valid: true, errors: [] });
  });

  test('AC-022-1: a toolchain config file containing a literal password: hunter2 fails naming that config file', () => {
    const dir = mkTempDir();
    const filePath = writeFile(dir, 'toolchain.yaml', ['tracker: github', 'password: hunter2', ''].join('\n'));

    const result = scanCredentials([filePath]);

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes(filePath))).toBe(true);
  });

  test("a token value using '${GITHUB_TOKEN}'-style interpolation (not a literal) passes with no errors", () => {
    const dir = mkTempDir();
    const filePath = writeFile(dir, 'adapter.yaml', ['adapter: example-tracker', 'token: ${GITHUB_TOKEN}', ''].join('\n'));

    const result = scanCredentials([filePath]);

    expect(result).toEqual({ valid: true, errors: [] });
  });

  test('a GitLab glpat- personal access token fails naming the file path', () => {
    const dir = mkTempDir();
    const filePath = writeFile(dir, 'adapter.yaml', [`secret: glpat-${'a'.repeat(20)}`, ''].join('\n'));

    const result = scanCredentials([filePath]);

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes(filePath))).toBe(true);
  });

  test('an OpenAI-style sk- secret key fails naming the file path', () => {
    const dir = mkTempDir();
    const filePath = writeFile(dir, 'SKILL.md', ['Example key line:', `sk-${'b'.repeat(40)}`, ''].join('\n'));

    const result = scanCredentials([filePath]);

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes(filePath))).toBe(true);
  });

  test('a clean SKILL.md with a Vocabulary block and no credential-shaped keys passes with no errors', () => {
    const dir = mkTempDir();
    const filePath = writeFile(
      dir,
      'SKILL.md',
      ['# Example Tracker Adapter', '', '## Vocabulary', '', '- show: read a work item by id', ''].join('\n')
    );

    const result = scanCredentials([filePath]);

    expect(result).toEqual({ valid: true, errors: [] });
  });

  test('scanning multiple files reports the offending file only, naming it, and leaves the clean file unmentioned', () => {
    const dir = mkTempDir();
    const badFile = writeFile(dir, 'adapter.yaml', ['password: hunter2', ''].join('\n'));
    const goodFile = writeFile(dir, 'SKILL.md', ['## Vocabulary', '', '- show: read a work item by id', ''].join('\n'));

    const result = scanCredentials([badFile, goodFile]);

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes(badFile))).toBe(true);
    expect(result.errors.some((error) => error.includes(goodFile))).toBe(false);
  });
});

describe('scanCredentials: well-known secret token prefixes (one case + one near-miss per pattern)', () => {
  const CREDENTIAL_PREFIX_CASES = [
    ['ghp_', `ghp_${'x'.repeat(36)}`, `ghp_${'x'.repeat(35)}`],
    ['gho_', `gho_${'x'.repeat(36)}`, `gho_${'x'.repeat(35)}`],
    ['ghu_', `ghu_${'x'.repeat(36)}`, `ghu_${'x'.repeat(35)}`],
    ['ghs_', `ghs_${'x'.repeat(36)}`, `ghs_${'x'.repeat(35)}`],
    ['ghr_', `ghr_${'x'.repeat(36)}`, `ghr_${'x'.repeat(35)}`],
    ['glpat-', `glpat-${'a'.repeat(20)}`, `glpat-${'a'.repeat(19)}`],
    ['sk-', `sk-${'b'.repeat(20)}`, `sk-${'b'.repeat(19)}`],
    ['AKIA', `AKIA${'A'.repeat(16)}`, `AKIA${'A'.repeat(15)}`],
    ['ASIA', `ASIA${'A'.repeat(16)}`, `ASIA${'A'.repeat(15)}`],
    ['AIza', `AIza${'A'.repeat(35)}`, `AIza${'A'.repeat(34)}`],
    ['xox[baprs]-', `xoxb-${'1'.repeat(10)}`, `xoxq-${'1'.repeat(10)}`]
  ];

  describe.each(CREDENTIAL_PREFIX_CASES)('pattern %s', (name, matchValue, nearMissValue) => {
    test(`a literal value matching the ${name} pattern is rejected naming the file path`, () => {
      const dir = mkTempDir();
      const filePath = writeFile(dir, 'adapter.yaml', ['Example value:', matchValue, ''].join('\n'));

      const result = scanCredentials([filePath]);

      expect(result.valid).toBe(false);
      expect(result.errors.some((error) => error.includes(filePath))).toBe(true);
    });

    test(`a near-miss value that does not satisfy the ${name} pattern is not rejected by the prefix scan`, () => {
      const dir = mkTempDir();
      const filePath = writeFile(dir, 'adapter.yaml', [`note: ${nearMissValue}`, ''].join('\n'));

      const result = scanCredentials([filePath]);

      expect(result).toEqual({ valid: true, errors: [] });
    });
  });
});

describe('scanCredentials: credential-shaped key names', () => {
  const CREDENTIAL_KEY_NAME_CASES = [
    'password',
    'secret',
    'token',
    'api_key',
    'apikey',
    'access_key',
    'private_key',
    'client_secret',
    'auth',
    'bearer'
  ];

  describe.each(CREDENTIAL_KEY_NAME_CASES)("key '%s'", (keyName) => {
    test(`a literal ${keyName} value in a YAML file fails naming the file path`, () => {
      const dir = mkTempDir();
      const filePath = writeFile(dir, 'adapter.yaml', [`${keyName}: literal-value-123`, ''].join('\n'));

      const result = scanCredentials([filePath]);

      expect(result.valid).toBe(false);
      expect(result.errors.some((error) => error.includes(filePath))).toBe(true);
    });

    test(`an environment-variable-name ${keyName} value in a YAML file passes with no errors`, () => {
      const dir = mkTempDir();
      const filePath = writeFile(dir, 'adapter.yaml', [`${keyName}: SOME_ENV_VAR_NAME`, ''].join('\n'));

      const result = scanCredentials([filePath]);

      expect(result).toEqual({ valid: true, errors: [] });
    });
  });
});

describe('scanCredentials: YAML files versus fenced code blocks in Markdown (false-positive reduction)', () => {
  test('a fenced yaml code block in SKILL.md containing a literal token value fails naming the file path', () => {
    const dir = mkTempDir();
    const filePath = writeFile(
      dir,
      'SKILL.md',
      [
        '# Example Tracker Adapter',
        '',
        '## Vocabulary',
        '',
        '- show: read a work item by id',
        '',
        '```yaml',
        'token: abc123literal',
        '```',
        ''
      ].join('\n')
    );

    const result = scanCredentials([filePath]);

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes(filePath))).toBe(true);
  });

  test('prose outside a fenced code block that happens to read like a credential-shaped key does not fail', () => {
    const dir = mkTempDir();
    const filePath = writeFile(
      dir,
      'SKILL.md',
      [
        '# Example Tracker Adapter',
        '',
        '## Vocabulary',
        '',
        '- show: read a work item by id',
        '',
        '## Configuration',
        '',
        'The API token is read from the environment.',
        '',
        "Auth: handled automatically by the gh CLI's credential helper.",
        ''
      ].join('\n')
    );

    const result = scanCredentials([filePath]);

    expect(result).toEqual({ valid: true, errors: [] });
  });

  test('an environment variable name used as a credential-shaped key value (ATLASSIAN_AUTH_TOKEN) never fails', () => {
    const dir = mkTempDir();
    const filePath = writeFile(dir, 'adapter.yaml', ['adapter: jira', 'auth: ATLASSIAN_AUTH_TOKEN', ''].join('\n'));

    const result = scanCredentials([filePath]);

    expect(result).toEqual({ valid: true, errors: [] });
  });

  test('a toolchain config YAML file is scanned on every line, not only inside fenced code blocks', () => {
    const dir = mkTempDir();
    const filePath = writeFile(dir, 'toolchain.yaml', ['tracker: github', 'bearer: literal-bearer-value', ''].join('\n'));

    const result = scanCredentials([filePath]);

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes(filePath))).toBe(true);
  });
});
