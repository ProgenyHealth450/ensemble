'use strict';
/**
 * Unit tests for scripts/lib/toolchain-vendor.js (TRD-020, PRD REQ-021): the shared copy
 * routine both scripts/generate-codex/index.js and scripts/generate-opencode/index.js use to
 * vendor the toolchain-cli.js runtime into their generated output.
 *
 * These exercise the module directly against a synthetic `sourceRoot` built under
 * os.tmpdir() (never the real repo tree), so they stay independent of whatever the real
 * packages/development/toolchain data currently contains and never touch the real generator
 * output directories. The generator-level wiring (copyAdapterSkills/vendorCodexToolchain
 * against the real .codex output, and the OpenCode pipeline against --output-dir) is covered
 * separately in scripts/tests/generate-codex.test.js and packages/opencode/tests/.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { vendorToolchainLibrary, copyDirRecursive } = require('../lib/toolchain-vendor');

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}

/** Build a synthetic monorepo source tree with exactly the files vendorToolchainLibrary needs. */
function makeFakeSourceRoot(tmpDir) {
  const sourceRoot = path.join(tmpDir, 'fake-repo');
  writeFile(
    path.join(sourceRoot, 'packages', 'development', 'lib', 'toolchain-cli.js'),
    "require('./toolchain/config');\nmodule.exports = {};\n"
  );
  writeFile(
    path.join(sourceRoot, 'packages', 'development', 'lib', 'complexity-analyzer.js'),
    'module.exports = { redactSecrets: (s) => s };\n'
  );
  writeFile(
    path.join(sourceRoot, 'packages', 'development', 'lib', 'toolchain', 'config.js'),
    "require('../complexity-analyzer');\nmodule.exports = {};\n"
  );
  writeFile(
    path.join(sourceRoot, 'packages', 'development', 'lib', 'toolchain', 'ledger.js'),
    "require('../complexity-analyzer');\nmodule.exports = {};\n"
  );
  writeFile(
    path.join(sourceRoot, 'packages', 'development', 'toolchain', 'toolchain.default.yaml'),
    'host: github\n'
  );
  writeFile(
    path.join(sourceRoot, 'packages', 'development', 'toolchain', 'categories', 'tracker.yaml'),
    'category: tracker\n'
  );
  writeFile(
    path.join(sourceRoot, 'packages', 'development', 'toolchain', 'schemas', 'normalized', 'work-item.json'),
    '{}'
  );
  return sourceRoot;
}

