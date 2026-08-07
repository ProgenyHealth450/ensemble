#!/usr/bin/env node
/**
 * Validates that release-critical version fields are in sync.
 *
 * Release check: root package.json, packages/full/package.json,
 * packages/full/.claude-plugin/plugin.json, and
 * marketplace.json (top-level + ensemble-full entry) all share
 * the same version string.
 *
 * Per-package check: every packages/<name>/ has package.json,
 * .claude-plugin/plugin.json, and its marketplace.json entry
 * on the same version. Drift here is invisible but breaks installs:
 * `claude plugin install/update` gates on plugin.json's version
 * string, so a package whose plugin.json lags never re-syncs on a
 * consuming machine — it silently serves stale content forever.
 *
 * Exit 0 = in sync, Exit 1 = mismatch (prints details).
 */

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
}

const rootPkg = readJson('package.json');
const fullPkg = readJson('packages/full/package.json');
const pluginJson = readJson('packages/full/.claude-plugin/plugin.json');
const marketplace = readJson('marketplace.json');
const fullPlugin = marketplace.plugins.find(p => p.name === 'ensemble-full');

const versions = {
  'package.json': rootPkg.version,
  'packages/full/package.json': fullPkg.version,
  'packages/full/.claude-plugin/plugin.json': pluginJson.version,
  'marketplace.json (top-level)': marketplace.version,
  'marketplace.json (ensemble-full)': fullPlugin?.version ?? 'MISSING',
};

const unique = new Set(Object.values(versions));

let failed = false;

if (unique.size === 1) {
  console.log(`✓ All release versions in sync: ${rootPkg.version}`);
} else {
  failed = true;
  console.error('✗ Release version mismatch detected:');
  for (const [source, ver] of Object.entries(versions)) {
    console.error(`  ${source}: ${ver}`);
  }
  console.error('\nAll five must match before tagging a release.');
}

// Per-package: package.json <-> plugin.json <-> marketplace.json entry.
const packagesDir = path.join(root, 'packages');
const drifted = [];

for (const name of fs.readdirSync(packagesDir)) {
  const pkgDir = path.join(packagesDir, name);
  if (!fs.statSync(pkgDir).isDirectory()) continue;

  const sources = {};

  const pkgPath = path.join(pkgDir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    sources['package.json'] = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;
  }

  const pluginPath = path.join(pkgDir, '.claude-plugin', 'plugin.json');
  if (fs.existsSync(pluginPath)) {
    const plugin = JSON.parse(fs.readFileSync(pluginPath, 'utf8'));
    sources['.claude-plugin/plugin.json'] = plugin.version;

    // Shared libs (e.g. multiplexer-adapters) are intentionally uncatalogued.
    const entry = marketplace.plugins.find(p => p.name === plugin.name);
    if (entry) sources['marketplace.json'] = entry.version;
  }

  const found = Object.values(sources).filter(Boolean);
  if (found.length > 1 && new Set(found).size > 1) {
    drifted.push({ name, sources });
  }
}

if (drifted.length === 0) {
  console.log(`✓ All ${fs.readdirSync(packagesDir).length} packages have matching manifest versions`);
} else {
  failed = true;
  console.error('\n✗ Per-package version drift detected:');
  for (const { name, sources } of drifted) {
    console.error(`  packages/${name}:`);
    for (const [source, ver] of Object.entries(sources)) {
      console.error(`    ${source}: ${ver ?? 'MISSING'}`);
    }
  }
  console.error(
    '\nA package.json/plugin.json/marketplace.json disagreement ships stale plugins:\n' +
    'the installer gates on plugin.json\'s version string, so consumers never re-sync.'
  );
}

process.exit(failed ? 1 : 0);
