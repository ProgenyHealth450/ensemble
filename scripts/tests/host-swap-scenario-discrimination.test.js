'use strict';

/**
 * Discrimination proofs for `host-swap-scenario.test.js` (TRD-2026-8d825f54 TRD-041-TEST, bead
 * br-802j, PRD AC-017-1/2/3). TRD-041's own `host-swap-scenario.test.js` (12/12 passing, already
 * committed and closed) already functionally covers this bead's three Test AC scenarios:
 *
 *   - Scenario "Change-request scenario without default host tool" -> its "AC1/AC2" describe
 *     block (push/create/view/merge all exit 0 through the stub `az`, no `gh` on `PATH`).
 *   - Scenario "Alternative vocabulary in output" -> its own Implementation AC2 vocabulary-scan
 *     test (Azure terms present, GitHub-only terms absent in the combined real output).
 *   - Scenario "Host and tracker both Azure DevOps" -> its "AC3" describe block (`host:
 *     azure-devops` + `tracker: azure-boards` resolved from config alone, `host.change-
 *     request-link-work-item` reaches `az repos pr work-item add`).
 *
 * Re-run for this bead: `npx jest scripts/tests/host-swap-scenario.test.js --verbose` -> 12/12
 * passing (pasted in this bead's own report). This file therefore does NOT duplicate any of
 * that file's 12 existing tests; it adds NEW discrimination proof that those assertions are not
 * vacuously true regardless of manifest/disk content, using 2 of the assignment's 3 offered
 * techniques:
 *
 *   1. (covers Scenario 1) Mutation-copy `adapter-host-azure-devops`'s `adapter.yaml` into a
 *      `/tmp` scratch copy, strip "repos pr update" from its `az` allowlist entry, and re-run
 *      the scenario's own `host.change-request-merge` step (via `runCapability`, the exact
 *      production entry point `toolchain-cli.js run` itself calls) against the MUTATED manifest
 *      instead of the real one: it now fails `NOT_ALLOWED` and never even spawns the stub `az`
 *      -- proving the real scenario's "merge exits 0" assertion is actually sensitive to the
 *      adapter being correctly configured, not an assertion that would pass against any
 *      manifest content whatsoever. A "control" test first proves the SAME call against the
 *      real, unmutated manifest succeeds (so the mutated test's failure is attributable to the
 *      one allowlist edit, not an unrelated setup mistake), and a third test proves the static
 *      counterpart (`validateAllowlist`) independently rejects the same mutated manifest.
 *
 *   2. (covers Scenario 3) For the config-only `host.change-request-link-work-item` scenario
 *      (AC3), snapshot every file under both
 *      `packages/infrastructure/skills/adapter-host-azure-devops/` and
 *      `packages/infrastructure/skills/adapter-tracker-azure-boards/` (size + mtime) before and
 *      after running the real, full config-only scenario inside this test, and assert zero
 *      files changed -- proving "config only, no source file changes needed" is an actually
 *      exercised property of the real run, not merely an assertion made in prose. A second test
 *      proves the snapshot comparison itself is capable of catching a real change (exercised
 *      only against a throwaway `/tmp` copy of the adapter directory, never the live source
 *      tree), so the "unchanged" result above is not a vacuously-always-equal comparison.
 *
 * Technique 2 (vocabulary-swap sensitivity) from the assignment is intentionally not
 * duplicated here: it would require fabricating GitHub-flavored stub output for an adapter that
 * never produces it, which is exactly the kind of invented-behavior risk TRD-041's own header
 * disclosed-ambiguity note already steered away from. Techniques 1 and 3 above both exercise
 * REAL manifest content (either the shipped file or a disk-written mutation of it) through REAL
 * production code paths (`runCapability`, `validateAllowlist`, a real file-tree snapshot),
 * matching this bead's "real paths, mutation-proven, never narrative claims" standing bar.
 *
 * Reuses `scripts/tests/fixtures/toolchain/adapter-host-azure-devops-stub.js` (already
 * committed, TRD-041) rather than writing a new stub. Never mutates the live source tree: every
 * mutated manifest is written to a `/tmp` scratch copy (`mkMutableAdapterCopy`, same pattern
 * `toolchain-adapter-host-github-manifest.test.js` already uses), and the snapshot-sensitivity
 * proof mutates only a throwaway `/tmp` copy of the adapter directory, never
 * `packages/infrastructure/skills/adapter-host-azure-devops/` itself.
 *
 * Independent review is deferred to the PR 9 gate (STRATEGY=flexible, no reviewer agent runs on
 * this bead).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const yaml = require('js-yaml');

const { validateAllowlist } = require('../../packages/development/lib/toolchain/validate');
const { runCapability } = require('../../packages/development/lib/toolchain/runner');

const { installHostAzureDevOpsStub } = require('./fixtures/toolchain/adapter-host-azure-devops-stub');

jest.setTimeout(30000);

const REPO_ROOT = path.join(__dirname, '..', '..');
const TOOLCHAIN_CLI = path.join(REPO_ROOT, 'packages', 'development', 'lib', 'toolchain-cli.js');
const HOST_ADAPTER_DIR = path.join(REPO_ROOT, 'packages', 'infrastructure', 'skills', 'adapter-host-azure-devops');
const TRACKER_ADAPTER_DIR = path.join(REPO_ROOT, 'packages', 'infrastructure', 'skills', 'adapter-tracker-azure-boards');

// ---------------------------------------------------------------------------
// Shared tmp-dir bookkeeping (same convention toolchain-adapter-host-github-manifest.test.js
// already uses) -- every tmp dir this file creates is tracked here and removed in `afterEach`,
// so no test ever needs its own ad hoc cleanup.
// ---------------------------------------------------------------------------

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

/** Copy the real `adapter-host-azure-devops` directory (adapter.yaml + SKILL.md only) into a
 * fresh `/tmp` dir so a test can mutate the copy safely -- NEVER the live source file. Same
 * pattern as `toolchain-adapter-host-github-manifest.test.js#mkMutableAdapterCopy`. */
