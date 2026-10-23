'use strict';

/**
 * Real-process coverage for `beads-label.js#ensureLabel`'s DEFAULT `runBr` route (TRD-2026-
 * 8d825f54 TRD-025 follow-up, independent review of PR 6: "Add coverage for the real runBr
 * routing path in beads-label"). Every existing `beads-label.test.js`/`beads-match-boundary.
 * test.js` test injects a custom `run` stand-in as `ensureLabel`'s second argument, so the
 * real `runBr -> resolveTrackerAdapter -> runCapabilitySync -> execFileSync('br', ...)` path
 * -- the one production code actually takes when no custom `run` is passed -- is never
 * exercised by any test; the reviewer proved a mutant corrupting `runBr`'s list-branch return
 * slips past the whole suite undetected.
 *
 * This file calls `ensureLabel({label, match})` with NO custom `run`, through a real
 * `tracker` adapter resolved from an installed-package `adapter.yaml` (bypassing the
 * repo-local trust gate, same convention `scripts/tests/toolchain-cli-security-fixes-real.
 * test.js#mkInstalledAdapter` uses for its own installed-origin fixtures) whose `run[]`
 * template invokes a real, executable stub `br` placed on `PATH` -- never a mocked
 * `child_process` -- recording every argv it actually receives so the assertions below prove
 * the stub was reached through `runBr`/`runCapabilitySync`, not short-circuited.
 *
 * `resolveTrackerAdapter` (beads-label.js) hardcodes `process.cwd()`/`process.env`, not an
 * injectable ctx, so this suite drives it the only way it CAN be driven end to end: chdir into
 * a throwaway project root and prepend a throwaway bin directory to the real `PATH`, both
 * restored in `finally`, mirroring the existing `process.chdir` convention this package's own
 * `beads-stage.test.js`/`trd-graph.test.js` already use.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');

const { ensureLabel } = require('../lib/beads-label');

const LABEL = 'demo-label';
const MATCH = '[trd:demo';
const ADAPTER_ID = 'beads-label-stub-tracker';

const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const REPO_DEV_PKG = path.join(REPO_ROOT, 'packages', 'development');

/**
 * Minimal stand-in for real `br`: answers `list --all --limit 0 --json` with a small, wrapped
 * fixture issue set (two in `MATCH`'s scope -- one already labeled, one not -- and one
 * foreign, matching the shape `beads-label.test.js`'s own in-process `fakeBr` fixture uses)
 * and `label add <id> -l <label> --json` with a success envelope, mirroring the real shapes
 * `scripts/tests/fixtures/toolchain/adapter-tracker-beads-stub.js`'s shared `br` stub answers.
 * Appends every argv it receives (one JSON line each) to `calls.log` alongside itself, so a
 * caller can prove exactly what reached the real child process.
 */
const BR_STUB_SOURCE = `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const argv = process.argv.slice(2);
fs.appendFileSync(path.join(__dirname, 'calls.log'), JSON.stringify(argv) + '\\n');
function out(value) {
  process.stdout.write(JSON.stringify(value));
}
if (argv[0] === 'list') {
  out({
    issues: [
      { id: 'b-1', title: '[trd:demo] Implement TRD: Demo', status: 'open', labels: [] },
      { id: 'b-2', title: '[trd:demo:task:T-1] second', status: 'open', labels: ['demo-label'] },
      { id: 'b-3', title: '[trd:other] foreign', status: 'open', labels: [] }
    ],
    total: 3,
    limit: 0,
    offset: 0,
    has_more: false
  });
} else if (argv[0] === 'label' && argv[1] === 'add') {
  out({ ids: [argv[2]], labels: [argv[4]] });
} else {
  process.stderr.write('stub br: unrecognized argv ' + JSON.stringify(argv) + '\\n');
  process.exit(1);
}
`;

function writeBrStub(binDir) {
  fs.mkdirSync(binDir, { recursive: true });
  const brPath = path.join(binDir, 'br');
  fs.writeFileSync(brPath, BR_STUB_SOURCE, { mode: 0o755 });
  fs.chmodSync(brPath, 0o755);
  return binDir;
}

/** Installed-origin adapter (never subject to the repo-local trust gate), `tracker.list`/
 * `tracker.label` routed through the real `br` on `PATH`. */
function writeAdapter(projectRoot, adapterId) {
  const skillDir = path.join(projectRoot, 'packages', 'fixture-pkg', 'skills', adapterId);
  fs.mkdirSync(skillDir, { recursive: true });
  const manifest = {
    adapter: adapterId,
    version: '1.0.0',
    categories: ['tracker'],
    contract: { tracker: '1.0' },
    binaries: ['br'],
    allowlist: [{ bin: 'br', sub: ['list', 'label'] }],
    env: [],
    health: [],
    detect: [],
    capabilities: {
      'tracker.list': { run: ['br', 'list', '--all', '--limit', '0', '--json'] },
      'tracker.label': { run: ['br', 'label', 'add', '${ids}', '-l', '${labels}', '--json'] }
    }
  };
  fs.writeFileSync(path.join(skillDir, 'adapter.yaml'), yaml.dump(manifest));
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `# ${adapterId}\n`);
}

