'use strict';

/**
 * Repo-signal detection engine (TRD-2026-8d825f54 TRD-016, PRD REQ-010, AC-010-1, AC-010-2).
 *
 * `detectAdapter(category, ctx)` is the function wired as `ctx.detect` for `resolveCategory()`
 * (`./config.js`) -- the "detection" precedence step that only runs when project config, user
 * config and env-compat have all declined to resolve `category` (TRD interpretation I2).
 *
 * Algorithm: discover every installed adapter (`./adapters.js#discoverAdapters`), load each
 * candidate whose manifest declares `category` in its `categories` list
 * (`./adapters.js#loadAdapter`, wrapped in try/catch so one bad or untrusted candidate --
 * `NOT_INSTALLED` racing a concurrent uninstall, `UNTRUSTED_REPO_ADAPTER`, `CONFIG_INVALID` --
 * is silently excluded from detection rather than aborting the whole sweep; an untrusted
 * repo-local adapter is therefore never auto-selected by detection, matching `loadAdapter`'s
 * own I5 non-interactive trust requirement), and evaluate each candidate's `manifest.detect`
 * array against the repo at `ctx.projectRoot`. A candidate "matches" when ANY ONE of its
 * declared signals matches -- OR across signals, e.g. git-town's only signal is
 * `git_config_set git-town.main-branch`; github's is only `remote_url_matches`; an adapter
 * declaring `detect: []` (e.g. Jira, which has no repo signal at all) never matches on its own.
 *
 * Detect-signal field names (not formally named anywhere else in this codebase as of this
 * task -- no adapter populates `detect:` for real yet; chosen here to match the TRD-036 prose
 * shorthand "remote_url_matches github.com" / "git_config_set git-town.main-branch" so that
 * later real-adapter PR does not need to rename anything):
 *   - `remote_url_matches`: `{signal: 'remote_url_matches', pattern: <string>}` -- `pattern` is
 *     compiled as `new RegExp(pattern)` and tested against the repo's `origin` remote URL.
 *   - `file_exists` / `dir_exists`: `{signal: ..., path: <string>}` -- `path` is resolved
 *     relative to `ctx.projectRoot` and rejected if it would resolve outside of it.
 *   - `git_config_set`: `{signal: 'git_config_set', key: <string>}` -- a dotted git config key
 *     (e.g. `git-town.main-branch`); true iff that key is present anywhere in the resolved
 *     repo's config (any value, including empty string, counts as "set"; an absent key does
 *     not).
 *
 * I2 result shape:
 *   - zero candidates match AND no positively-identified signal source exists (no `.git`
 *     directory at all, or a `.git` directory with no `origin` remote configured) -> returns
 *     `null`, so `resolveCategory` falls through to the shipped default (`source:'default'`,
 *     no error).
 *   - exactly one candidate matches -> `{value: <adapter name>, source: 'detection'}`.
 *   - two or more candidates match, OR a positively-identified signal source exists (an
 *     `origin` remote URL is present and at least one candidate declaring `category` also
 *     declares a `remote_url_matches` signal) but matches none of them -> throws an `Error`
 *     with `.code === 'AMBIGUOUS_PROVIDER'` naming `category`, every matched adapter name (for
 *     the two-or-more case), and `.ensemble/toolchain.yaml` as the file to set the category in
 *     explicitly.
 *
 * fs-only git inspection: this module never spawns a process, matching `./adapters.js`'s own
 * fs-only style. It resolves the repo's real git directory itself, including the worktree
 * gitlink case (`<projectRoot>/.git` is a *file* containing `gitdir: <path>`, and that
 * worktree-specific gitdir's own `commondir` file -- when present -- points back to the main
 * repository's git directory, which is where `config` actually lives; this very repository is
 * checked out as a worktree, so this path is exercised in production, not only in tests), then
 * parses `config` with a small purpose-built INI reader (sections `[section]` / `[section
 * "subsection"]`, `key = value` lines) sufficient to answer `remote.origin.url` and arbitrary
 * `git_config_set` lookups.
 *
 * ## Known limits
 *
 * - No interactive adapter-selection UI exists anywhere in this codebase yet (out of scope for
 *   this task, and not built by any other task either); `detectAdapter` always throws
 *   `AMBIGUOUS_PROVIDER` on ambiguity regardless of `ctx.interactive` -- a deliberate
 *   fail-closed choice, not an interactive prompt deferred to later.
 * - The fs-only git config reader does not follow `[include]`/`[includeIf]` directives (real
 *   `git config --get` does); a key or remote URL set only via an included file is invisible to
 *   this module. None of this task's ACs require include-file support; a later task can add an
 *   `execFile`-based fallback (`./runner.js#buildChildEnv`) if a real adapter ever needs it.
 * - `remote_url_matches` only inspects the `origin` remote; other remote names are not
 *   consulted (no documented signal needs them yet).
 */

const fs = require('fs');
const path = require('path');

const { discoverAdapters, loadAdapter } = require('./adapters');

