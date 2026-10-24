#!/usr/bin/env node
'use strict';

/**
 * toolchain-cli.js — CLI over the toolchain configuration resolver library
 * (TRD-2026-8d825f54 TRD-004, PRD REQ-012).
 *
 * Subcommands:
 *   resolve [--json]   Resolve every one of the 14 tool categories to its selected adapter
 *                      and the precedence tier (`project`|`user`|`env-compat`|`detection`|
 *                      `default`) that selected it, via `resolveCategory()` in
 *                      `./toolchain/config.js`.
 *   explain [--json]   Identical resolution to `resolve`; the distinct subcommand name exists
 *                      for callers that want the "why was this adapter chosen" framing.
 *
 * Output:
 *   - Default (no `--json`): a human-readable table with columns `category`, `adapter`,
 *     `source`, one row per category, printed to stdout.
 *   - `--json`: `{ok:true, data:{<category>:{adapter, source}, ...}}` on success, or
 *     `{ok:false, error:{code, message}}` on failure, printed to stdout.
 *   - Unknown or missing subcommand: with `--json`, `{ok:false, error:{code:'UNKNOWN_SUBCOMMAND',
 *     message}}` to stdout; without `--json`, a human error line to stderr. Either way the
 *     process exits non-zero.
 *
 * The module is both importable (`resolve`, `explain`, `main` are exported for in-process
 * callers such as other `packages/development` CLIs) and executable
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
 * Non-goals (out of scope for TRD-004, left to later tasks): no real detection engine
 * (TRD-016), no adapter manifest loading or discovery (TRD-006), no health checks (future
 * task), no `run`/`validate`/`preflight`/`confirm-status`/`confirm-record` subcommands
 * (TRD-007, TRD-011, TRD-014, TRD-017, TRD-018).
 */

const { resolveCategory } = require('./toolchain/config');

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

const HANDLERS = { resolve, explain };

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
 * Parse CLI argv into a subcommand name and the `--json` flag.
 * @param {string[]} argv
 * @returns {{subcommand: string|undefined, json: boolean}}
 */
function parseArgs(argv) {
  const list = Array.isArray(argv) ? argv : [];
  return { subcommand: list[0], json: list.includes('--json') };
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
  const { subcommand, json } = parseArgs(argv);
  const handler = subcommand && HANDLERS[subcommand];

  if (!handler) {
    const message = subcommand
      ? `Unknown subcommand '${subcommand}'. Usage: toolchain-cli <resolve|explain> [--json]`
      : 'Missing subcommand. Usage: toolchain-cli <resolve|explain> [--json]';
    if (json) {
      process.stdout.write(
        JSON.stringify({ ok: false, error: { code: 'UNKNOWN_SUBCOMMAND', message } }) + '\n'
      );
    } else {
      process.stderr.write(message + '\n');
    }
    return 1;
  }

  const result = handler(ctx);

  if (json) {
    process.stdout.write(JSON.stringify(result) + '\n');
  } else if (result.ok) {
    process.stdout.write(renderTable(result.data) + '\n');
  } else {
    process.stderr.write(`${result.error.code}: ${result.error.message}\n`);
  }

  return result.ok ? 0 : 1;
}

module.exports = { resolve, explain, main };

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
