'use strict';
/**
 * Taxonomy coverage check (TRD-2026-8d825f54 TRD-048).
 *
 * `checkCoverage(root)` returns `{ ok, errors, scanned }`; every error is
 * `{ class, file?, tool?, line?, category?, categories?, message }`:
 *   - `DUPLICATE_TOOL_MAPPING`: a tool in `tool-inventory.yaml` listed under two categories
 *     (`tool`, `categories`), or both under a category and in `ignoredCommands`.
 *   - `UNKNOWN_INVENTORY_CATEGORY`: an inventory key that is neither `ignoredCommands` nor a
 *     category defined in `packages/development/toolchain/categories/`.
 *   - `UNMAPPED_TOOL`: a command-position token in a shared source's fenced shell block (or a
 *     shipped adapter's declared `binaries[]`, reported against its `adapter.yaml`) that is in
 *     neither the inventory nor `ignoredCommands` (`file`, `line`, `tool`).
 *   - `MISSING_DEFAULT_ADAPTER`: a category without a default in `toolchain.default.yaml`, or
 *     whose default names no shipped adapter declaring that category (`category`). The
 *     `work-graph: auto` sentinel is valid while `toolchain/builtin` exists (it resolves to
 *     the built-in link fallback, not an adapter directory).
 *
 * Fenced-block scanning mirrors `scripts/lint-provider-refs.js` (same file discovery, so
 * `adapter-*` directories and generated trees are excluded) but only fences tagged `bash`,
 * `sh`, `shell`, `zsh`, `console` or untagged are shell blocks. Command position: the first
 * word of each line and of each `&&`/`||`/`;`/`|`/`$(` segment, after shell keywords,
 * `VAR=value` prefixes and `sudo`/`env`; only plain lowercase command names are candidates
 * (variables, paths, quoted strings, `[`/`{` and comments are not). Heredoc bodies, line
 * continuations and `case` pattern lines are skipped.
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const { discoverShippedAdapters } = require('./default-only-check');
const { findSourceFiles, readInventory } = require('../lint-provider-refs');

const CATEGORIES_REL = 'packages/development/toolchain/categories';
const DEFAULT_REL = 'packages/development/toolchain/toolchain.default.yaml';
const BUILTIN_REL = 'packages/development/toolchain/builtin';

const SHELL_LANGS = new Set(['bash', 'sh', 'shell', 'zsh', 'console']);
const FENCE_RE = /^\s*```\s*([A-Za-z0-9_+-]*)/;
const SEGMENT_SPLIT_RE = /&&|\|\||;|\||\$\(|`/;
const KEYWORDS = new Set([
  'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac',
  'in', 'function', 'time', 'local', 'declare', 'readonly', 'unset', 'eval', 'exec', 'trap',
  'shift', 'break', 'continue', 'select'
]);
const PREFIX_RE = /^(?:(?:sudo|env|time|!)\s+|[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/;
const COMMAND_NAME_RE = /^[a-z][a-z0-9._+-]*$/;
const HEREDOC_RE = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/;

/** Command-position candidates `{line, tool}` from one file's text. */
function extractCommandTokens(content) {
  const found = [];
  const lines = content.split('\n');
  let inFence = false;
  let shell = false;
  let heredocEnd = null;
  let continued = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(FENCE_RE);
    if (fence) {
      inFence = !inFence;
      shell = inFence && SHELL_LANGS.has(fence[1].toLowerCase());
      heredocEnd = null;
      continued = false;
      continue;
    }
    if (!inFence || !shell) continue;

    if (heredocEnd !== null) {
      if (line.trim() === heredocEnd) heredocEnd = null;
      continue;
    }
    const wasContinued = continued;
    continued = /\\\s*$/.test(line);
    if (wasContinued) continue;

    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const heredoc = line.match(HEREDOC_RE);
    if (heredoc) heredocEnd = heredoc[2];
    // `case` pattern arms like `foo)` and closers are not commands.
    if (/^\S+\)\s*$/.test(trimmed) || /^\(?[^\s()]*\)\s/.test(trimmed) && !trimmed.includes('(')) continue;

    for (const segment of line.split(SEGMENT_SPLIT_RE)) {
      let rest = segment.trim();
      if (/^(?:for|select|case)\s/.test(rest)) continue; // loop/case headers hold variable names, not commands
      for (let guard = 0; guard < 8 && rest; guard++) {
        const before = rest;
        rest = rest.replace(PREFIX_RE, '');
        const first = rest.match(/^(\S+)\s*(.*)$/);
        if (first && (KEYWORDS.has(first[1]) || first[1] === '{' || first[1] === '(')) rest = first[2];
        if (rest === before) break;
      }
      const m = rest.match(/^(\S+)/);
      if (m && COMMAND_NAME_RE.test(m[1]) && !KEYWORDS.has(m[1])) {
        found.push({ line: i + 1, tool: m[1] });
      }
    }
  }
  return found;
}

