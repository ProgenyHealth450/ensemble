'use strict';

/**
 * Adapter discovery and resolution (TRD-2026-8d825f54 TRD-006, PRD REQ-005, REQ-007).
 *
 * An adapter is a skill directory (`SKILL.md` plus `adapter.yaml`) that can live in one of
 * three locations, searched in this order:
 *
 *   1. repo-local: `<projectRoot>/.ensemble/adapters/<dir>/`
 *   2. user:       the `adapters` directory next to the user-level `toolchain.yaml` resolved
 *                   by `./config-path.js#getUserToolchainConfigPath()` (normally
 *                   `$XDG_CONFIG_HOME/ensemble/adapters/<dir>/`). This module never duplicates
 *                   the XDG root-resolution algorithm: it derives the adapters root as the
 *                   sibling of the resolved `toolchain.yaml` path.
 *   3. installed:  `<projectRoot>/packages/*\/skills/<dir>/` -- adapters shipped inside a
 *                   package tree (this repo's own packages, or a consumer's). Any subdirectory
 *                   of a package's `skills/` is a candidate; there is no required directory-name
 *                   prefix, since one manifest's declared `adapter` id is what selects it, not
 *                   its directory name (TRD interpretation I7).
 *
 * In every location, an adapter directory may be a real directory or a symlink that resolves to
 * one: symlinking a repo-local or user adapter slot to an externally-developed skill directory
 * is a normal way to iterate on an adapter without copying it into the target location.
 *
 * `discoverAdapters(ctx)` enumerates every adapter directory across all three locations.
 * `loadAdapter(name, ctx)` resolves exactly one adapter by the `adapter` id declared inside
 * its own manifest (never inferred from a directory name, since an installed-package
 * directory may be named anything and one manifest can implement several categories -- TRD
 * interpretation I7), honoring the search order above and the repo-local trust rule for
 * non-interactive runs (TRD interpretation I5, PRD AC-007-3). When more than one directory in
 * the same location declares the same `adapter` id, the tie-break is discovery order: first by
 * origin priority (repo-local, then user, then installed, matching the search order above),
 * then by each location's deterministic ascending directory-name sort (for installed adapters,
 * ascending package directory name, then ascending skill directory name within it). An adapter
 * name that resolves nowhere fails with a `NOT_INSTALLED` error naming the adapter, all three
 * search locations it was looked for in, and how to install it (PRD AC-007-2).
 *
 * Every manifest and `SKILL.md` is re-read and re-parsed from disk on every call: there is no
 * module-level cache, no `require()` of YAML, and no memoization keyed by path, so an edit to
 * an adapter's `adapter.yaml` or `SKILL.md` between two calls in the same process is always
 * picked up on the next call (PRD REQ-005, AC-005-1). `loadAdapter`'s result carries the
 * `SKILL.md` content as its `skillMd` field (`{ok:true, content}` or `{ok:false, error}` when
 * the file is missing or unreadable -- that case is reported, never thrown). This module never
 * spawns a process, invokes a shell, or touches the network -- it only reads the filesystem.
 *
 * `ctx.env` (where accepted) stands in for `process.env` *wholesale*, not merged with it: every
 * lookup that consults an environment variable -- the XDG root resolution in
 * `userAdaptersRoot()`/`getUserToolchainConfigPath()` and the repo-local non-interactive trust
 * check's own call to `getUserToolchainConfigPath(env)` -- reads only `ctx.env` once it is
 * supplied, even if `ctx.env` omits a key that `process.env` happens to set. Any discrepancy
 * this surfaces (for example a missing `XDG_CONFIG_HOME`) falls through to
 * `config-path.js`'s own documented fallback chain, never to `process.env` directly.
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const { getUserToolchainConfigPath } = require('./config-path');
const { loadToolchainConfigFile } = require('./config');

const MANIFEST_FILE = 'adapter.yaml';
const SKILL_FILE = 'SKILL.md';

/**
 * Decide whether one `fs.Dirent` from `listSubdirs` should be treated as a directory. A plain
 * directory entry always counts; a symlink also counts when it resolves to a directory, since
 * pointing a repo-local or user adapter slot at an externally-developed skill directory via a
 * symlink is a normal way to develop an adapter without copying it into place. A broken
 * symlink, or any other `fs.statSync` failure while resolving it, is treated as "not a
 * directory" rather than thrown, so one bad entry never aborts discovery or leaks a raw
 * filesystem error to callers.
 *
 * @param {string} parentDir
 * @param {import('fs').Dirent} entry
 * @returns {boolean}
 */