/**
 * Resolve `<projectRoot>/.git` to the real git directory that holds `config`, handling the
 * plain-directory case and the worktree gitlink case (a `.git` *file* containing
 * `gitdir: <path>`, whose own `commondir` file -- when present -- points back to the main
 * repository's git directory). Returns `null` for any missing/unreadable/malformed layout
 * (never throws).
 *
 * @param {string} projectRoot
 * @returns {string|null}
 */
function resolveGitDir(projectRoot) {
  const gitPath = path.join(projectRoot, '.git');
  let stat;
  try {
    stat = fs.lstatSync(gitPath);
  } catch {
    return null;
  }

  let candidate = gitPath;
  if (stat.isFile()) {
    let content;
    try {
      content = fs.readFileSync(gitPath, 'utf8');
    } catch {
      return null;
    }
    const match = /^gitdir:\s*(.+)$/m.exec(content);
    if (!match) {
      return null;
    }
    const gitdirValue = match[1].trim();
    candidate = path.isAbsolute(gitdirValue) ? gitdirValue : path.resolve(projectRoot, gitdirValue);

    try {
      const commondirContent = fs.readFileSync(path.join(candidate, 'commondir'), 'utf8').trim();
      if (commondirContent) {
        candidate = path.isAbsolute(commondirContent)
          ? commondirContent
          : path.resolve(candidate, commondirContent);
      }
    } catch {
      // No commondir file: not a worktree checkout, or an unusual layout. Use candidate as-is.
    }
  } else if (!stat.isDirectory()) {
    return null;
  }

  try {
    if (!fs.statSync(candidate).isDirectory()) {
      return null;
    }
  } catch {
    return null;
  }
  return candidate;
}

/**
 * Parse a git `config` file's text into a `Map` from a lowercased, dotted
 * `section[.subsection].key` to the array of values assigned to it (in file order; the git
 * convention is that the last assignment wins for a scalar read). A key with no `=` (a bare
 * boolean-style line) is recorded with value `''`, which still counts as "set".
 *
 * @param {string} content
 * @returns {Map<string, string[]>}
 */
function parseGitConfig(content) {
  const map = new Map();
  let section = null;
  let subsection = null;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) {
      continue;
    }

    const sectionMatch = /^\[([^\]\s"]+)(?:\s+"([^"]*)")?\]$/.exec(line);
    if (sectionMatch) {
      section = sectionMatch[1].toLowerCase();
      subsection = sectionMatch[2] !== undefined ? sectionMatch[2] : null;
      continue;
    }

    if (!section) {
      continue;
    }

    const eqIndex = line.indexOf('=');
    const key = (eqIndex === -1 ? line : line.slice(0, eqIndex)).trim().toLowerCase();
    if (!key) {
      continue;
    }
    const value = eqIndex === -1 ? '' : line.slice(eqIndex + 1).trim();
    const mapKey = subsection !== null ? `${section}.${subsection}.${key}` : `${section}.${key}`;
    if (!map.has(mapKey)) {
      map.set(mapKey, []);
    }
    map.get(mapKey).push(value);
  }

  return map;
}

/**
 * Read and parse `<projectRoot>`'s resolved git `config` file. Returns `null` for any
 * missing/unreadable repo rather than throwing.
 *
 * @param {string} projectRoot
 * @returns {Map<string, string[]>|null}
 */
function loadGitConfigMap(projectRoot) {
  const gitDir = resolveGitDir(projectRoot);
  if (!gitDir) {
    return null;
  }
  let content;
  try {
    content = fs.readFileSync(path.join(gitDir, 'config'), 'utf8');
  } catch {
    return null;
  }
  return parseGitConfig(content);
}

/**
 * The repo's `origin` remote URL, or `null` when unset/unparseable.
 * @param {Map<string, string[]>|null} gitConfigMap
 * @returns {string|null}
 */
function resolveOriginRemoteUrl(gitConfigMap) {
  if (!gitConfigMap) {
    return null;
  }
  const values = gitConfigMap.get('remote.origin.url');
  return values && values.length > 0 ? values[values.length - 1] : null;
}

/**
 * Whether a dotted git config key (e.g. `git-town.main-branch`, `remote.origin.url`) is set
 * anywhere in `gitConfigMap`. The first dot-separated part is the section, the last is the key,
 * and anything in between (if present) is the subsection -- mirroring how git itself derives a
 * dotted config key from `[section "subsection"]` / `key = ...`.
 *
 * @param {Map<string, string[]>|null} gitConfigMap
 * @param {unknown} dottedKey
 * @returns {boolean}
 */
function gitConfigKeyIsSet(gitConfigMap, dottedKey) {
  if (!gitConfigMap || typeof dottedKey !== 'string' || !dottedKey.includes('.')) {
    return false;
  }
  const parts = dottedKey.split('.');
  const section = parts[0].toLowerCase();
  const key = parts[parts.length - 1].toLowerCase();
  const subsectionParts = parts.slice(1, -1);
  const mapKey = subsectionParts.length > 0 ? `${section}.${subsectionParts.join('.')}.${key}` : `${section}.${key}`;
  return gitConfigMap.has(mapKey);
}

