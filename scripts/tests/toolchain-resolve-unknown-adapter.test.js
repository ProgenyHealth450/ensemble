'use strict';
/**
 * Tests for the `UNKNOWN_ADAPTER` resolver guard (TRD-2026-8d825f54 TRD-046):
 * `packages/development/lib/toolchain/resolve-guard.js#assertKnownAdapter`, wired into
 * `toolchain-cli.js`'s `resolve`/`explain` (via `resolveAll`), `run`, `confirm-status` and
 * `confirm-record` handlers, and `preflight.js#runPreflight`'s own non-`work-graph` branch.
 *
 * `assertKnownAdapter` itself is exercised directly (fast, no process spawn, no project
 * fixture needed beyond `ctx.installedRoots`), then the real `toolchain-cli.js#resolve`
 * against a temp project directory's `.ensemble/toolchain.yaml` (the TRD's own literal AC:
 * `{iac: pulumi}` makes `resolve` fail with `UNKNOWN_ADAPTER` naming `iac` and `terraform`,
 * against the REAL, current `packages/infrastructure/skills/adapter-iac-terraform`), then a
 * mutation proof on a `makeMutantToolchainRoot()` copy (TRD-2026-8d825f54 PR 3 review
 * convention, `scripts/tests/fixtures/toolchain/mutant-toolchain-copy.js`): with the guard
 * call deleted from the mutant's own copy of `toolchain-cli.js`, the exact same misconfigured
 * project fixture that fails today wrongly resolves instead.
 *
 * PR 10 fix round, item 2c extends this to a full matrix: ALL 10 restricted categories
 * (worktree, ci-local, review, test-runner, e2e-quality, lint, container-deploy, iac,
 * platform-cloud, package-runner) x EVERY entry point that resolves a category's adapter
 * (`resolve`, `explain`, `run`, `confirm-status`, `confirm-record`, `preflight`), each
 * asserting the exact `UNKNOWN_ADAPTER` message names the category and its real shipped
 * adapter id -- plus a mutation proof deleting the guard call at each of `run`/`confirm-
 * status`/`confirm-record` specifically (`resolveAll`'s own proof already existed below;
 * `preflight`'s own lives in `scripts/tests/toolchain-preflight.test.js` alongside its other
 * `runPreflight` coverage). `work-graph` is deliberately NOT given a mutation proof here: TRD-
 * 046's own Master Task List text excludes it from this guard's scope ("work-graph keeps its
 * fallback"), and `resolve-guard.js`'s own module doc already records why (it resolves through
 * `work-graph-resolve.js#resolveWorkGraphAdapter`, a separate code path that never calls
 * `resolveCategory`/this guard at all) -- there is no guard call at that entry point to delete.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { assertKnownAdapter, shippedAdapterNames } = require('../../packages/development/lib/toolchain/resolve-guard');
const {
  resolve,
  explain,
  run,
  confirmStatus,
  confirmRecord,
  preflight
} = require('../../packages/development/lib/toolchain-cli');
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

/**
 * Replace the `occurrenceIndex`-th (1-based) exact occurrence of `needle` in `filePath` with
 * `replacement` and `require()` the result fresh. Unlike `mutateAndRequire` (which always
 * targets the FIRST occurrence and throws if `needle` is not unique-by-construction for its own
 * callers), this targets one specific occurrence among several byte-identical ones -- `run`,
 * `confirmStatus` and `confirmRecord` in `toolchain-cli.js` each contain the exact same
 * `assertKnownAdapter(category, resolvedCategory, ctx);` line (a deliberate, documented small
 * duplication, see that file's own header), so a plain single-occurrence replace cannot target
 * one function's call site without the other two.
 *
 * @param {string} filePath absolute path to a file inside a `makeMutantToolchainRoot()` copy
 * @param {string} needle exact substring expected to occur at least `occurrenceIndex` times
 * @param {number} occurrenceIndex 1-based index of the occurrence to replace
 * @param {string} replacement
 * @returns {unknown} the required module
 */
function mutateNthOccurrenceAndRequire(filePath, needle, occurrenceIndex, replacement) {
  const original = fs.readFileSync(filePath, 'utf8');
  let searchFrom = 0;
  let foundAt = -1;
  for (let i = 0; i < occurrenceIndex; i++) {
    foundAt = original.indexOf(needle, searchFrom);
    if (foundAt === -1) {
      throw new Error(
        `mutateNthOccurrenceAndRequire: occurrence ${i + 1} of needle not found in ${filePath}: ${JSON.stringify(needle)}`
      );
    }
    searchFrom = foundAt + needle.length;
  }
  const mutated = original.slice(0, foundAt) + replacement + original.slice(foundAt + needle.length);
  if (mutated === original) {
    throw new Error(`mutateNthOccurrenceAndRequire: replacement produced no change in ${filePath}`);
  }
  fs.writeFileSync(filePath, mutated);
  // eslint-disable-next-line global-require, import/no-dynamic-require
  return require(filePath);
}

