'use strict';
/**
 * Tests for the `UNKNOWN_ADAPTER` resolver guard (TRD-2026-8d825f54 TRD-046):
 * `packages/development/lib/toolchain/resolve-guard.js#assertKnownAdapter`, wired into
 * `toolchain-cli.js`'s `resolve`/`explain` (via `resolveAll`), `run`, `confirm-status` and
 * `confirm-record` handlers.
 *
 * `assertKnownAdapter` itself is exercised directly (fast, no process spawn, no project
 * fixture needed beyond `ctx.installedRoots`), then the real `toolchain-cli.js#resolve`
 * against a temp project directory's `.ensemble/toolchain.yaml` (the TRD's own literal AC:
 * `{iac: pulumi}` makes `resolve` fail with `UNKNOWN_ADAPTER` naming `iac` and `terraform`,
 * against the REAL, current `packages/infrastructure/skills/adapter-iac-terraform`), and
 * finally a mutation proof on a `makeMutantToolchainRoot()` copy (TRD-2026-8d825f54 PR 3
 * review convention, `scripts/tests/fixtures/toolchain/mutant-toolchain-copy.js`): with the
 * guard call deleted from the mutant's own copy of `toolchain-cli.js`, the exact same
 * misconfigured project fixture that fails today wrongly resolves instead.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { assertKnownAdapter, shippedAdapterNames } = require('../../packages/development/lib/toolchain/resolve-guard');
const { resolve } = require('../../packages/development/lib/toolchain-cli');
const { makeMutantToolchainRoot, mutateAndRequire } = require('./fixtures/toolchain/mutant-toolchain-copy');

/**
 * A fresh temp project root with `.ensemble/toolchain.yaml` holding `content` (an object,
 * YAML-stringified as `key: value` pairs -- every value here is a plain string, so a hand-
 * written template is simpler than pulling in js-yaml for this one call site).
 */
function makeProjectRoot(config) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'toolchain-unknown-adapter-project-'));
  fs.mkdirSync(path.join(root, '.ensemble'), { recursive: true });
  const yamlText = Object.entries(config)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n');
  fs.writeFileSync(path.join(root, '.ensemble', 'toolchain.yaml'), `${yamlText}\n`);
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

describe('shippedAdapterNames', () => {
  test('finds the real, shipped iac adapter against the live repo tree', () => {
    expect(shippedAdapterNames('iac', {})).toEqual(['terraform']);
  });

  test('an unshipped category reports no names (never throws)', () => {
    expect(shippedAdapterNames('this-category-does-not-exist', {})).toEqual([]);
  });
});

describe('assertKnownAdapter', () => {
  test('never throws for source "default"/"detection"/"env-compat", even naming a bogus id', () => {
    for (const source of ['default', 'detection', 'env-compat']) {
      expect(() => assertKnownAdapter('iac', { value: 'nonexistent-tool', source }, {})).not.toThrow();
    }
  });

  test('never throws for the excluded categories tracker/host, even with an explicit project source', () => {
    expect(() =>
      assertKnownAdapter('tracker', { value: 'nonexistent-tracker', source: 'project' }, {})
    ).not.toThrow();
    expect(() =>
      assertKnownAdapter('host', { value: 'nonexistent-host', source: 'user' }, {})
    ).not.toThrow();
  });

  test('never throws when the explicitly selected value IS actually shipped', () => {
    expect(() => assertKnownAdapter('iac', { value: 'terraform', source: 'project' }, {})).not.toThrow();
  });

  test('throws UNKNOWN_ADAPTER for an explicit project selection naming an unshipped adapter', () => {
    try {
      assertKnownAdapter('iac', { value: 'pulumi', source: 'project' }, {});
      throw new Error('expected assertKnownAdapter to throw');
    } catch (error) {
      expect(error.code).toBe('UNKNOWN_ADAPTER');
      expect(error.message).toBe("iac: 'pulumi' is not a shipped adapter. Available: terraform");
    }
  });

  test('throws UNKNOWN_ADAPTER for an explicit USER selection too, not just project', () => {
    expect(() => assertKnownAdapter('iac', { value: 'pulumi', source: 'user' }, {})).toThrow(
      expect.objectContaining({ code: 'UNKNOWN_ADAPTER' })
    );
  });
});

