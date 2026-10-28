'use strict';

/**
 * bdd-mode.js — decide whether a TRD run uses the Reqnroll/BDD test path.
 *
 * Reqnroll is a .NET tool, so the TRD commands must not assume it. `create-trd` and
 * `implement-trd-beads` both call `trd-cli resolve-bdd`, which wraps `resolveBdd` below, so the
 * two commands always agree. First match wins:
 *
 *   1. `flag`     — `--bdd` / `--no-bdd` (create-trd only; the CLI maps them to 'bdd' | 'no-bdd')
 *   2. `env`      — ENSEMBLE_BDD = 1|true|on|yes (on) or 0|false|off|no (off)
 *   3. `trd`      — the TRD's `test_approach` frontmatter (`bdd-reqnroll` | `standard`), which
 *                   create-trd writes when the choice was explicit (flag, env or detected) so the TRD
 *                   stays self-describing. A TRD written on the bare default (5) carries none, so
 *                   Reqnroll added to the repo afterwards is still picked up by implement-trd-beads
 *   4. `detected` — a Reqnroll package reference in a project manifest under the repo root
 *   5. `default`  — off
 *
 * Pure and injectable (`env`, `repoRoot`) so tests never touch process state.
 */

const fs = require('fs');
const path = require('path');
const { splitFrontmatter, normalizeLineEndings, getFrontmatterField } = require('./trd-parser');

const ENV_VAR = 'ENSEMBLE_BDD';
const STAMP_KEY = 'test_approach';
const STAMP_BDD = 'bdd-reqnroll';
const STAMP_STANDARD = 'standard';

const ENV_ON = new Set(['1', 'true', 'on', 'yes']);
const ENV_OFF = new Set(['0', 'false', 'off', 'no']);

// Project manifests that can name a package reference.
const MANIFEST = /(?:\.csproj|\.fsproj|\.vbproj)$|^(?:Directory\.Packages\.props|Directory\.Build\.props|packages\.config)$/i;
// `Include="Reqnroll.xUnit"`, `Update='Reqnroll'`, `id="Reqnroll"` — a quoted package id, not prose.
const REQNROLL_REF = /["']Reqnroll(?:\.[\w.]+)?["']/i;
// Directories that never hold the project's own manifests (or are huge).
const SKIP_DIRS = new Set(['.git', 'node_modules', 'bin', 'obj', 'dist', '.claude', '.vs', '.idea']);
// ponytail: depth-first walk with a directory cap; if a monorepo ever outgrows it, raise the cap
// or take a `--repo` pointing at the solution folder.
const MAX_DIRS = 20000;

const toPosix = (p) => p.split(path.sep).join('/');

/**
 * Find the first project manifest under `root` that references Reqnroll.
 * @param {string} root
 * @returns {string|null} path relative to `root` (forward slashes), or null
 */
function detectReqnroll(root) {
  const stack = [root];
  let visited = 0;
  while (stack.length > 0 && visited < MAX_DIRS) {
    const dir = stack.pop();
    visited += 1;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable directory: skip it, never fail the command
    }
    // Sorted so the reported evidence is stable across platforms.
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(full);
      } else if (entry.isFile() && MANIFEST.test(entry.name)) {
        try {
          if (REQNROLL_REF.test(fs.readFileSync(full, 'utf8'))) return toPosix(path.relative(root, full));
        } catch {
          // unreadable manifest: ignore
        }
      }
    }
  }
  return null;
}

/** @returns {boolean|null} true/false for a recognised value, null when unset or unrecognised */
function parseEnv(value) {
  if (value == null) return null;
  const v = String(value).trim().toLowerCase();
  if (ENV_ON.has(v)) return true;
  if (ENV_OFF.has(v)) return false;
  return null;
}

/** Read the TRD's `test_approach` frontmatter. @returns {{value:boolean|null, raw:string|null}} */
function readStamp(trdPath) {
  let raw;
  try {
    const { frontmatter } = splitFrontmatter(normalizeLineEndings(fs.readFileSync(trdPath, 'utf8')));
    raw = getFrontmatterField(frontmatter, STAMP_KEY);
  } catch {
    return { value: null, raw: null };
  }
  if (raw == null || String(raw).trim() === '') return { value: null, raw: null };
  const v = String(raw).trim().toLowerCase();
  if (v === STAMP_BDD) return { value: true, raw: v };
  if (v === STAMP_STANDARD) return { value: false, raw: v };
  return { value: null, raw: String(raw) };
}

/**
 * Build the result. `message` is the one line the commands print (the warning, if any, first), so
 * the wording lives here rather than in two command prompts.
 */
function decide(enabled, source, evidence, warning) {
  const out = { enabled, source };
  if (evidence) out.evidence = evidence;
  if (warning) out.warning = warning;
  const where = source === 'detected' ? `${source}: ${evidence}` : source;
  out.message = `${warning ? `Warning: ${warning}
` : ''}Test approach: ${enabled ? 'BDD (Reqnroll)' : 'standard'} [${where}]`;
  return out;
}

/**
 * @param {object} [opts]
 * @param {'bdd'|'no-bdd'} [opts.flag]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {string} [opts.trdPath]   consult this TRD's `test_approach`
 * @param {string} [opts.repoRoot]  where to look for Reqnroll (default: cwd)
 * @returns {{enabled:boolean, source:'flag'|'env'|'trd'|'detected'|'default', evidence?:string, warning?:string, message:string}}
 */
function resolveBdd(opts = {}) {
  const { flag, env = process.env, trdPath, repoRoot = process.cwd() } = opts;
  let warning;

  if (flag === 'bdd' || flag === 'no-bdd') return decide(flag === 'bdd', 'flag');

  const envValue = parseEnv(env[ENV_VAR]);
  if (envValue !== null) return decide(envValue, 'env');
  if (env[ENV_VAR] != null && String(env[ENV_VAR]).trim() !== '') {
    warning = `${ENV_VAR}='${env[ENV_VAR]}' is not one of 1/true/on/yes or 0/false/off/no; ignored`;
  }

  if (trdPath) {
    const stamp = readStamp(trdPath);
    if (stamp.value !== null) return decide(stamp.value, 'trd', toPosix(trdPath));
    if (stamp.raw !== null) {
      warning = `${STAMP_KEY} '${stamp.raw}' in ${toPosix(trdPath)} is not '${STAMP_BDD}' or '${STAMP_STANDARD}'; ignored`;
    }
  }

  const hit = detectReqnroll(repoRoot);
  return hit ? decide(true, 'detected', hit, warning) : decide(false, 'default', undefined, warning);
}

module.exports = { resolveBdd, detectReqnroll, ENV_VAR, STAMP_KEY, STAMP_BDD, STAMP_STANDARD };