function mkMutableAdapterCopy() {
  const dir = mkTempDir('adapter-host-azure-devops-mut-');
  fs.copyFileSync(path.join(HOST_ADAPTER_DIR, 'adapter.yaml'), path.join(dir, 'adapter.yaml'));
  fs.copyFileSync(path.join(HOST_ADAPTER_DIR, 'SKILL.md'), path.join(dir, 'SKILL.md'));
  return dir;
}

function loadManifestFrom(dir) {
  return yaml.load(fs.readFileSync(path.join(dir, 'adapter.yaml'), 'utf8'));
}

function writeManifestTo(dir, manifest) {
  fs.writeFileSync(path.join(dir, 'adapter.yaml'), yaml.dump(manifest));
}

function readCallsLog(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** Same `node`-only-dir trick `host-swap-scenario.test.js`'s own header documents: the stub
 * `az`'s `#!/usr/bin/env node` shebang needs `node` resolvable via `PATH`, but
 * `path.dirname(process.execPath)` also holds a real `gh`/`az`-adjacent toolchain on this
 * machine that must never leak into either technique's `PATH`. */
const NODE_ONLY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'host-swap-discrim-node-only-'));
fs.symlinkSync(process.execPath, path.join(NODE_ONLY_DIR, 'node'));

function buildPath(binDir) {
  return [binDir, NODE_ONLY_DIR, '/usr/bin', '/bin'].join(path.delimiter);
}

function runNode(cliPath, args, cwd, env) {
  const r = spawnSync(process.execPath, [cliPath, ...args], { cwd, env, encoding: 'utf8' });
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    // some assertions below only need status/stdout/stderr
  }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