/**
 * Resolve `relativePath` against `projectRoot`, returning `null` (never throwing) when it is
 * not a non-empty string or would resolve outside of `projectRoot`.
 *
 * @param {string} projectRoot
 * @param {unknown} relativePath
 * @returns {string|null}
 */
function resolvePathWithinRoot(projectRoot, relativePath) {
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    return null;
  }
  const resolvedRoot = path.resolve(projectRoot);
  const resolved = path.resolve(resolvedRoot, relativePath);
  const rootWithSep = resolvedRoot.endsWith(path.sep) ? resolvedRoot : resolvedRoot + path.sep;
  if (resolved !== resolvedRoot && !resolved.startsWith(rootWithSep)) {
    return null;
  }
  return resolved;
}

/**
 * Evaluate one `manifest.detect[]` entry against the repo at `projectRoot`. Never throws: any
 * unreadable/malformed input is treated as "no match" for that signal.
 *
 * @param {{signal?: string, pattern?: string, path?: string, key?: string}} signal
 * @param {string} projectRoot
 * @param {Map<string, string[]>|null} gitConfigMap
 * @returns {boolean}
 */
function signalMatches(signal, projectRoot, gitConfigMap) {
  if (!signal || typeof signal.signal !== 'string') {
    return false;
  }

  switch (signal.signal) {
    case 'file_exists': {
      const resolved = resolvePathWithinRoot(projectRoot, signal.path);
      if (!resolved) {
        return false;
      }
      try {
        return fs.statSync(resolved).isFile();
      } catch {
        return false;
      }
    }
    case 'dir_exists': {
      const resolved = resolvePathWithinRoot(projectRoot, signal.path);
      if (!resolved) {
        return false;
      }
      try {
        return fs.statSync(resolved).isDirectory();
      } catch {
        return false;
      }
    }
    case 'remote_url_matches': {
      if (typeof signal.pattern !== 'string') {
        return false;
      }
      const url = resolveOriginRemoteUrl(gitConfigMap);
      if (!url) {
        return false;
      }
      try {
        return new RegExp(signal.pattern).test(url);
      } catch {
        return false;
      }
    }
    case 'git_config_set':
      return gitConfigKeyIsSet(gitConfigMap, signal.key);
    default:
      return false;
  }
}

/**
 * Detect the adapter for `category` from repo signals (see module doc for the full algorithm
 * and I2 result shape). Usable directly as `ctx.detect` for `resolveCategory()`.
 *
 * @param {string} category
 * @param {{projectRoot?: string, env?: NodeJS.ProcessEnv, interactive?: boolean}} [ctx]
 * @returns {{value: string, source: 'detection'}|null}
 * @throws {Error} with `.code === 'AMBIGUOUS_PROVIDER'` per the module doc's I2 ambiguous case
 */
function detectAdapter(category, ctx = {}) {
  const { projectRoot = process.cwd() } = ctx;

  const gitConfigMap = loadGitConfigMap(projectRoot);
  const originUrl = resolveOriginRemoteUrl(gitConfigMap);

  const candidateNames = new Set(discoverAdapters(ctx).map((entry) => entry.name));

  const matched = [];
  let candidateDeclaresRemoteSignal = false;

  for (const name of candidateNames) {
    let loaded;
    try {
      loaded = loadAdapter(name, ctx);
    } catch {
      // Not installed anymore (discovery/load race), untrusted repo-local adapter, or an
      // invalid user toolchain.yaml encountered during the trust lookup: exclude this
      // candidate from detection rather than aborting the whole sweep.
      continue;
    }

    const manifest = loaded.manifest;
    if (!manifest || !Array.isArray(manifest.categories) || !manifest.categories.includes(category)) {
      continue;
    }

    const detectSignals = Array.isArray(manifest.detect) ? manifest.detect : [];
    if (detectSignals.some((signal) => signal && signal.signal === 'remote_url_matches')) {
      candidateDeclaresRemoteSignal = true;
    }

    if (detectSignals.some((signal) => signalMatches(signal, projectRoot, gitConfigMap))) {
      matched.push(name);
    }
  }

  if (matched.length === 1) {
    return { value: matched[0], source: 'detection' };
  }

  if (matched.length >= 2) {
    const error = new Error(
      `detection for category '${category}' matched more than one installed adapter ` +
        `(${matched.join(', ')}); set '${category}' explicitly in .ensemble/toolchain.yaml`
    );
    error.code = 'AMBIGUOUS_PROVIDER';
    throw error;
  }

  if (originUrl && candidateDeclaresRemoteSignal) {
    const error = new Error(
      `detection for category '${category}' found a remote 'origin' URL ('${originUrl}') that ` +
        `matches no installed adapter's signal; set '${category}' explicitly in ` +
        `.ensemble/toolchain.yaml`
    );
    error.code = 'AMBIGUOUS_PROVIDER';
    throw error;
  }

  return null;
}

module.exports = { detectAdapter };