/** One fixture per restricted category (TRD-046): its real shipped adapter id (`toolchain.
 * default.yaml`) and a representative, non-side-effecting capability id to resolve through
 * `run`/`confirm-status`/`confirm-record`/`preflight` (the guard throws before any argv is
 * built or any capability is looked up on the adapter, so the capability's own args/sideEffect
 * status never matters to these assertions -- any real id for the category suffices). */
const RESTRICTED_CATEGORY_FIXTURES = [
  { category: 'worktree', shippedAdapter: 'plain-git', capability: 'worktree.list' },
  { category: 'ci-local', shippedAdapter: 'act', capability: 'ci-local.list-jobs' },
  { category: 'review', shippedAdapter: 'coderabbit', capability: 'review.get-review-state' },
  { category: 'test-runner', shippedAdapter: 'default', capability: 'test-runner.run' },
  { category: 'e2e-quality', shippedAdapter: 'playwright', capability: 'e2e-quality.run-e2e' },
  { category: 'lint', shippedAdapter: 'reviewdog', capability: 'lint.report-findings' },
  { category: 'container-deploy', shippedAdapter: 'docker-kubectl', capability: 'container-deploy.build-image' },
  { category: 'iac', shippedAdapter: 'terraform', capability: 'iac.plan' },
  { category: 'platform-cloud', shippedAdapter: 'aws', capability: 'platform-cloud.get-resource' },
  { category: 'package-runner', shippedAdapter: 'npm', capability: 'package-runner.run-script' }
];


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

describe('toolchain-cli: UNKNOWN_ADAPTER across every restricted category and every resolving entry point (PR 10 fix round, item 2c)', () => {
  test.each(RESTRICTED_CATEGORY_FIXTURES)(
    'resolve: $category selecting an unshipped adapter fails UNKNOWN_ADAPTER naming $category and $shippedAdapter',
    ({ category, shippedAdapter }) => {
      const { root, cleanup } = makeProjectRoot({ [category]: 'not-a-shipped-adapter' });
      try {
        const result = resolve({ projectRoot: root, env: {} });
        expect(result.ok).toBe(false);
        expect(result.error.code).toBe('UNKNOWN_ADAPTER');
        expect(result.error.message).toContain(category);
        expect(result.error.message).toContain(shippedAdapter);
      } finally {
        cleanup();
      }
    }
  );

  test.each(RESTRICTED_CATEGORY_FIXTURES)(
    'explain: $category selecting an unshipped adapter fails UNKNOWN_ADAPTER naming $category and $shippedAdapter',
    ({ category, shippedAdapter }) => {
      const { root, cleanup } = makeProjectRoot({ [category]: 'not-a-shipped-adapter' });
      try {
        const result = explain({ projectRoot: root, env: {} });
        expect(result.ok).toBe(false);
        expect(result.error.code).toBe('UNKNOWN_ADAPTER');
        expect(result.error.message).toContain(category);
        expect(result.error.message).toContain(shippedAdapter);
      } finally {
        cleanup();
      }
    }
  );

  test.each(RESTRICTED_CATEGORY_FIXTURES)(
    'run $capability: $category selecting an unshipped adapter fails UNKNOWN_ADAPTER naming $category and $shippedAdapter, with no process ever resolved to spawn',
    async ({ category, shippedAdapter, capability }) => {
      const { root, cleanup } = makeProjectRoot({ [category]: 'not-a-shipped-adapter' });
      try {
        const result = await run({ projectRoot: root, env: {} }, [capability], {});
        expect(result.ok).toBe(false);
        expect(result.error.code).toBe('UNKNOWN_ADAPTER');
        expect(result.error.message).toContain(category);
        expect(result.error.message).toContain(shippedAdapter);
      } finally {
        cleanup();
      }
    }
  );

  test.each(RESTRICTED_CATEGORY_FIXTURES)(
    'confirm-status $capability: $category selecting an unshipped adapter fails UNKNOWN_ADAPTER naming $category and $shippedAdapter',
    ({ category, shippedAdapter, capability }) => {
      const { root, cleanup } = makeProjectRoot({ [category]: 'not-a-shipped-adapter' });
      try {
        const result = confirmStatus({ projectRoot: root, env: {} }, [capability], {});
        expect(result.ok).toBe(false);
        expect(result.error.code).toBe('UNKNOWN_ADAPTER');
        expect(result.error.message).toContain(category);
        expect(result.error.message).toContain(shippedAdapter);
      } finally {
        cleanup();
      }
    }
  );

  test.each(RESTRICTED_CATEGORY_FIXTURES)(
    'confirm-record $capability: $category selecting an unshipped adapter fails UNKNOWN_ADAPTER naming $category and $shippedAdapter',
    ({ category, shippedAdapter, capability }) => {
      const { root, cleanup } = makeProjectRoot({ [category]: 'not-a-shipped-adapter' });
      try {
        const result = confirmRecord({ projectRoot: root, env: {} }, [capability], {});
        expect(result.ok).toBe(false);
        expect(result.error.code).toBe('UNKNOWN_ADAPTER');
        expect(result.error.message).toContain(category);
        expect(result.error.message).toContain(shippedAdapter);
      } finally {
        cleanup();
      }
    }
  );

  test.each(RESTRICTED_CATEGORY_FIXTURES)(
    'preflight --require $capability: $category selecting an unshipped adapter fails UNKNOWN_ADAPTER naming $category and $shippedAdapter',
    async ({ category, shippedAdapter, capability }) => {
      const { root, cleanup } = makeProjectRoot({ [category]: 'not-a-shipped-adapter' });
      try {
        const result = await preflight({ projectRoot: root, env: {} }, [], { requires: [capability] });
        expect(result.ok).toBe(false);
        expect(result.error.code).toBe('UNKNOWN_ADAPTER');
        expect(result.error.message).toContain(category);
        expect(result.error.message).toContain(shippedAdapter);
      } finally {
        cleanup();
      }
    }
  );
});