function writeToolchainConfig(dir, lines) {
  fs.mkdirSync(path.join(dir, '.ensemble'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.ensemble', 'toolchain.yaml'), lines.join('\n') + '\n');
}

// ---------------------------------------------------------------------------
// 1. Discrimination for AC1/AC2's "merge exits 0" assertion: an allowlist mutation flips it to
//    NOT_ALLOWED, proving sensitivity to real manifest content.
// ---------------------------------------------------------------------------

describe('Discrimination 1 (Scenario "Change-request scenario without default host tool"): host.change-request-merge is sensitive to the az allowlist, not vacuously 0', () => {
  test('control: against the REAL, unmutated adapter.yaml (loaded from a /tmp scratch copy, never the live source file), host.change-request-merge succeeds via the stub az', async () => {
    const adapterCopyDir = mkMutableAdapterCopy();
    const manifest = loadManifestFrom(adapterCopyDir);

    const binDir = mkTempDir('discrim-merge-control-bin-');
    installHostAzureDevOpsStub(binDir, { prId: '501' });

    const result = await runCapability(manifest, 'host.change-request-merge', { id: '501' }, {
      parentEnv: { ...process.env, PATH: buildPath(binDir) },
      timeoutMs: 5000
    });

    expect(result.ok).toBe(true);
    expect(result.adapter).toBe('azure-devops');
    expect(result.data.id).toBe('501');
    expect(result.data.state).toBe('closed'); // statusMap: completed -> closed

    const calls = readCallsLog(path.join(binDir, 'calls-az.log'));
    expect(calls.some((argv) => argv.join(' ').startsWith('repos pr update'))).toBe(true);
  });

  test('mutated: with "repos pr update" stripped from the az allowlist in a /tmp scratch copy, the SAME call now fails NOT_ALLOWED and never spawns az at all', async () => {
    const adapterCopyDir = mkMutableAdapterCopy();
    const manifest = loadManifestFrom(adapterCopyDir);
    const azEntry = manifest.allowlist.find((e) => e.bin === 'az');
    azEntry.sub = azEntry.sub.filter((s) => s !== 'repos pr update');
    writeManifestTo(adapterCopyDir, manifest);
    // Re-read from disk rather than reusing the in-memory object just mutated, so the manifest
    // `runCapability` actually receives genuinely came from the mutated YAML file on disk.
    const mutatedManifest = loadManifestFrom(adapterCopyDir);
    expect(mutatedManifest.allowlist.find((e) => e.bin === 'az').sub).not.toContain('repos pr update');

    const binDir = mkTempDir('discrim-merge-mutated-bin-');
    installHostAzureDevOpsStub(binDir, { prId: '501' });

    const result = await runCapability(mutatedManifest, 'host.change-request-merge', { id: '501' }, {
      parentEnv: { ...process.env, PATH: buildPath(binDir) },
      timeoutMs: 5000
    });

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('NOT_ALLOWED');
    expect(result.error.message).toMatch(/not permitted by the allowlist/);

    // Proves the denial happens BEFORE any process is spawned: the stub az never even creates
    // its own calls log file (same proof style host-swap-scenario.test.js's sibling file,
    // toolchain-adapter-host-github-manifest.test.js, uses for its own "never spawning gh" claim).
    expect(fs.existsSync(path.join(binDir, 'calls-az.log'))).toBe(false);
  });

  test('the static counterpart (validateAllowlist) also rejects the same stripped-allowlist manifest, naming host.change-request-merge', () => {
    const adapterCopyDir = mkMutableAdapterCopy();
    const manifest = loadManifestFrom(adapterCopyDir);
    const azEntry = manifest.allowlist.find((e) => e.bin === 'az');
    azEntry.sub = azEntry.sub.filter((s) => s !== 'repos pr update');
    writeManifestTo(adapterCopyDir, manifest);
    const mutatedManifest = loadManifestFrom(adapterCopyDir);

    const result = validateAllowlist(mutatedManifest);
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.includes("capability 'host.change-request-merge'") && e.includes('not in the allowlist'))
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Discrimination for AC3's "config only, no source file changes" claim: a real before/after
//    file-tree snapshot of both adapter directories proves zero files changed on disk, and a
//    second test proves that snapshot comparison is actually capable of catching a change.
// ---------------------------------------------------------------------------

/** `{relativePath -> "size:mtimeMs"}` for every regular file under `dir`, recursively. */
function snapshotDir(dir) {
  const snapshot = new Map();
  for (const rel of fs.readdirSync(dir, { recursive: true })) {
    const abs = path.join(dir, rel);
    const stat = fs.statSync(abs);
    if (stat.isFile()) {
      snapshot.set(rel, `${stat.size}:${stat.mtimeMs}`);
    }
  }
  return snapshot;
}

describe('Discrimination 2 (Scenario "Host and tracker both Azure DevOps"): "config only" is an exercised property, not just prose', () => {
  test('running the real config-only host+tracker link-work-item scenario leaves both adapter skill directories byte-for-byte, mtime-for-mtime unchanged on disk', () => {
    const before = { host: snapshotDir(HOST_ADAPTER_DIR), tracker: snapshotDir(TRACKER_ADAPTER_DIR) };

    // Reproduces host-swap-scenario.test.js's own "AC3" describe block end to end (the full
    // resolve -> preflight -> run chain, real toolchain-cli.js subprocess, stub az, no gh on
    // PATH) purely so it can be bracketed by the before/after snapshot above -- not a
    // duplicate of that file's own already-passing assertions on the link call's own result,
    // which this test re-checks only incidentally as a side effect of actually running the
    // real scenario.
    const project = mkTempDir('discrim-ac3-project-');
    const binDir = path.join(project, 'bin');
    writeToolchainConfig(project, ['host: azure-devops', 'tracker: azure-boards']);
    installHostAzureDevOpsStub(binDir, { prId: '501' });
    const PATH = buildPath(binDir);

    const resolve = runNode(TOOLCHAIN_CLI, ['resolve', '--json'], project, { PATH });
    expect(resolve.json && resolve.json.ok).toBe(true);
    expect(resolve.json.data.host).toEqual({ adapter: 'azure-devops', source: 'project' });
    expect(resolve.json.data.tracker).toEqual({ adapter: 'azure-boards', source: 'project' });

    const preflight = runNode(TOOLCHAIN_CLI, ['preflight', '--require', 'host.change-request-link-work-item', '--json'], project, { PATH });
    expect(preflight.json && preflight.json.ok).toBe(true);
    const runId = preflight.json.runId;

    const link = runNode(
      TOOLCHAIN_CLI,
      ['run', 'host.change-request-link-work-item', '--run-id', runId, '--arg', 'id=501', '--arg', 'workItemId=4321', '--json', '--non-interactive'],
      project,
      { PATH }
    );
    expect(link.status).toBe(0);
    expect(link.json && link.json.ok).toBe(true);
    expect(link.json.data).toContain('Linked pull request 501 to work item(s): 4321');

    const after = { host: snapshotDir(HOST_ADAPTER_DIR), tracker: snapshotDir(TRACKER_ADAPTER_DIR) };

    expect(after.host).toEqual(before.host);
    expect(after.tracker).toEqual(before.tracker);
  });

  test('discrimination check: snapshotDir() is actually capable of detecting a changed file (proven only against a throwaway /tmp copy, never the live source tree)', () => {
    const scratch = mkTempDir('discrim-snapshot-sensitivity-');
    fs.cpSync(HOST_ADAPTER_DIR, scratch, { recursive: true });

    const before = snapshotDir(scratch);
    fs.writeFileSync(path.join(scratch, 'adapter.yaml'), fs.readFileSync(path.join(scratch, 'adapter.yaml'), 'utf8') + '\n# mutated\n');
    const after = snapshotDir(scratch);

    expect(after).not.toEqual(before);
    expect(after.get('adapter.yaml')).not.toBe(before.get('adapter.yaml'));
  });
});