function isDirEntry(parentDir, entry) {
  if (entry.isDirectory()) {
    return true;
  }
  if (!entry.isSymbolicLink()) {
    return false;
  }
  try {
    return fs.statSync(path.join(parentDir, entry.name)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * List the immediate subdirectory names of `dir` (following directory-resolving symlinks),
 * sorted for deterministic order, or `[]` when `dir` does not exist, is not a directory, or
 * cannot be read for any other reason. Never throws: a missing or non-directory adapters root
 * (`ENOENT`/`ENOTDIR`) or any other `readdirSync` failure is treated the same as "no adapters
 * here" so that `NOT_INSTALLED` stays the only error callers see from a bad search location.
 *
 * @param {string} dir
 * @returns {string[]}
 */
function listSubdirs(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => isDirEntry(dir, entry))
    .map((entry) => entry.name)
    .sort();
}

/**
 * Read and parse one adapter directory's `adapter.yaml` fresh off disk. No result is ever
 * cached: every call re-reads the file, so an edit made between two calls in the same process
 * is always visible on the next call.
 *
 * @param {string} dir adapter skill directory containing `adapter.yaml`
 * @returns {object|null} the parsed manifest, or `null` if missing, unreadable, invalid YAML,
 *   or not an object
 */
function readManifest(dir) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(dir, MANIFEST_FILE), 'utf8');
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = yaml.load(raw);
  } catch {
    return null;
  }
  return parsed && typeof parsed === 'object' ? parsed : null;
}

/**
 * Read one adapter directory's `SKILL.md` fresh off disk, mirroring `readManifest`'s no-cache
 * guarantee: every call re-reads the file, so an edit made between two calls in the same
 * process is always visible on the next call (PRD REQ-005 AC-005-1). A missing or unreadable
 * file is reported as a clear `{ok:false, error}` result rather than thrown, matching
 * `validate.js#checkVocabularyBlock`'s style: a resolvable adapter without a readable
 * `SKILL.md` is a fact `loadAdapter`'s caller can inspect, not a crash.
 *
 * @param {string} dir adapter skill directory containing `SKILL.md`
 * @returns {{ok: true, content: string} | {ok: false, error: string}}
 */
function readSkillMd(dir) {
  const skillMdPath = path.join(dir, SKILL_FILE);
  try {
    return { ok: true, content: fs.readFileSync(skillMdPath, 'utf8') };
  } catch (error) {
    return { ok: false, error: `${skillMdPath}: missing or unreadable (${error.code || error.message})` };
  }
}

/**
 * Repo-local adapters root: `<projectRoot>/.ensemble/adapters`.
 * @param {string} projectRoot
 * @returns {string}
 */
function repoLocalAdaptersRoot(projectRoot) {
  return path.join(projectRoot, '.ensemble', 'adapters');
}

/**
 * User-level adapters root: the `adapters` directory that sits next to the user `toolchain.yaml`
 * resolved by `config-path.js`, so the XDG root-resolution algorithm continues to live in
 * exactly one place.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
function userAdaptersRoot(env) {
  return path.join(path.dirname(getUserToolchainConfigPath(env)), 'adapters');
}

/**
 * Installed-package root: `<projectRoot>/packages`, under which each package's `skills/<dir>`
 * directories are searched.
 * @param {string} projectRoot
 * @returns {string}
 */
function installedPackagesRoot(projectRoot) {
  return path.join(projectRoot, 'packages');
}

