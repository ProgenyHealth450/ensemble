#!/usr/bin/env node
'use strict';

/**
 * toolchain-cli.js — CLI over the toolchain configuration resolver library
 * (TRD-2026-8d825f54 TRD-004/TRD-007/TRD-014, PRD REQ-012, REQ-008, REQ-003, REQ-013).
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
 *   run <capability> [--run-id <id>] [--arg k=v ...] [--json]
 *                      Invoke one capability (for example `tracker.close`) through
 *                      `runCapability()` in `./toolchain/runner.js` (TRD-011), against the
 *                      adapter `resolveCategory()`/`loadAdapter()` select for the capability's
 *                      category (`capability.split('.')[0]`). When the capability's category
 *                      contract (`./toolchain/contracts.js#loadContracts()`) marks it
 *                      `sideEffect:true`, a passing preflight record for `--run-id` is required
 *                      first (`./toolchain/preflight.js#hasPassingPreflightRecord`, TRD-014,
 *                      PRD REQ-013): missing or failed preflight returns `PREFLIGHT_REQUIRED`
 *                      and never resolves an adapter or spawns anything. `--arg k=v` may repeat
 *                      to supply the capability's argument values.
 *
 * Output:
 *   - Default (no `--json`): a human-readable table with columns `category`, `adapter`,
 *     `source`, one row per category, printed to stdout for `resolve`/`explain`; for
 *     `validate`, `ok` on success or one error per line (to stderr) on failure; for `run`, the
 *     capability's raw output on success (to stdout) or `<code>: <message>` on failure (to
 *     stderr).
 *   - `--json`: `{ok:true, data:{<category>:{adapter, source}, ...}}` on success, or
 *     `{ok:false, error:{code, message}}` on failure, printed to stdout for `resolve`/`explain`;
 *     for `validate`, `{ok:true, errors:[]}` or `{ok:false, errors:[...]}` (matching
 *     `validateConformance`'s own return shape) printed to stdout either way; for `run`, the
 *     runner envelope (`{ok:true, capability, adapter, source, data}` or
 *     `{ok:false, error:{code, message}}`) printed to stdout either way.
 *   - Unknown or missing subcommand: with `--json`, `{ok:false, error:{code:'UNKNOWN_SUBCOMMAND',
 *     message}}` to stdout; without `--json`, a human error line to stderr. Either way the
 *     process exits non-zero.
 *
 * The module is both importable (`resolve`, `explain`, `validate`, `run`, `main` are exported
 * for in-process callers such as other `packages/development` CLIs) and executable
 * (`if (require.main === module) { ... }`), mirroring `trd-cli.js`'s convention. Note the JSON
 * envelope and error shape here (`{ok, data}` / `{ok:false, error:{code, message}}`) are
 * distinct from `trd-cli.js`'s own `{error}`-only shape; do not conflate the two.
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
 * behavior exactly. `main()` returns a plain `number` exit code for every subcommand except
 * `run`, which is inherently asynchronous (it may call `runCapability`, which spawns a child
 * process): for `run` it returns a `Promise<number>` instead. This is the one place the return
 * type varies; the `if (require.main === module)` guard below handles both uniformly via
 * `Promise.resolve(...)`, and every synchronous subcommand's direct callers (including the
 * existing test suite) keep receiving a plain number exactly as before.
 *
 * Non-goals (out of scope for this task, left to later tasks): no real detection engine
 * (TRD-016), no `preflight`/`confirm-status`/`confirm-record` subcommands (TRD-011, TRD-017,
 * TRD-018).
 */

const { resolveCategory } = require('./toolchain/config');
const { loadAdapter } = require('./toolchain/adapters');
const { runCapability } = require('./toolchain/runner');
const { loadContracts } = require('./toolchain/contracts');
const { hasPassingPreflightRecord } = require('./toolchain/preflight');
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

