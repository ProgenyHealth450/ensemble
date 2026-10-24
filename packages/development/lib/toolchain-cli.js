#!/usr/bin/env node
'use strict';

/**
 * toolchain-cli.js — CLI over the toolchain configuration resolver library
 * (TRD-2026-8d825f54 TRD-004/TRD-007, PRD REQ-012, REQ-008, REQ-003).
 *
 * Subcommands:
 *   resolve [--json]   Resolve every one of the 14 tool categories to its selected adapter
 *                      and the precedence tier (`project`|`user`|`env-compat`|`detection`|
 *                      `default`) that selected it, via `resolveCategory()` in
 *                      `./toolchain/config.js`.
 *   explain [--json]   Identical resolution to `resolve`; the distinct subcommand name exists
 *                      for callers that want the "why was this adapter chosen" framing.
 *   validate <adapter-dir> [--json]
 *                      Run the composed static validation gate `validateAdapterDir` (TRD-009,
 *                      PRD REQ-008/REQ-022/REQ-023) over `<adapter-dir>`: `validateManifest`,
 *                      `validateAllowlist`, `validateConformance` and `scanCredentials`, in
 *                      `./toolchain/validate.js`, returning the union of their errors. This is
 *                      the only entry point; do not re-wire a subset of the four checks here.
 *
 * Output:
 *   - Default (no `--json`): a human-readable table with columns `category`, `adapter`,
 *     `source`, one row per category, printed to stdout for `resolve`/`explain`; for
 *     `validate`, `ok` on success or one error per line (to stderr) on failure.
 *   - `--json`: `{ok:true, data:{<category>:{adapter, source}, ...}}` on success, or
 *     `{ok:false, error:{code, message}}` on failure, printed to stdout for `resolve`/`explain`;
 *     for `validate`, `{ok:true, errors:[]}` or `{ok:false, errors:[...]}` (matching
 *     `validateConformance`'s own return shape) printed to stdout either way.
 *   - Unknown or missing subcommand: with `--json`, `{ok:false, error:{code:'UNKNOWN_SUBCOMMAND',
 *     message}}` to stdout; without `--json`, a human error line to stderr. Either way the
 *     process exits non-zero.
 *
 * The module is both importable (`resolve`, `explain`, `validate`, `main` are exported for
 * in-process callers such as other `packages/development` CLIs) and executable
 * (`if (require.main === module) { process.exit(main(process.argv.slice(2))); }`), mirroring
 * `trd-cli.js`'s convention. Note the JSON envelope and error shape here
 * (`{ok, data}` / `{ok:false, error:{code, message}}`) are distinct from `trd-cli.js`'s own
 * `{error}`-only shape; do not conflate the two.
 *
 * `resolve(ctx)`/`explain(ctx)` accept the same `{projectRoot, env, detect}` context that
 * `resolveCategory()` accepts and pass it straight through for every category, unmodified.
 * `detect` is the TRD-016 detection-engine injection point: it does not exist in production yet
 * (callers simply omit it, and `resolveCategory` falls through to the shipped default), but
 * tests may inject a stub `detect` function to exercise the `source:'detection'` path end to
 * end without this module building any real detection logic.
 *
 * `main(argv, ctx)` takes an optional second `ctx` argument purely so callers (tests) can
 * exercise the full argv-parsing/JSON/table-rendering path against an injected
 * `{projectRoot, env, detect}` without relying on `process.cwd()`/`process.env`/an unavailable
 * detection engine. Real invocations never pass it, so `ctx` always defaults to
 * `{projectRoot: process.cwd(), env: process.env}`, matching this command's documented
 * behavior exactly.
 *
 * Non-goals (out of scope for this task, left to later tasks): no real detection engine
 * (TRD-016), no `run`/`preflight`/`confirm-status`/`confirm-record` subcommands (TRD-011,
 * TRD-014, TRD-017, TRD-018).
 */

const { resolveCategory } = require('./toolchain/config');
const { validateAdapterDir } = require('./toolchain/validate');

const CATEGORIES = [
  'host',
  'workflow',
  'worktree',
  'tracker',
  'work-graph',
  'ci-local',
  'review',
  'lint',
  'test-runner',
  'e2e-quality',
  'container-deploy',
  'iac',
  'platform-cloud',
  'package-runner'
];

/**
 * Resolve every one of the 14 categories' adapter and source, passing `ctx` straight through
 * to `resolveCategory()` for each one.
 *
 * @param {{projectRoot?: string, env?: NodeJS.ProcessEnv, detect?: Function}} [ctx]
 * @returns {{ok: true, data: Record<string, {adapter: string, source: string}>}
 *          | {ok: false, error: {code: string, message: string}}}
 */
function resolveAll(ctx = {}) {
  const data = {};
  try {
    for (const category of CATEGORIES) {
      const { value, source } = resolveCategory(category, ctx);
      data[category] = { adapter: value, source };
    }
    return { ok: true, data };
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    return { ok: false, error: { code: 'RESOLVE_FAILED', message } };
  }
}