describe('vendorToolchainLibrary', () => {
  let tmpDir;
  let sourceRoot;
  let vendorRoot;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toolchain-vendor-'));
    sourceRoot = makeFakeSourceRoot(tmpDir);
    vendorRoot = path.join(tmpDir, 'vendor-out');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('copies toolchain-cli.js, complexity-analyzer.js, every toolchain/*.js submodule and the full data dir, preserving relative layout', () => {
    const { files } = vendorToolchainLibrary({
      sourceRoot,
      vendorRoot,
      packageName: '@test/toolchain-vendor',
      dryRun: false,
      verbose: false,
    });

    expect(files.length).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(vendorRoot, 'lib', 'toolchain-cli.js'))).toBe(true);
    expect(fs.existsSync(path.join(vendorRoot, 'lib', 'complexity-analyzer.js'))).toBe(true);
    expect(fs.existsSync(path.join(vendorRoot, 'lib', 'toolchain', 'config.js'))).toBe(true);
    expect(fs.existsSync(path.join(vendorRoot, 'lib', 'toolchain', 'ledger.js'))).toBe(true);
    expect(fs.existsSync(path.join(vendorRoot, 'toolchain', 'toolchain.default.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(vendorRoot, 'toolchain', 'categories', 'tracker.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(vendorRoot, 'toolchain', 'schemas', 'normalized', 'work-item.json'))).toBe(true);

    // The exact relative relationship toolchain-cli.js's own requires and
    // path.join(__dirname, '..', '..', 'toolchain', ...) data-dir lookups depend on:
    // <vendorRoot>/lib/toolchain/<module>.js -> ../.. -> <vendorRoot> -> + 'toolchain'.
    const fromSubmodule = path.join(vendorRoot, 'lib', 'toolchain', '..', '..', 'toolchain');
    expect(fs.realpathSync(fromSubmodule)).toBe(fs.realpathSync(path.join(vendorRoot, 'toolchain')));
  });

  test('every vendored toolchain/*.js module resolves its sibling requires inside the vendor copy alone (no reference back to sourceRoot)', () => {
    vendorToolchainLibrary({
      sourceRoot,
      vendorRoot,
      packageName: '@test/toolchain-vendor',
      dryRun: false,
      verbose: false,
    });

    // Load the vendored ledger.js copy in-process; its require('../complexity-analyzer') must
    // resolve to <vendorRoot>/lib/complexity-analyzer.js, not the fake sourceRoot's copy.
    delete require.cache[require.resolve(path.join(vendorRoot, 'lib', 'toolchain', 'ledger.js'))];
    expect(() => require(path.join(vendorRoot, 'lib', 'toolchain', 'ledger.js'))).not.toThrow();
  });

  test('writes a package.json at the vendor root declaring the ajv/js-yaml dependencies the vendored modules hard-require', () => {
    vendorToolchainLibrary({
      sourceRoot,
      vendorRoot,
      packageName: '@test/toolchain-vendor',
      dryRun: false,
      verbose: false,
    });

    const pkg = JSON.parse(fs.readFileSync(path.join(vendorRoot, 'package.json'), 'utf-8'));
    expect(pkg.name).toBe('@test/toolchain-vendor');
    expect(pkg.dependencies).toEqual({ ajv: '^8.12.0', 'js-yaml': '^4.1.0' });
    expect(pkg.private).toBe(true);
  });

  test('dryRun writes nothing to disk but still reports every file it would vendor', () => {
    const { files } = vendorToolchainLibrary({
      sourceRoot,
      vendorRoot,
      packageName: '@test/toolchain-vendor',
      dryRun: true,
      verbose: false,
    });

    expect(files.length).toBeGreaterThan(0);
    expect(fs.existsSync(vendorRoot)).toBe(false);
  });

  test('missing toolchain-cli.js source is tolerated (no throw), vendoring only what exists', () => {
    fs.rmSync(path.join(sourceRoot, 'packages', 'development', 'lib', 'toolchain-cli.js'));

    const { files } = vendorToolchainLibrary({
      sourceRoot,
      vendorRoot,
      packageName: '@test/toolchain-vendor',
      dryRun: false,
      verbose: false,
    });

    expect(fs.existsSync(path.join(vendorRoot, 'lib', 'toolchain-cli.js'))).toBe(false);
    expect(fs.existsSync(path.join(vendorRoot, 'lib', 'toolchain', 'config.js'))).toBe(true);
    expect(files.length).toBeGreaterThan(0);
  });

  test('a toolchain submodule or data file removed from source since the last vendoring run is pruned from vendorRoot on the next run (TRD-020 P2 fix: no resetOutput() equivalent for this shared vendor routine when called from generate-opencode)', () => {
    vendorToolchainLibrary({
      sourceRoot,
      vendorRoot,
      packageName: '@test/toolchain-vendor',
      dryRun: false,
      verbose: false,
    });
    expect(fs.existsSync(path.join(vendorRoot, 'lib', 'toolchain', 'ledger.js'))).toBe(true);
    expect(fs.existsSync(path.join(vendorRoot, 'toolchain', 'categories', 'tracker.yaml'))).toBe(true);

    // Remove ledger.js and the whole categories/ dir from the SOURCE, then re-vendor into the
    // same vendorRoot (simulating a second generator run after an upstream module/category was
    // deleted or renamed).
    fs.rmSync(path.join(sourceRoot, 'packages', 'development', 'lib', 'toolchain', 'ledger.js'));
    fs.rmSync(path.join(sourceRoot, 'packages', 'development', 'toolchain', 'categories'), {
      recursive: true,
      force: true,
    });

    const { removedFiles } = vendorToolchainLibrary({
      sourceRoot,
      vendorRoot,
      packageName: '@test/toolchain-vendor',
      dryRun: false,
      verbose: false,
    });

    // Mutation-proof target: pre-fix (purely additive copy), these stale files/dirs remain in
    // vendorRoot forever even though their source no longer exists.
    expect(fs.existsSync(path.join(vendorRoot, 'lib', 'toolchain', 'ledger.js'))).toBe(false);
    expect(fs.existsSync(path.join(vendorRoot, 'toolchain', 'categories', 'tracker.yaml'))).toBe(false);
    expect(fs.existsSync(path.join(vendorRoot, 'toolchain', 'categories'))).toBe(false);
    // Still-sourced files survive the prune untouched.
    expect(fs.existsSync(path.join(vendorRoot, 'lib', 'toolchain', 'config.js'))).toBe(true);
    expect(fs.existsSync(path.join(vendorRoot, 'toolchain', 'toolchain.default.yaml'))).toBe(true);
    expect(removedFiles.some((f) => f.endsWith(path.join('toolchain', 'ledger.js')))).toBe(true);
  });
});

describe('copyDirRecursive', () => {
  let tmpDir;

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('returns an empty array and writes nothing when the source directory does not exist', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toolchain-vendor-copydir-'));
    const copied = copyDirRecursive(path.join(tmpDir, 'missing'), path.join(tmpDir, 'out'), false);
    expect(copied).toEqual([]);
    expect(fs.existsSync(path.join(tmpDir, 'out'))).toBe(false);
  });

  test('recursively copies nested directories byte-for-byte', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toolchain-vendor-copydir-'));
    const src = path.join(tmpDir, 'src');
    writeFile(path.join(src, 'a.yaml'), 'a: 1\n');
    writeFile(path.join(src, 'nested', 'b.json'), '{"b":2}');

    const dest = path.join(tmpDir, 'dest');
    const copied = copyDirRecursive(src, dest, false);

    expect(copied.sort()).toEqual(
      [path.join(dest, 'a.yaml'), path.join(dest, 'nested', 'b.json')].sort()
    );
    expect(fs.readFileSync(path.join(dest, 'a.yaml'), 'utf-8')).toBe('a: 1\n');
    expect(fs.readFileSync(path.join(dest, 'nested', 'b.json'), 'utf-8')).toBe('{"b":2}');
  });
});