/**
 * Enumerate every adapter found across the three search locations (repo-local, user,
 * installed). Each `adapter.yaml` is parsed fresh from disk; the returned `name` is always the
 * manifest's own declared `adapter` id, never inferred from the directory name -- an
 * installed-package skills directory may be named anything, since one manifest can implement
 * several categories (TRD interpretation I7). A directory with no readable, valid
 * `adapter.yaml` (or whose manifest lacks a string `adapter` id) is silently skipped, as is any
 * non-directory entry (a stray file sitting inside a search location) and any search root that
 * is missing or not a directory.
 *
 * @param {object} [ctx]
 * @param {string} [ctx.projectRoot] defaults to `process.cwd()`
 * @param {NodeJS.ProcessEnv} [ctx.env] defaults to `process.env`
 * @returns {Array<{name: string, origin: 'repo-local'|'user'|'installed', dir: string}>}
 */
function discoverAdapters(ctx = {}) {
  const { projectRoot = process.cwd(), env = process.env } = ctx;
  const found = [];

  const repoLocalRoot = repoLocalAdaptersRoot(projectRoot);
  for (const entryName of listSubdirs(repoLocalRoot)) {
    const dir = path.join(repoLocalRoot, entryName);
    const manifest = readManifest(dir);
    if (manifest && typeof manifest.adapter === 'string') {
      found.push({ name: manifest.adapter, origin: 'repo-local', dir });
    }
  }

  const userRoot = userAdaptersRoot(env);
  for (const entryName of listSubdirs(userRoot)) {
    const dir = path.join(userRoot, entryName);
    const manifest = readManifest(dir);
    if (manifest && typeof manifest.adapter === 'string') {
      found.push({ name: manifest.adapter, origin: 'user', dir });
    }
  }

  const packagesRoot = installedPackagesRoot(projectRoot);
  for (const packageName of listSubdirs(packagesRoot)) {
    const skillsDir = path.join(packagesRoot, packageName, 'skills');
    for (const entryName of listSubdirs(skillsDir)) {
      const dir = path.join(skillsDir, entryName);
      const manifest = readManifest(dir);
      if (manifest && typeof manifest.adapter === 'string') {
        found.push({ name: manifest.adapter, origin: 'installed', dir });
      }
    }
  }

  return found;
}

/**
 * Resolve exactly one adapter by its manifest's own `adapter` id, searching repo-local, then
 * user, then installed locations in that order and returning the first match. When several
 * directories in the same location declare the same id, the match is whichever one
 * `discoverAdapters` enumerated first there (each location's listing is sorted ascending by
 * directory name, so the tie-break for same-origin duplicates is ascending sorted directory
 * name).
 *
 * Repo-local adapters are untrusted by default (TRD interpretation I5): an interactive call
 * resolves a repo-local match the same as any other origin, but a non-interactive call also
 * requires `name` to appear in the user's `trustedRepoAdapters` list (the user-level
 * `toolchain.yaml` read via `./config.js#loadToolchainConfigFile`, never the project one) or it
 * fails naming `name` and the `trustedRepoAdapters` setting. If that user-level `toolchain.yaml`
 * exists but fails its own schema validation, resolution fails with `CONFIG_INVALID` naming the
 * offending file rather than letting the raw parse/validation error propagate.
 *
 * `ctx.env`, when supplied, replaces `process.env` wholesale for both the discovery pass and
 * this trust lookup -- it is never shallow-merged with `process.env` -- so a caller testing
 * trust resolution with a deliberately partial environment never accidentally reads a real
 * `trustedRepoAdapters` entry resolved from the live process environment.
 *
 * Every manifest and `SKILL.md` is re-read fresh for this call (via `discoverAdapters` and a
 * second direct read of each), so an edit made since the previous call is always reflected. A
 * missing or unreadable `SKILL.md` is reported on the result's `skillMd` field rather than
 * thrown.
 *
 * @param {string} name the adapter id declared by the target manifest's `adapter` field
 * @param {object} [ctx]
 * @param {string} [ctx.projectRoot] defaults to `process.cwd()`
 * @param {NodeJS.ProcessEnv} [ctx.env] defaults to `process.env`; replaces `process.env`
 *   wholesale rather than merging with it
 * @param {boolean} [ctx.interactive] defaults to `false`
 * @returns {{origin: 'repo-local'|'user'|'installed', dir: string, manifest: object,
 *   skillMd: {ok: true, content: string} | {ok: false, error: string}}}
 * @throws {Error} with `.code === 'NOT_INSTALLED'` naming `name`, all three search locations,
 *   and an install hint when no location has a matching adapter; with
 *   `.code === 'UNTRUSTED_REPO_ADAPTER'` naming `name` and the `trustedRepoAdapters` setting
 *   when a repo-local match exists but the non-interactive trust requirement is not met; with
 *   `.code === 'CONFIG_INVALID'` naming the user `toolchain.yaml` path when that file exists
 *   but fails schema validation during the trust lookup.
 */