/**
 * `run <capability> [--run-id <id>] [--arg k=v ...]` subcommand handler (TRD-014, PRD REQ-013,
 * AC-013-1/2/3). Looks up whether `capability` is declared `sideEffect:true` by its category
 * contract (`loadContracts()`, `./toolchain/contracts.js`; the category is derived as
 * `capability.split('.')[0]`, mirroring the same ~5-line lookup technique used elsewhere in
 * this wave — this is a deliberate, small duplication, not a shared helper, since the two
 * callers must not depend on each other's new files this wave).
 *
 * When the capability is side-effecting and `hasPassingPreflightRecord(runId, ctx)`
 * (`./toolchain/preflight.js`, TRD-014) is `false` — including when `--run-id` was omitted
 * entirely — this returns `{ok:false, error:{code:'PREFLIGHT_REQUIRED', message}}` WITHOUT
 * calling `resolveCategory`, `loadAdapter` or `runCapability`: nothing is resolved or spawned.
 *
 * Otherwise (the capability is not side-effecting, or a passing preflight record exists for
 * `runId`), resolves the capability's adapter via `resolveCategory`/`loadAdapter` and invokes
 * it via `runCapability` (TRD-011), returning its envelope unchanged.
 *
 * @param {{projectRoot?: string, env?: NodeJS.ProcessEnv}} [ctx]
 * @param {string[]} [positionals] `positionals[0]` is the capability id, e.g. `tracker.close`
 * @param {{runId?: string, args?: Record<string, string>}} [parsed] the `--run-id`/`--arg`
 *   values `parseArgs` extracted from argv
 * @returns {Promise<{ok:true, capability:string, adapter:string, source:unknown, data:string} |
 *   {ok:false, error:{code:string, message:string}}>}
 */
async function run(ctx = {}, positionals = [], parsed = {}) {
  const capability = positionals[0];
  if (!capability) {
    return {
      ok: false,
      error: { code: 'INVALID_ARG', message: 'run: missing required <capability> argument' }
    };
  }

  const { runId, args = {} } = parsed;
  const category = capability.split('.')[0];

  const contracts = loadContracts();
  const contractFile = contracts[`${category}.yaml`];
  const capabilityDef =
    contractFile && contractFile.capabilities && contractFile.capabilities[capability];
  const sideEffect = Boolean(capabilityDef && capabilityDef.sideEffect);

  if (sideEffect && !hasPassingPreflightRecord(runId, ctx)) {
    return {
      ok: false,
      error: {
        code: 'PREFLIGHT_REQUIRED',
        message:
          `capability '${capability}' is side-effecting and requires a passing preflight ` +
          `record for run id '${runId === undefined ? '(none)' : runId}'; run preflight first`
      }
    };
  }

  let adapterId;
  try {
    adapterId = resolveCategory(category, ctx).value;
  } catch (error) {
    return { ok: false, error: { code: 'RESOLVE_FAILED', message: error.message } };
  }

  let loaded;
  try {
    loaded = loadAdapter(adapterId, ctx);
  } catch (error) {
    return { ok: false, error: { code: error.code || 'NOT_INSTALLED', message: error.message } };
  }

  return runCapability(loaded.manifest, capability, args, {});
}

const HANDLERS = { resolve, explain, validate, run };

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
 * Parse CLI argv into a subcommand name, the `--json` flag, positional arguments, and `run`'s
 * own `--run-id <id>` / repeated `--arg k=v` flags. `--run-id`'s value and every `--arg` pair
 * are consumed (never left in `positionals`) so `validate <adapter-dir>` and `resolve`/
 * `explain` (which ignore `positionals` entirely) are unaffected when those flags are absent,
 * which is always true for every subcommand except `run`.
 *
 * @param {string[]} argv
 * @returns {{subcommand: string|undefined, json: boolean, positionals: string[],
 *   runId: string|undefined, args: Record<string, string>}}
 */
