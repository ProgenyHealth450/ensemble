'use strict';

/**
 * Permanent regression guard for the TRD-020 (commit 4144a53) test-isolation defect: several
 * "live smoke run" tests for scripts/generate-codex/index.js and
 * packages/opencode/tests/generator-cli.test.js created throwaway fixture packages directly
 * under the real, tracked `packages/` tree and wrote/deleted real generated output under
 * `packages/codex/.codex/` -- one offender's `afterAll` deleted the entire real, tracked
 * `packages/codex/.codex/skills/vendor/` directory (35 tracked files) whenever its test file
 * ran. Every generator function that used to hard-code its source/output location now accepts
 * an explicit override (see scripts/generate-codex/index.js's `packagesDir`/`outputDir`
 * params and scripts/generate-opencode/index.js's `--packages-dir` CLI flag), and every test
 * that exercises them now builds an isolated `os.tmpdir()`-rooted copy instead
 * (scripts/tests/fixtures/codex-generate/temp-codex-root.js).
 *
 * This file is a STATIC lint, not a behavioral test: it scans every direct child of
 * `scripts/tests/` and each `packages/<pkg>/tests/` for `rmSync(`/`mkdirSync(`/`writeFileSync(` calls
 * whose target path is built from the repo root's real `packages/` directory (a `ROOT`/
 * `__dirname`-derived path that also contains the literal `'packages'` segment, with no
 * `tmpdir()`/`mkdtempSync`/`tmpDir`-style redirection in the same declaration) -- the exact
 * shape of the defect fixed above. A match fails the test unless the file+variable pair is
 * named in ALLOWLIST below, which documents a legitimate pre-existing exception; there are
 * none as of this fix (the two offending files were corrected, not allowlisted).
 *
 * Known limitation (documented, not a bug): this is a single-line, regex-based heuristic, not
 * an AST-based data-flow analysis. It recognizes the repo's existing declaration style (`const
 * NAME = path.join(ROOT, 'packages', ...)` / `path.resolve(__dirname, ..., 'packages', ...)`,
 * one statement per line) and a one-hop-or-more taint propagation through further `path.join`
 * reassignments of an already-tainted name. A declaration deliberately split across multiple
 * lines would evade it; none of the files scanned here do that today.
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCAN_DIRS = [path.join(REPO_ROOT, 'scripts', 'tests'), ...listTestsDirs()];

/** Every packages/<pkg>/tests/ directory that actually exists. */
function listTestsDirs() {
  const packagesDir = path.join(REPO_ROOT, 'packages');
  if (!fs.existsSync(packagesDir)) return [];
  return fs
    .readdirSync(packagesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(packagesDir, e.name, 'tests'))
    .filter((dir) => fs.existsSync(dir));
}

/** Direct `.js` children of `dir` (non-recursive, matching the `*.js` glob this guard covers). */
function listJsFiles(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.js'))
    .map((e) => path.join(dir, e.name));
}

