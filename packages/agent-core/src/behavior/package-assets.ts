/**
 * Package asset loading and the package digest (REQ-BEH-003, Story 2.3).
 *
 * Two requirements pull in opposite directions and both have to hold:
 * prompt text must be editable without rebuilding TypeScript, and it must
 * still be possible to say exactly what ran. An editable file that is not in
 * any digest satisfies the first and abandons the second — two runs would
 * report the same behavior version having used different instructions.
 *
 * So assets are read from disk at invocation (never cached across runs) and
 * hashed into a package digest alongside the manifest. The digest changes when
 * a prompt changes; nothing needs rebuilding for that to happen.
 *
 * The concrete failure this addresses: an installed extension bundle was once
 * built from a checkout three commits behind, and several runs tested code
 * that did not contain the fix under test. A digest that covers the assets,
 * reported next to the ACTIVE package path, makes that visible instead of
 * invisible.
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { BehaviorManifest } from "./schema";
import { computeManifestDigest } from "./compiler";

/** Files inside a package directory that participate in the digest. */
const ASSET_EXTENSIONS = [".md", ".yaml", ".yml", ".json", ".txt"];
/** Never treated as package assets: fixtures are test data, not behavior. */
const ASSET_EXCLUDED_DIRS = new Set(["fixtures", "node_modules", ".git"]);

export interface PackageAsset {
  /** Package-relative path, using forward slashes on every platform. */
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface LoadedPackageAssets {
  readonly assets: readonly PackageAsset[];
  /** Digest over the manifest plus every asset. */
  readonly packageDigest: string;
}

function listAssetFiles(dir: string, root: string, into: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return into;
  }
  for (const entry of entries.sort()) {
    const abs = join(dir, entry);
    let stat;
    try {
      stat = statSync(abs);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      if (ASSET_EXCLUDED_DIRS.has(entry)) continue;
      listAssetFiles(abs, root, into);
      continue;
    }
    if (!ASSET_EXTENSIONS.some((ext) => entry.endsWith(ext))) continue;
    into.push(relative(root, abs).split(sep).join("/"));
  }
  return into;
}

/**
 * Hashes a package directory's assets and folds them into one digest with the
 * manifest.
 *
 * Sorted by path before hashing, so the digest is a property of the content
 * rather than of directory-read order.
 */
export function loadPackageAssets(packageDir: string, manifest: BehaviorManifest): LoadedPackageAssets {
  const paths = listAssetFiles(packageDir, packageDir).sort();
  const assets: PackageAsset[] = [];

  for (const path of paths) {
    let contents: Buffer;
    try {
      contents = readFileSync(join(packageDir, path));
    } catch {
      continue;
    }
    assets.push({
      path,
      sha256: createHash("sha256").update(contents).digest("hex"),
      bytes: contents.byteLength,
    });
  }

  const hash = createHash("sha256");
  hash.update(computeManifestDigest(manifest));
  for (const asset of assets) hash.update(`\n${asset.path}:${asset.sha256}`);

  return { assets, packageDigest: hash.digest("hex") };
}

/**
 * Reads one package-relative asset.
 *
 * Path containment is enforced here rather than trusted from validation: a
 * prompt reference is package data, and package data is exactly the input that
 * must not be able to name `../../../etc/passwd`. Validation catches the
 * honest mistake; this catches the rest.
 */
export function readPackageAsset(packageDir: string, relativePath: string): string | undefined {
  if (relativePath.startsWith("/") || relativePath.split(/[\\/]/).includes("..")) return undefined;
  try {
    return readFileSync(join(packageDir, relativePath), "utf8");
  } catch {
    return undefined;
  }
}

/** A `PromptLoader` bound to one package directory, re-reading on every call. */
export function createPromptLoader(packageDir: string): (relativePath: string) => string | undefined {
  return (relativePath) => readPackageAsset(packageDir, relativePath);
}
