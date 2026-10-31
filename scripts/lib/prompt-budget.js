'use strict';
/**
 * Prompt word-budget lint.
 *
 * Metric: whole-file word count (equivalent to `wc -w`: whitespace-separated
 * tokens) of each SOURCE instruction file:
 *   - packages/<pkg>/commands/*.yaml   ceiling 2500
 *   - packages/<pkg>/agents/*.yaml     ceiling 1200
 *   - packages/<pkg>/**\/SKILL.md      ceiling 1500
 * Generated output (packages/pi, codex, opencode), node_modules and symlinks
 * (packages/full mirrors) are skipped so each source is counted once.
 *
 * Ratchet: scripts/prompt-budget-baseline.json maps path -> maxWords for files
 * already over their ceiling. A baselined file fails if it grows past its
 * baseline; an unbaselined file fails if over the ceiling; a baselined file
 * that shrank only yields an advisory. Regenerate with:
 *   node scripts/validate-all.js --update-prompt-baseline
 */

const fs = require('fs');
const path = require('path');

const CEILINGS = { command: 2500, agent: 1200, skill: 1500 };
const EXCLUDED_PACKAGES = new Set(['pi', 'codex', 'opencode']);
const BASELINE_PATH = path.join(__dirname, '..', 'prompt-budget-baseline.json');

function countWords(text) {
  const m = text.match(/\S+/g);
  return m ? m.length : 0;
}

function classify(relPath) {
  const parts = relPath.split('/');
  const name = parts[parts.length - 1];
  if (name === 'SKILL.md') return 'skill';
  if (parts.length === 4 && parts[2] === 'commands' && name.endsWith('.yaml')) return 'command';
  if (parts.length === 4 && parts[2] === 'agents' && name.endsWith('.yaml')) return 'agent';
  return null;
}

/** @returns {Object<string, {kind: string, words: number}>} keyed by repo-relative posix path */
function collectSizes(packagesDir) {
  const root = path.dirname(packagesDir);
  const sizes = {};
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (dir === packagesDir && EXCLUDED_PACKAGES.has(entry.name)) continue;
        walk(full);
      } else if (entry.isFile()) {
        const rel = path.relative(root, full).split(path.sep).join('/');
        const kind = classify(rel);
        if (kind) sizes[rel] = { kind, words: countWords(fs.readFileSync(full, 'utf8')) };
      }
    }
  };
  walk(packagesDir);
  return sizes;
}

/** Pure check. @returns {{failures: string[], advisories: string[]}} */
function checkBudgets(sizes, baseline, ceilings = CEILINGS) {
  const failures = [];
  const advisories = [];
  for (const [file, { kind, words }] of Object.entries(sizes)) {
    const ceiling = ceilings[kind];
    const base = baseline[file];
    if (base === undefined) {
      if (words > ceiling) {
        failures.push(`${file}: ${words} words exceeds ${kind} ceiling of ${ceiling} (not baselined)`);
      }
    } else if (words > base) {
      failures.push(`${file}: ${words} words exceeds its baseline of ${base} (${kind} ceiling ${ceiling}); trim it, do not raise the baseline`);
    } else if (words < base) {
      advisories.push(`${file}: ${words} words is below its baseline of ${base}; lower the baseline (node scripts/validate-all.js --update-prompt-baseline)`);
    }
  }
  return { failures, advisories };
}

/** Baseline = every file currently over its ceiling, at its current size. */
function buildBaseline(sizes, ceilings = CEILINGS) {
  const out = {};
  for (const file of Object.keys(sizes).sort()) {
    if (sizes[file].words > ceilings[sizes[file].kind]) out[file] = sizes[file].words;
  }
  return out;
}

function loadBaseline(file = BASELINE_PATH) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
}

function writeBaseline(baseline, file = BASELINE_PATH) {
  fs.writeFileSync(file, JSON.stringify(baseline, null, 2) + '\n');
}

module.exports = { CEILINGS, BASELINE_PATH, countWords, classify, collectSizes, checkBudgets, buildBaseline, loadBaseline, writeBaseline };