/**
 * `resolve` subcommand handler.
 * @param {{projectRoot?: string, env?: NodeJS.ProcessEnv, detect?: Function}} [ctx]
 */
function resolve(ctx = {}) {
  return resolveAll(ctx);
}

/**
 * `explain` subcommand handler. Same resolution as `resolve`; this task defines no behavioral
 * difference beyond the subcommand name (both show adapter and source for every category).
 * @param {{projectRoot?: string, env?: NodeJS.ProcessEnv, detect?: Function}} [ctx]
 */
function explain(ctx = {}) {
  return resolveAll(ctx);
}

/**
 * `validate <adapter-dir>` subcommand handler: runs the composed static validation gate
 * `validateAdapterDir` (`./toolchain/validate.js`, TRD-009, PRD REQ-008/REQ-022/REQ-023,
 * AC-008-1..3, AC-022-1, AC-023-1, AC-023-3) over `<adapter-dir>` and returns its result
 * unchanged. Do not call `validateManifest`/`validateAllowlist`/`validateConformance`/
 * `scanCredentials` directly here — `validateAdapterDir` is the single production caller that
 * composes all four (TRD-009 review finding: a validator with no production caller enforces
 * nothing).
 *
 * @param {{projectRoot?: string, env?: NodeJS.ProcessEnv, detect?: Function}} [ctx] unused by
 *   `validate`; accepted so every handler shares the same `(ctx, positionals)` signature
 * @param {string[]} [positionals] `positionals[0]` is the adapter directory
 * @returns {{ok: true, errors: []} | {ok: false, errors: string[]}}
 */
function validate(ctx = {}, positionals = []) {
  const adapterDir = positionals[0];
  if (!adapterDir) {
    return { ok: false, errors: ['validate: missing required <adapter-dir> argument'] };
  }

  return validateAdapterDir(adapterDir);
}

const HANDLERS = { resolve, explain, validate };

/**
 * Render a resolved category map as a human-readable table.
 * @param {Record<string, {adapter: string, source: string}>} data
 * @returns {string}
 */
function renderTable(data) {
  const header = ['category', 'adapter', 'source'];
  const rows = CATEGORIES.filter((category) => data[category]).map((category) => [
    category,
    data[category].adapter,
    data[category].source
  ]);
  const widths = header.map((heading, i) =>
    Math.max(heading.length, ...rows.map((row) => String(row[i]).length))
  );
  const formatRow = (row) => row.map((cell, i) => String(cell).padEnd(widths[i])).join('  ');
  return [formatRow(header), ...rows.map(formatRow)].join('\n');
}

/**
 * Parse CLI argv into a subcommand name, the `--json` flag, and positional arguments.
 * @param {string[]} argv
 * @returns {{subcommand: string|undefined, json: boolean, positionals: string[]}}
 */
function parseArgs(argv) {
  const list = Array.isArray(argv) ? argv : [];
  return {
    subcommand: list[0],
    json: list.includes('--json'),
    positionals: list.slice(1).filter((arg) => arg !== '--json')
  };
}

/**
 * CLI entry point.
 *
 * @param {string[]} argv `process.argv.slice(2)`
 * @param {{projectRoot?: string, env?: NodeJS.ProcessEnv, detect?: Function}} [ctx] Defaults to
 *   `{projectRoot: process.cwd(), env: process.env}`; real invocations never override this.
 * @returns {number} process exit code
 */
function main(argv, ctx = { projectRoot: process.cwd(), env: process.env }) {
  const { subcommand, json, positionals } = parseArgs(argv);
  const handler = subcommand && HANDLERS[subcommand];

  if (!handler) {
    const message = subcommand
      ? `Unknown subcommand '${subcommand}'. Usage: toolchain-cli <resolve|explain|validate> [--json]`
      : 'Missing subcommand. Usage: toolchain-cli <resolve|explain|validate> [--json]';
    if (json) {
      process.stdout.write(
        JSON.stringify({ ok: false, error: { code: 'UNKNOWN_SUBCOMMAND', message } }) + '\n'
      );
    } else {
      process.stderr.write(message + '\n');
    }
    return 1;
  }

  const result = handler(ctx, positionals);

  if (json) {
    process.stdout.write(JSON.stringify(result) + '\n');
  } else if (subcommand === 'validate') {
    if (result.ok) {
      process.stdout.write('ok\n');
    } else {
      process.stderr.write(result.errors.join('\n') + '\n');
    }
  } else if (result.ok) {
    process.stdout.write(renderTable(result.data) + '\n');
  } else {
    process.stderr.write(`${result.error.code}: ${result.error.message}\n`);
  }

  return result.ok ? 0 : 1;
}

module.exports = { resolve, explain, validate, main };

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
