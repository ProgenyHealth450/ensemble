/**
 * Lib Bundler
 *
 * Copies the small set of monorepo lib/script files that command prose in
 * packages/pi shells out to (trd-cli.js, trd-graph-cli.js, prd-cli.js,
 * validate-git-town.sh) into packages/pi/vendor/, so the Pi/OMP runtime has
 * them available when only `@sunstone-partners/ensemble-pi` is installed
 * (no ensemble source checkout, no Claude Code plugin, no packages/full
 * symlink layer to fall back on).
 *
 * Unlike packages/full/lib/ (which uses symlinks — see
 * scripts/validate-all.js's mirror check), this package is npm-published,
 * and npm's handling of symlinks varies across platforms and package
 * managers. Files here are copied byte-for-byte with plain fs reads/writes,
 * matching the approach used by ../transformers/skill-copier.ts.
 *
 * Output layout:
 *   packages/pi/vendor/lib/<filename>       (.js sources)
 *   packages/pi/vendor/scripts/<filename>   (.sh sources)
 *
 * The executable bit is preserved for shell scripts (fs.chmodSync 0o755
 * after write) since validate-git-town.sh is invoked directly.
 *
 * @module ensemble-pi/transformers/lib-bundler
 */

import * as fs from 'fs';
import * as path from 'path';
import { TransformResult } from '../types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Source files to vendor, relative to sourceRoot, alongside their relative
 * output location under outputRoot/vendor/.
 */
const VENDOR_FILES: Array<{ src: string; dest: string }> = [
  { src: 'packages/development/lib/trd-cli.js', dest: 'vendor/lib/trd-cli.js' },
  { src: 'packages/development/lib/trd-graph-cli.js', dest: 'vendor/lib/trd-graph-cli.js' },
  { src: 'packages/development/lib/prd-cli.js', dest: 'vendor/lib/prd-cli.js' },
  {
    src: 'packages/git/skills/git-town/scripts/validate-git-town.sh',
    dest: 'vendor/scripts/validate-git-town.sh',
  },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Copy vendored lib/script files into outputRoot/vendor/ for Pi runtime
 * consumption.
 *
 * @param sourceRoot  Monorepo root (contains packages/ directory)
 * @param outputRoot  Pi package root (packages/pi) — output goes to outputRoot/vendor/
 * @param options     Runtime options
 * @returns           Array of TransformResult entries, one per file copied
 */
export async function bundleLibs(
  sourceRoot: string,
  outputRoot: string,
  options: { dryRun?: boolean; verbose?: boolean }
): Promise<TransformResult[]> {
  const { dryRun = false, verbose = false } = options;

  const results: TransformResult[] = [];

  if (verbose) {
    process.stdout.write(`lib-bundler: vendoring ${VENDOR_FILES.length} file(s)\n`);
  }

  for (const { src, dest } of VENDOR_FILES) {
    const sourcePath = path.join(sourceRoot, src);
    const outputPath = path.join(outputRoot, dest);

    let content: string;
    try {
      content = fs.readFileSync(sourcePath, 'utf-8');
    } catch (err) {
      process.stderr.write(
        `  lib-bundler: warning — cannot read ${sourcePath}: ${(err as Error).message}\n`
      );
      continue;
    }

    const result: TransformResult = {
      sourcePath,
      outputPath,
      content,
      type: 'lib',
    };

    if (!dryRun) {
      try {
        const outDir = path.dirname(outputPath);
        if (!fs.existsSync(outDir)) {
          fs.mkdirSync(outDir, { recursive: true });
        }
        fs.writeFileSync(outputPath, content, 'utf-8');

        // Preserve the executable bit for shell scripts.
        if (outputPath.endsWith('.sh')) {
          const sourceMode = fs.statSync(sourcePath).mode;
          fs.chmodSync(outputPath, sourceMode & 0o777 || 0o755);
        }
      } catch (err) {
        process.stderr.write(
          `  lib-bundler: warning — cannot write ${outputPath}: ${(err as Error).message}\n`
        );
        continue;
      }
    }

    if (verbose) {
      process.stdout.write(`  lib: ${sourcePath} → ${outputPath}\n`);
    }

    results.push(result);
  }

  if (verbose) {
    process.stdout.write(
      `lib-bundler: ${results.length} file(s) ${dryRun ? 'collected (dry-run)' : 'copied'}.\n`
    );
  }

  return results;
}