function mkProjectRoot(adapterId) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'beads-label-default-run-')));
  fs.mkdirSync(path.join(dir, '.ensemble'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.ensemble', 'toolchain.yaml'), `tracker: ${adapterId}\n`);
  writeAdapter(dir, adapterId);
  const binDir = writeBrStub(path.join(dir, 'bin'));
  return { dir, binDir };
}

function readCalls(binDir) {
  const logPath = path.join(binDir, 'calls.log');
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe('ensureLabel default runBr route (real process, no custom run)', () => {
  test('labels the real way: through runBr -> resolveTrackerAdapter -> runCapabilitySync -> a real br child process', () => {
    const { dir: projectRoot, binDir } = mkProjectRoot(ADAPTER_ID);
    const cwd = process.cwd();
    const originalPath = process.env.PATH;
    try {
      process.env.PATH = `${binDir}${path.delimiter}${originalPath}`;
      process.chdir(projectRoot);

      const result = ensureLabel({ label: LABEL, match: MATCH });

      expect(result).toEqual({ label: LABEL, matched: 2, labeled: 1, already: 1 });

      // Proves the stub was actually reached (not short-circuited): the real argv `runBr`
      // builds, through `buildArgv`'s `${ids}`/`${labels}` substitution and the runtime
      // allowlist check, as observed by the real child process itself.
      const calls = readCalls(binDir);
      const listCall = calls.find((c) => c[0] === 'list');
      expect(listCall).toEqual(['list', '--all', '--limit', '0', '--json']);
      const labelCalls = calls.filter((c) => c[0] === 'label');
      expect(labelCalls).toEqual([['label', 'add', 'b-1', '-l', LABEL, '--json']]);
    } finally {
      process.chdir(cwd);
      process.env.PATH = originalPath;
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

/**
 * Build a fresh `/tmp` copy of `beads-label.js` alongside the real, unmutated `lib/toolchain/
 * *.js` and `toolchain/**` data it `require()`s -- the same relative layout convention
 * `scripts/tests/fixtures/toolchain/mutant-toolchain-copy.js#makeMutantToolchainRoot` uses for
 * `runner.js`/`toolchain-cli.js`/`complexity-analyzer.js` -- NOT that shared fixture directly,
 * since it does not copy `beads-label.js` (it lives in `packages/development/lib`, this
 * fixture's own sibling, outside that helper's fixed file list) and extending a fixture shared
 * by other independent-review mutation proofs is out of this fix's scope. The real repo tree
 * is never written to; a caller edits one `.js` file under THIS copy, never the real source.
 */
function makeBeadsLabelMutantRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beads-label-mutant-'));
  const nodeModulesLink = path.join(root, 'node_modules');
  fs.symlinkSync(path.join(REPO_ROOT, 'node_modules'), nodeModulesLink, 'dir');

  const devPkgRoot = path.join(root, 'packages', 'development');
  const libDir = path.join(devPkgRoot, 'lib');
  const toolchainLibDir = path.join(libDir, 'toolchain');
  fs.mkdirSync(toolchainLibDir, { recursive: true });
  for (const name of fs.readdirSync(path.join(REPO_DEV_PKG, 'lib', 'toolchain'))) {
    if (!name.endsWith('.js')) continue;
    fs.copyFileSync(path.join(REPO_DEV_PKG, 'lib', 'toolchain', name), path.join(toolchainLibDir, name));
  }
  fs.copyFileSync(path.join(REPO_DEV_PKG, 'lib', 'beads-label.js'), path.join(libDir, 'beads-label.js'));
  // `runner.js` requires `../complexity-analyzer` (for `redactSecrets`) despite living under
  // `lib/toolchain`, so this copy's `lib` directory needs that sibling file too.
  fs.copyFileSync(
    path.join(REPO_DEV_PKG, 'lib', 'complexity-analyzer.js'),
    path.join(libDir, 'complexity-analyzer.js')
  );
  fs.cpSync(path.join(REPO_DEV_PKG, 'toolchain'), path.join(devPkgRoot, 'toolchain'), { recursive: true });

  return {
    beadsLabelPath: path.join(libDir, 'beads-label.js'),
    cleanup: () => {
      try {
        fs.rmSync(nodeModulesLink, { force: true });
      } catch {
        // already gone
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

/** Same single-replacement, loud-on-miss convention as `mutant-toolchain-copy.js#mutateAndRequire`. */
function mutateAndRequireFresh(filePath, needle, replacement) {
  const original = fs.readFileSync(filePath, 'utf8');
  if (!original.includes(needle)) {
    throw new Error(`mutateAndRequireFresh: needle not found in ${filePath}: ${JSON.stringify(needle)}`);
  }
  const mutated = original.replace(needle, replacement);
  fs.writeFileSync(filePath, mutated);
  // eslint-disable-next-line global-require, import/no-dynamic-require
  return require(filePath);
}

describe('mutation-restore proof: the default runBr route actually discriminates (real process)', () => {
  test("corrupting runBr's list-branch return from a JSON string to a plain object breaks ensureLabel, proving this suite catches the reviewer-found mutant", () => {
    const mutantRoot = makeBeadsLabelMutantRoot();
    const { dir: projectRoot, binDir } = mkProjectRoot(ADAPTER_ID);
    const cwd = process.cwd();
    const originalPath = process.env.PATH;
    try {
      // Reproduces the reviewer's own mutation verbatim: `runBr`'s `list` branch must return
      // `result.data` (a raw JSON string) unchanged -- wrapping it in an object instead means
      // `ensureLabel`'s `JSON.parse(run([...]))` receives `String({issues:...})` ===
      // `"[object Object]"`, which is not valid JSON.
      const mutantEnsureLabel = mutateAndRequireFresh(
        mutantRoot.beadsLabelPath,
        'return result.data;',
        'return { issues: result.data };'
      ).ensureLabel;

      process.env.PATH = `${binDir}${path.delimiter}${originalPath}`;
      process.chdir(projectRoot);

      expect(() => mutantEnsureLabel({ label: LABEL, match: MATCH })).toThrow(
        /is not valid JSON|Unexpected token/
      );
    } finally {
      process.chdir(cwd);
      process.env.PATH = originalPath;
      fs.rmSync(projectRoot, { recursive: true, force: true });
      mutantRoot.cleanup();
    }
  });
});