describe('toolchain-cli resolve: TRD-046 literal AC', () => {
  test('{iac: pulumi} in a project .ensemble/toolchain.yaml makes resolve fail with UNKNOWN_ADAPTER naming iac and terraform', () => {
    const { root, cleanup } = makeProjectRoot({ iac: 'pulumi' });
    try {
      const result = resolve({ projectRoot: root, env: {} });
      expect(result.ok).toBe(false);
      expect(result.error.code).toBe('UNKNOWN_ADAPTER');
      expect(result.error.message).toContain('iac');
      expect(result.error.message).toContain('terraform');
    } finally {
      cleanup();
    }
  });

  test('regression: no config override at all still resolves iac to its real shipped default, unaffected', () => {
    const { root, cleanup } = makeProjectRoot({});
    try {
      fs.rmSync(path.join(root, '.ensemble'), { recursive: true, force: true });
      const result = resolve({ projectRoot: root, env: {} });
      expect(result.ok).toBe(true);
      expect(result.data.iac).toEqual({ adapter: 'terraform', source: 'default' });
    } finally {
      cleanup();
    }
  });

  test('regression: an explicit project selection naming the real shipped adapter still resolves fine', () => {
    const { root, cleanup } = makeProjectRoot({ iac: 'terraform' });
    try {
      const result = resolve({ projectRoot: root, env: {} });
      expect(result.ok).toBe(true);
      expect(result.data.iac).toEqual({ adapter: 'terraform', source: 'project' });
    } finally {
      cleanup();
    }
  });

  test('regression: tracker/host stay excluded end-to-end -- an unshipped explicit host id resolves without error', () => {
    // `tracker` itself is not used for this end-to-end check: `work-graph`'s own `auto`
    // resolution (TRD-027/I7) loads the CURRENTLY RESOLVED tracker adapter to probe its
    // capabilities, so pointing `tracker` at a never-shipped id fails resolution at that
    // unrelated, pre-existing step (a real `NOT_INSTALLED`, not this guard) before `resolve`
    // ever reaches this test's actual subject. `host` has no such coupling, so it isolates the
    // exclusion this test means to prove -- the direct `assertKnownAdapter` unit test above
    // already proves the same exclusion for `tracker` itself without that confound.
    const { root, cleanup } = makeProjectRoot({ host: 'nonexistent-host' });
    try {
      const result = resolve({ projectRoot: root, env: {} });
      expect(result.ok).toBe(true);
      expect(result.data.host).toEqual({ adapter: 'nonexistent-host', source: 'project' });
    } finally {
      cleanup();
    }
  });
});

describe('toolchain-cli resolve: mutation proof (makeMutantToolchainRoot, never the real repo source)', () => {
  test('removing the assertKnownAdapter call from a mutant copy of resolveAll makes the same misconfigured fixture wrongly resolve', () => {
    // `includeAdapterSkills: true` ships the real `beads` adapter into the mutant copy:
    // without it, `work-graph`'s own `auto` resolution (which precedes `iac` in `CATEGORIES`)
    // fails to load the shipped tracker default first, aborting `resolveAll` before it ever
    // reaches `iac` -- an unrelated, pre-existing coupling this test must route around to
    // isolate the one behavior it actually proves.
    const mutantRoot = makeMutantToolchainRoot({ includeAdapterSkills: true });
    const { root: projectRoot, cleanup: cleanupProject } = makeProjectRoot({ iac: 'pulumi' });
    try {
      const mutantCli = mutateAndRequire(
        mutantRoot.cliPath,
        '      assertKnownAdapter(category, { value, source }, ctx);\n',
        ''
      );
      const mutatedResult = mutantCli.resolve({ projectRoot, env: {} });
      // The guard call was deleted: the exact same misconfigured project that fails in the
      // real (unmutated) module above now wrongly "resolves" to the bogus id.
      expect(mutatedResult.ok).toBe(true);
      expect(mutatedResult.data.iac).toEqual({ adapter: 'pulumi', source: 'project' });
    } finally {
      cleanupProject();
      mutantRoot.cleanup();
    }
  });
});