function parseArgs(argv) {
  const list = Array.isArray(argv) ? argv : [];
  const subcommand = list[0];
  const rest = list.slice(1);

  // `--json` is detected across the whole argv (matching the original implementation's
  // `list.includes('--json')`), not just `rest`: when no subcommand is supplied at all,
  // `--json` itself lands in `subcommand` (list[0]), and the "missing subcommand" error path
  // below still needs `json:true` in that case.
  const json = list.includes('--json');
  let runId;
  const args = {};
  const positionals = [];

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token === '--json') {
      continue;
    } else if (token === '--run-id') {
      i += 1;
      runId = rest[i];
    } else if (token === '--arg') {
      i += 1;
      const pair = rest[i];
      if (typeof pair === 'string') {
        const eqIndex = pair.indexOf('=');
        if (eqIndex > 0) {
          args[pair.slice(0, eqIndex)] = pair.slice(eqIndex + 1);
        }
      }
    } else {
      positionals.push(token);
    }
  }

  return { subcommand, json, positionals, runId, args };
}

/**
 * Print `result` in the format `subcommand`/`json` select, matching this file's own "Output"
 * doc above exactly. Shared by every subcommand's branch in `main()` so there is exactly one
 * envelope-printing path, not one per subcommand.
 *
 * @param {string|undefined} subcommand
 * @param {boolean} json
 * @param {{ok: boolean, [key: string]: unknown}} result
 */
function printResult(subcommand, json, result) {
  if (json) {
    process.stdout.write(JSON.stringify(result) + '\n');
    return;
  }

  if (subcommand === 'validate') {
    if (result.ok) {
      process.stdout.write('ok\n');
    } else {
      process.stderr.write(result.errors.join('\n') + '\n');
    }
    return;
  }

  if (subcommand === 'run') {
    if (result.ok) {
      process.stdout.write(String(result.data) + '\n');
    } else {
      process.stderr.write(`${result.error.code}: ${result.error.message}\n`);
    }
    return;
  }

  if (result.ok) {
    process.stdout.write(renderTable(result.data) + '\n');
  } else {
    process.stderr.write(`${result.error.code}: ${result.error.message}\n`);
  }
}

/**
 * CLI entry point.
 *
 * @param {string[]} argv `process.argv.slice(2)`
 * @param {{projectRoot?: string, env?: NodeJS.ProcessEnv, detect?: Function}} [ctx] Defaults to
 *   `{projectRoot: process.cwd(), env: process.env}`; real invocations never override this.
 * @returns {number|Promise<number>} process exit code; a `Promise<number>` only for the `run`
 *   subcommand (see this file's header doc).
 */
function main(argv, ctx = { projectRoot: process.cwd(), env: process.env }) {
  const parsed = parseArgs(argv);
  const { subcommand, json, positionals } = parsed;
  const handler = subcommand && HANDLERS[subcommand];

  if (!handler) {
    const message = subcommand
      ? `Unknown subcommand '${subcommand}'. Usage: toolchain-cli <resolve|explain|validate|run> [--json]`
      : 'Missing subcommand. Usage: toolchain-cli <resolve|explain|validate|run> [--json]';
    if (json) {
      process.stdout.write(
        JSON.stringify({ ok: false, error: { code: 'UNKNOWN_SUBCOMMAND', message } }) + '\n'
      );
    } else {
      process.stderr.write(message + '\n');
    }
    return 1;
  }

  if (subcommand === 'run') {
    return handler(ctx, positionals, parsed).then((result) => {
      printResult(subcommand, json, result);
      return result.ok ? 0 : 1;
    });
  }

  const result = handler(ctx, positionals);
  printResult(subcommand, json, result);
  return result.ok ? 0 : 1;
}

module.exports = { resolve, explain, validate, run, main };

if (require.main === module) {
  Promise.resolve(main(process.argv.slice(2))).then((code) => process.exit(code));
}