function listCategories(root) {
  try {
    return fs.readdirSync(path.join(root, CATEGORIES_REL))
      .filter(name => name.endsWith('.yaml'))
      .map(name => name.slice(0, -'.yaml'.length))
      .sort();
  } catch {
    return [];
  }
}

/** Default-adapter errors for every category, per the module doc. */
function checkDefaults(root, categories) {
  const errors = [];
  let defaults = null;
  try {
    defaults = yaml.load(fs.readFileSync(path.join(root, DEFAULT_REL), 'utf8'));
  } catch {
    defaults = null;
  }
  if (!defaults || typeof defaults !== 'object') defaults = {};

  const adapters = discoverShippedAdapters(path.join(root, 'packages'));
  const hasBuiltin = fs.existsSync(path.join(root, BUILTIN_REL));

  for (const category of categories) {
    const value = defaults[category];
    if (typeof value !== 'string' || !value) {
      errors.push({
        class: 'MISSING_DEFAULT_ADAPTER', category,
        message: `category '${category}' has no default adapter in toolchain.default.yaml`
      });
      continue;
    }
    if (category === 'work-graph' && value === 'auto' && hasBuiltin) continue;
    const exists = adapters.some(a => a.name === value && a.categories.includes(category));
    if (!exists) {
      errors.push({
        class: 'MISSING_DEFAULT_ADAPTER', category,
        message: `default adapter '${value}' for category '${category}' has no shipped adapter directory`
      });
    }
  }
  return errors;
}

/**
 * @param {string} root Absolute repo root (or a fixture root shaped like one)
 * @returns {{ok: boolean, errors: object[], scanned: number}}
 */
function checkCoverage(root) {
  const errors = [];
  const categories = listCategories(root);
  const inventory = readInventory(root);
  const ignored = new Set(inventory.ignored);

  // Tool -> categories, exactly one required.
  const toolCategories = new Map();
  for (const [category, tools] of Object.entries(inventory.categories)) {
    if (!categories.includes(category)) {
      errors.push({
        class: 'UNKNOWN_INVENTORY_CATEGORY', category,
        message: `tool-inventory.yaml category '${category}' is not defined under ${CATEGORIES_REL}`
      });
    }
    for (const tool of new Set(tools)) {
      if (!toolCategories.has(tool)) toolCategories.set(tool, []);
      toolCategories.get(tool).push(category);
    }
  }
  for (const [tool, cats] of toolCategories) {
    const all = ignored.has(tool) ? [...cats, 'ignoredCommands'] : cats;
    if (all.length > 1) {
      errors.push({
        class: 'DUPLICATE_TOOL_MAPPING', tool, categories: all,
        message: `tool '${tool}' is mapped to more than one category: ${all.join(', ')}`
      });
    }
  }
  const mapped = tool => toolCategories.has(tool) || ignored.has(tool);

  // Shipped adapter binaries must be mapped too.
  const seenAdapterTool = new Set();
  for (const adapter of discoverShippedAdapters(path.join(root, 'packages'))) {
    const manifestPath = path.join(adapter.dir, 'adapter.yaml');
    let manifest;
    try {
      manifest = yaml.load(fs.readFileSync(manifestPath, 'utf8'));
    } catch {
      continue;
    }
    for (const tool of (manifest && Array.isArray(manifest.binaries)) ? manifest.binaries : []) {
      if (typeof tool !== 'string' || mapped(tool) || seenAdapterTool.has(`${manifestPath}\0${tool}`)) continue;
      seenAdapterTool.add(`${manifestPath}\0${tool}`);
      errors.push({
        class: 'UNMAPPED_TOOL', file: manifestPath, tool,
        message: `adapter binary '${tool}' is in neither tool-inventory.yaml nor ignoredCommands`
      });
    }
  }

  // Fenced shell blocks in shared sources.
  const files = findSourceFiles(root);
  for (const file of files) {
    let content;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const reported = new Set();
    for (const { line, tool } of extractCommandTokens(content)) {
      if (mapped(tool) || reported.has(tool)) continue;
      reported.add(tool);
      errors.push({
        class: 'UNMAPPED_TOOL', file, line, tool,
        message: `command '${tool}' is in neither tool-inventory.yaml nor ignoredCommands`
      });
    }
  }

  errors.push(...checkDefaults(root, categories));
  return { ok: errors.length === 0, errors, scanned: files.length };
}

module.exports = { checkCoverage, extractCommandTokens };
