/**
 * Tests for lib-bundler transformer
 *
 * Covers:
 * 1. Copies the four vendored source files into outputRoot/vendor/
 * 2. Result shape: type === 'lib', sourcePath, outputPath, content
 * 3. Dry-run mode: returns results but writes no files
 * 4. Executable bit preserved on the copied .sh file
 * 5. Missing source file: warns and skips rather than throwing
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { bundleLibs } from '../src/transformers/lib-bundler';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pi-lib-bundler-'));
}

function rmrf(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Build a minimal fake monorepo under `root` containing the four files
 * lib-bundler.ts expects to vendor.
 */
function buildFakeMonorepo(root: string): void {
  const devLib = path.join(root, 'packages', 'development', 'lib');
  fs.mkdirSync(devLib, { recursive: true });
  fs.writeFileSync(path.join(devLib, 'trd-cli.js'), '#!/usr/bin/env node\nconsole.log("trd-cli");\n', 'utf-8');
  fs.writeFileSync(path.join(devLib, 'trd-graph-cli.js'), '#!/usr/bin/env node\nconsole.log("trd-graph-cli");\n', 'utf-8');
  fs.writeFileSync(path.join(devLib, 'prd-cli.js'), '#!/usr/bin/env node\nconsole.log("prd-cli");\n', 'utf-8');

  const gitScripts = path.join(root, 'packages', 'git', 'skills', 'git-town', 'scripts');
  fs.mkdirSync(gitScripts, { recursive: true });
  const shPath = path.join(gitScripts, 'validate-git-town.sh');
  fs.writeFileSync(shPath, '#!/usr/bin/env bash\necho "validate-git-town"\n', 'utf-8');
  fs.chmodSync(shPath, 0o755);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('bundleLibs', () => {
  let sourceRoot: string;
  let outputRoot: string;

  beforeEach(() => {
    sourceRoot = createTempDir();
    outputRoot = createTempDir();
    buildFakeMonorepo(sourceRoot);
  });

  afterEach(() => {
    rmrf(sourceRoot);
    rmrf(outputRoot);
  });

  it('copies all four vendored files', async () => {
    const results = await bundleLibs(sourceRoot, outputRoot, {});
    expect(results.length).toBe(4);
  });

  it('writes files under outputRoot/vendor/', async () => {
    const results = await bundleLibs(sourceRoot, outputRoot, {});

    for (const result of results) {
      expect(result.outputPath.startsWith(path.join(outputRoot, 'vendor'))).toBe(true);
      expect(fs.existsSync(result.outputPath)).toBe(true);
    }
  });

  it('writes content that matches result.content to disk', async () => {
    const results = await bundleLibs(sourceRoot, outputRoot, {});

    for (const result of results) {
      const written = fs.readFileSync(result.outputPath, 'utf-8');
      expect(written).toBe(result.content);
    }
  });

  it('places .js files under vendor/lib/ and the .sh file under vendor/scripts/', async () => {
    const results = await bundleLibs(sourceRoot, outputRoot, {});

    const jsResults = results.filter((r) => r.outputPath.endsWith('.js'));
    const shResults = results.filter((r) => r.outputPath.endsWith('.sh'));

    expect(jsResults.length).toBe(3);
    expect(shResults.length).toBe(1);

    for (const result of jsResults) {
      expect(result.outputPath).toContain(path.join('vendor', 'lib'));
    }
    for (const result of shResults) {
      expect(result.outputPath).toContain(path.join('vendor', 'scripts'));
    }
  });

  it('preserves the executable bit on the copied .sh file', async () => {
    const results = await bundleLibs(sourceRoot, outputRoot, {});
    const shResult = results.find((r) => r.outputPath.endsWith('.sh'));
    expect(shResult).toBeDefined();

    const mode = fs.statSync(shResult!.outputPath).mode;
    // Owner-executable bit must be set
    expect(mode & 0o100).toBeTruthy();
  });

  it('each result has type === "lib"', async () => {
    const results = await bundleLibs(sourceRoot, outputRoot, {});
    for (const result of results) {
      expect(result.type).toBe('lib');
    }
  });

  it('each result has non-empty sourcePath, outputPath, and content fields', async () => {
    const results = await bundleLibs(sourceRoot, outputRoot, {});
    for (const result of results) {
      expect(typeof result.sourcePath).toBe('string');
      expect(result.sourcePath.length).toBeGreaterThan(0);
      expect(typeof result.outputPath).toBe('string');
      expect(result.outputPath.length).toBeGreaterThan(0);
      expect(typeof result.content).toBe('string');
      expect(result.content.length).toBeGreaterThan(0);
    }
  });

  it('returns results without writing files when dryRun is true', async () => {
    const results = await bundleLibs(sourceRoot, outputRoot, { dryRun: true });

    expect(results.length).toBe(4);

    const vendorOutputDir = path.join(outputRoot, 'vendor');
    expect(fs.existsSync(vendorOutputDir)).toBe(false);
  });

  it('skips missing source files with a warning instead of throwing', async () => {
    // Remove one of the expected source files
    fs.rmSync(path.join(sourceRoot, 'packages', 'development', 'lib', 'prd-cli.js'));

    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const results = await bundleLibs(sourceRoot, outputRoot, {});
      // Only 3 of the 4 files should have been copied
      expect(results.length).toBe(3);
      expect(results.some((r) => r.outputPath.endsWith('prd-cli.js'))).toBe(false);
      expect(stderrSpy).toHaveBeenCalled();
    } finally {
      stderrSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Integration: real packages directory
// ---------------------------------------------------------------------------
describe('bundleLibs against real packages directory', () => {
  let outputRoot: string;
  // Monorepo root is two levels up from packages/pi/
  const repoRoot = path.resolve(__dirname, '..', '..', '..');

  beforeEach(() => {
    outputRoot = createTempDir();
  });

  afterEach(() => {
    rmrf(outputRoot);
  });

  it('bundles all four real vendored files', async () => {
    const results = await bundleLibs(repoRoot, outputRoot, { dryRun: true });
    expect(results.length).toBe(4);
  });

  it('all results have type === "lib"', async () => {
    const results = await bundleLibs(repoRoot, outputRoot, { dryRun: true });
    for (const result of results) {
      expect(result.type).toBe('lib');
    }
  });
});