function loadAdapter(name, ctx = {}) {
  const { projectRoot = process.cwd(), env = process.env, interactive = false } = ctx;

  const candidates = discoverAdapters({ projectRoot, env }).filter((entry) => entry.name === name);
  const byOrigin = (origin) => candidates.find((entry) => entry.origin === origin);

  const repoLocalMatch = byOrigin('repo-local');
  if (repoLocalMatch) {
    if (!interactive) {
      const userConfigPath = getUserToolchainConfigPath(env);
      let userConfig;
      try {
        userConfig = loadToolchainConfigFile(userConfigPath) || {};
      } catch (cause) {
        const error = new Error(
          `${userConfigPath}: invalid user toolchain config while resolving repo-local trust for adapter ` +
            `'${name}' (${cause.message})`
        );
        error.code = 'CONFIG_INVALID';
        error.cause = cause;
        throw error;
      }
      const trustedRepoAdapters = Array.isArray(userConfig.trustedRepoAdapters) ? userConfig.trustedRepoAdapters : [];
      if (!trustedRepoAdapters.includes(name)) {
        const error = new Error(
          `adapter '${name}' is repo-local (${repoLocalMatch.dir}) and this run is non-interactive; ` +
            `add '${name}' to trustedRepoAdapters in ${userConfigPath} to allow it without an interactive confirmation`
        );
        error.code = 'UNTRUSTED_REPO_ADAPTER';
        throw error;
      }
    }
    return {
      origin: 'repo-local',
      dir: repoLocalMatch.dir,
      manifest: readManifest(repoLocalMatch.dir),
      skillMd: readSkillMd(repoLocalMatch.dir)
    };
  }

  const userMatch = byOrigin('user');
  if (userMatch) {
    return {
      origin: 'user',
      dir: userMatch.dir,
      manifest: readManifest(userMatch.dir),
      skillMd: readSkillMd(userMatch.dir)
    };
  }

  const installedMatch = byOrigin('installed');
  if (installedMatch) {
    return {
      origin: 'installed',
      dir: installedMatch.dir,
      manifest: readManifest(installedMatch.dir),
      skillMd: readSkillMd(installedMatch.dir)
    };
  }

  const repoLocalRoot = repoLocalAdaptersRoot(projectRoot);
  const userRoot = userAdaptersRoot(env);
  const packagesRoot = installedPackagesRoot(projectRoot);
  const error = new Error(
    `adapter '${name}' is not installed: ensemble looked for a '${name}' skill directory in the repo-local ` +
      `adapters directory (${path.join(repoLocalRoot, name)}), the user adapters directory ` +
      `(${path.join(userRoot, name)}), and every installed package's skills directory under ${packagesRoot} ` +
      `(packages/*/skills/<dir>/adapter.yaml declaring \`adapter: ${name}\`); install a marketplace package ` +
      `that provides '${name}' (for example, "/plugin install <package>@ensemble" in Claude Code) or place its ` +
      `skill directory in one of the locations above.`
  );
  error.code = 'NOT_INSTALLED';
  throw error;
}

module.exports = {
  discoverAdapters,
  loadAdapter
};