describe('toolchain-cli: mutation proofs deleting the guard call at run/confirm-status/confirm-record specifically (PR 10 fix round, item 2c)', () => {
  // `includeAdapterSkills: true`: `work-graph`'s own `auto` resolution (resolved ahead of `iac`
  // by none of these three entry points, which each resolve only the ONE capability's own
  // category -- unlike `resolveAll`, there is no coupling to fix here) is not exercised by
  // `run`/`confirm-status`/`confirm-record` at all, so this option is unnecessary for these
  // three proofs; omitted (default `false`) for a smaller/faster mutant copy.
  const NEEDLE = 'assertKnownAdapter(category, resolvedCategory, ctx);';

  test('deleting run()\'s own assertKnownAdapter call (1st occurrence) makes a misconfigured iac.plan wrongly resolve instead of failing UNKNOWN_ADAPTER', async () => {
    const mutantRoot = makeMutantToolchainRoot();
    const { root: projectRoot, cleanup: cleanupProject } = makeProjectRoot({ iac: 'pulumi' });
    try {
      const mutantCli = mutateNthOccurrenceAndRequire(mutantRoot.cliPath, NEEDLE, 1, '');
      const result = await mutantCli.run({ projectRoot, env: {} }, ['iac.plan'], {});
      // The guard call was deleted from run() specifically: resolution now falls through past
      // it straight to loadAdapter, which throws NOT_INSTALLED (the pre-TRD-046 behavior) for
      // the same bogus id that fails UNKNOWN_ADAPTER in the real, unmutated module above --
      // never `ok:true` (unlike resolveAll's own mutation proof) because `loadAdapter` itself
      // still runs right after and still cannot find an adapter literally named `pulumi`.
      expect(result.ok).toBe(false);
      expect(result.error.code).not.toBe('UNKNOWN_ADAPTER');
    } finally {
      cleanupProject();
      mutantRoot.cleanup();
    }
  });

  test('deleting confirmStatus()\'s own assertKnownAdapter call (2nd occurrence) makes a misconfigured iac.plan wrongly resolve instead of failing UNKNOWN_ADAPTER', () => {
    const mutantRoot = makeMutantToolchainRoot();
    const { root: projectRoot, cleanup: cleanupProject } = makeProjectRoot({ iac: 'pulumi' });
    try {
      const mutantCli = mutateNthOccurrenceAndRequire(mutantRoot.cliPath, NEEDLE, 2, '');
      const result = mutantCli.confirmStatus({ projectRoot, env: {} }, ['iac.plan'], {});
      expect(result.ok).toBe(false);
      expect(result.error.code).not.toBe('UNKNOWN_ADAPTER');
    } finally {
      cleanupProject();
      mutantRoot.cleanup();
    }
  });

  test('deleting confirmRecord()\'s own assertKnownAdapter call (3rd occurrence) makes a misconfigured iac.plan wrongly resolve instead of failing UNKNOWN_ADAPTER', () => {
    const mutantRoot = makeMutantToolchainRoot();
    const { root: projectRoot, cleanup: cleanupProject } = makeProjectRoot({ iac: 'pulumi' });
    try {
      const mutantCli = mutateNthOccurrenceAndRequire(mutantRoot.cliPath, NEEDLE, 3, '');
      const result = mutantCli.confirmRecord({ projectRoot, env: {} }, ['iac.plan'], {});
      expect(result.ok).toBe(false);
      expect(result.error.code).not.toBe('UNKNOWN_ADAPTER');
    } finally {
      cleanupProject();
      mutantRoot.cleanup();
    }
  });
});