const MUTATION_RE = /\b(rmSync|mkdirSync|writeFileSync)\s*\(/;
const REPO_ROOT_HINT_RE = /\bROOT\b|__dirname/;
const PACKAGES_LITERAL_RE = /['"]packages['"]/;
const TMP_ESCAPE_HINT_RE = /tmpdir\(\)|mkdtempSync|tmpDir\b|tmp_dir\b|TEMP_DIR|TMPDIR/i;
const DECL_RE = /^\s*(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(.+?);?\s*$/;

/**
 * Per-line mask of whether any character on that line sits inside a (possibly multi-line)
 * backtick template literal, so declarations/mutation calls embedded as TEXT inside a
 * generated-script string (a real, legitimate pattern in this codebase -- see
 * scripts/tests/lint-model-ids.test.js, which builds a throwaway lint script as a template
 * literal containing its own `const ROOT = ...`/`packages`-shaped lines that are safely bound
 * to a tmp dir at runtime via interpolation) are never mistaken for real taint sources. A
 * simple toggle-on-unescaped-backtick scan; it does not model nested `${...}` template
 * expressions that themselves contain backticks, which none of the files scanned here use.
 */
function computeTemplateLiteralLineMask(content) {
  const lineCount = content.split('\n').length;
  const mask = new Array(lineCount).fill(false);
  let inTemplate = false;
  let lineIdx = 0;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === '\n') {
      lineIdx += 1;
      continue;
    }
    if (ch === '`') {
      inTemplate = !inTemplate;
      continue;
    }
    if (inTemplate) mask[lineIdx] = true;
  }
  return mask;
}

/**
 * Scan one file's source text for rmSync/mkdirSync/writeFileSync calls targeting a path that
 * resolves to the real, tracked `packages/` tree. Pure function of (label, content) -- no
 * filesystem access -- so the mutation-proof test below can exercise it against an in-memory
 * snippet without ever touching a real file.
 *
 * @param {string} label identifies the source in reported violations (a real path, or a
 *   synthetic label for the mutation-proof test)
 * @param {string} content the file's source text
 * @returns {Array<{file: string, line: number, fn: string, variable: string|null, text: string}>}
 */
function findRepoRootPackagesMutations(label, content) {
  const lines = content.split('\n');
  const templateMask = computeTemplateLiteralLineMask(content);

  // Pass 1: seed taint on every single-line `const/let NAME = ...` declaration (outside a
  // template literal) whose RHS builds a path from the repo root (ROOT/__dirname) through the
  // literal 'packages' segment, with no tmp-dir redirection in that same declaration.
  const declarations = [];
  lines.forEach((line, idx) => {
    if (templateMask[idx]) return;
    const m = line.match(DECL_RE);
    if (m) declarations.push({ name: m[1], rhs: m[2] });
  });

  const taint = new Set();
  for (const { name, rhs } of declarations) {
    if (PACKAGES_LITERAL_RE.test(rhs) && REPO_ROOT_HINT_RE.test(rhs) && !TMP_ESCAPE_HINT_RE.test(rhs)) {
      taint.add(name);
    }
  }

  // Pass 2: propagate taint through further single-line declarations built from an
  // already-tainted name (e.g. `const ADAPTER_DIR = path.join(PACKAGES_DIR, 'skills', ...)`).
  // The substring match is required to land OUTSIDE quotes, so a tainted name that happens to
  // share its spelling with an unrelated quoted literal elsewhere (e.g. a variable literally
  // named `packages`) cannot taint-by-coincidence a declaration that merely contains the
  // string `'packages'`.
  let changed = true;
  let iterations = 0;
  while (changed && iterations < 10) {
    changed = false;
    iterations += 1;
    for (const { name, rhs } of declarations) {
      if (taint.has(name)) continue;
      for (const t of taint) {
        const re = new RegExp(`(^|[^'"\`\\w])${t}([^'"\`\\w]|$)`);
        if (re.test(rhs)) {
          taint.add(name);
          changed = true;
          break;
        }
      }
    }
  }

  const violations = [];
  lines.forEach((line, idx) => {
    if (templateMask[idx]) return;
    const mutationMatch = line.match(MUTATION_RE);
    if (!mutationMatch) return;

    // Direct inline construction (no intermediate named variable).
    if (PACKAGES_LITERAL_RE.test(line) && REPO_ROOT_HINT_RE.test(line) && !TMP_ESCAPE_HINT_RE.test(line)) {
      violations.push({ file: label, line: idx + 1, fn: mutationMatch[1], variable: null, text: line.trim() });
      return;
    }

    // Via a tainted named variable.
    for (const t of taint) {
      if (new RegExp(`\\b${t}\\b`).test(line)) {
        violations.push({ file: label, line: idx + 1, fn: mutationMatch[1], variable: t, text: line.trim() });
        break;
      }
    }
  });

  return violations;
}

/**
 * Pre-existing, documented exceptions: `{ "relative/path/to/file.js": ["TAINTED_VAR", ...] }`.
 * Empty as of this fix -- the two files that matched this pattern
 * (scripts/tests/generate-codex.test.js, packages/opencode/tests/generator-cli.test.js) were
 * corrected to use isolated temp roots instead of being allowlisted. A future legitimate
 * exception must be named here with a comment explaining why it cannot be converted.
 */
const ALLOWLIST = {};

describe('generated-output-integrity: no test mutates the real packages/ tree', () => {
  test('every scripts/tests/*.js and packages/*/tests/*.js file is free of rmSync/mkdirSync/writeFileSync calls targeting the real packages/ tree', () => {
    const selfPath = __filename;
    const allViolations = [];

    for (const dir of SCAN_DIRS) {
      for (const filePath of listJsFiles(dir)) {
        if (filePath === selfPath) continue;
        const relPath = path.relative(REPO_ROOT, filePath);
        const content = fs.readFileSync(filePath, 'utf-8');
        const violations = findRepoRootPackagesMutations(relPath, content);
        const allowedVars = new Set(ALLOWLIST[relPath] || []);
        for (const v of violations) {
          if (v.variable && allowedVars.has(v.variable)) continue;
          allViolations.push(v);
        }
      }
    }

    if (allViolations.length > 0) {
      const report = allViolations
        .map((v) => `  ${v.file}:${v.line} [${v.fn}] ${v.variable ? `(via ${v.variable}) ` : ''}${v.text}`)
        .join('\n');
      throw new Error(
        `Found ${allViolations.length} fs mutation(s) targeting the real packages/ tree in test files ` +
          `(TRD-020 test-isolation regression guard). Use an os.tmpdir()-rooted copy instead, or add a ` +
          `named, justified exception to ALLOWLIST in ${path.relative(REPO_ROOT, selfPath)}:\n${report}`
      );
    }
  });

  test('mutation proof: a reintroduced repo-root packages/ mutation is detected', () => {
    // Exercises the scanner against an in-memory snippet only -- never writes to or reads a
    // real file -- shaped exactly like the reverted defect: a named var built from ROOT +
    // 'packages' (no tmp redirection), then rmSync'd.
    const offendingSnippet = [
      "const ROOT = path.resolve(__dirname, '..', '..');",
      "const FIXTURE_PACKAGE_DIR = path.join(ROOT, 'packages', '__mutation_proof_fixture__');",
      'function cleanupFixtures() {',
      '  fs.rmSync(FIXTURE_PACKAGE_DIR, { recursive: true, force: true });',
      '}',
    ].join('\n');

    const violations = findRepoRootPackagesMutations('<mutation-proof-snippet>', offendingSnippet);
    expect(violations.length).toBeGreaterThanOrEqual(1);
    expect(violations.some((v) => v.fn === 'rmSync' && v.variable === 'FIXTURE_PACKAGE_DIR')).toBe(true);

    // Control: the same shape redirected through a tmp dir must NOT be flagged (proves the
    // scanner discriminates instead of flagging every rmSync unconditionally).
    const safeSnippet = [
      "const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-'));",
      "const FIXTURE_PACKAGE_DIR = path.join(tmpDir, 'packages', '__mutation_proof_fixture__');",
      'function cleanupFixtures() {',
      '  fs.rmSync(FIXTURE_PACKAGE_DIR, { recursive: true, force: true });',
      '}',
    ].join('\n');
    expect(findRepoRootPackagesMutations('<safe-snippet>', safeSnippet)).toHaveLength(0);
  });
});

module.exports = { findRepoRootPackagesMutations };
