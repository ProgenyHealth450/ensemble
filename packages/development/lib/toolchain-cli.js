#!/usr/bin/env node
'use strict';

/**
 * toolchain-cli.js — CLI over the toolchain configuration resolver library
 * (TRD-2026-8d825f54 TRD-004/TRD-007/TRD-014/TRD-018, PRD REQ-012, REQ-008, REQ-003, REQ-013,
 * REQ-011).
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
 *                      category (`capability.split('.')[0]`), with `cwd` always explicitly set
 *                      to `ctx.projectRoot` (TRD review Finding 6: an adapter's relative
 *                      executables must resolve against the project root, never whatever
 *                      directory the CLI process happened to start in). When the capability's
 *                      category contract (`./toolchain/contracts.js#loadContracts()`) marks it
 *                      `sideEffect:true`, a passing preflight record for `--run-id` is required
 *                      first (`./toolchain/preflight.js#hasPassingPreflightRecord`, TRD-014,
 *                      PRD REQ-013): missing or failed preflight returns `PREFLIGHT_REQUIRED`
 *                      and never resolves an adapter or spawns anything. Once resolved, a
 *                      side-effecting capability's adapter must also be confirmed for this
 *                      session (`./toolchain/confirm.js#confirmStatus`, TRD-017, PRD REQ-011):
 *                      an unconfirmed adapter returns `CONFIRMATION_REQUIRED` and never calls
 *                      `loadAdapter`/`runCapability`; non-interactive runs (`--non-interactive`,
 *                      `ENSEMBLE_NON_INTERACTIVE=1`, a set `FOREMAN_TASK_TITLE`, or `CI=true`)
 *                      are auto-confirmed and logged, never silently skipped. `--arg k=v` may
 *                      repeat to supply the capability's argument values. A side-effecting
 *                      capability's SUCCESS appends one entry to `ledger-<runId>.jsonl`
 *                      (`./toolchain/ledger.js#recordSideEffect`, TRD System Architecture data-
 *                      flow step 4); its FAILURE instead writes `failure-<runId>.json`
 *                      (`#recordFailure`, data-flow step 6) naming every side-effecting
 *                      capability completed so far under this run id, read back from the
 *                      ledger itself (`#readLedgerEntries`), since each `toolchain-cli run`
 *                      invocation is its own process with no memory of an earlier one under the
 *                      same `--run-id`. No retry, no resume, exactly one `runCapability` call.
 *   preflight --require <capability> [--require <capability> ...] [--run-id <id>]
 *             [--non-interactive] [--json]
 *                      Run every health check declared by the adapters selected for the union
 *                      of `--require`'d capabilities' categories (`capability.split('.')[0]`),
 *                      via `runPreflight()` in `./toolchain/preflight.js` (TRD-014, PRD
 *                      REQ-013). `--require` must be supplied at least once (`INVALID_ARG`
 *                      otherwise). `--run-id` is optional: when supplied it is validated with
 *                      the same `./toolchain/run-id.js#isValidRunId` charset `run` uses
 *                      (`INVALID_RUN_ID` on failure, checked before anything else runs); when
 *                      omitted, a fresh id is generated with `crypto.randomUUID()` (always
 *                      charset-valid, so it is never separately re-validated). On a full pass
 *                      this writes a preflight record and returns `{ok:true, runId,
 *                      categories, checkedAt}`; on the first failing check it returns
 *                      `{ok:false, error:{code:'HEALTH_FAILED', message}}` naming the adapter
 *                      and check id, writing no record. This is `run`'s own
 *                      `PREFLIGHT_REQUIRED` gate's production counterpart: a `--run-id` passed
 *                      to `run` must have a prior passing `preflight` invocation under the
 *                      same id.
 *   confirm-status <capability> [--run-id <id>] [--non-interactive] [--json]
 *                      Look up whether `capability`'s category (`capability.split('.')[0]`)
 *                      has already been confirmed for this session, via
 *                      `./toolchain/confirm.js#confirmStatus` (TRD-017, PRD REQ-011), after
 *                      resolving the category's adapter (`resolveCategory`/`loadAdapter`, the
 *                      same `RESOLVE_FAILED`/`NOT_INSTALLED`-style errors `run` uses) and
 *                      looking up `sideEffect` from the category contract the same way `run`
 *                      does. Returns `{ok:true, capability, adapter, source, data}` where
 *                      `data` is `confirmStatus`'s own result verbatim (`{required:false}` |
 *                      `{confirmed:true, prompt:false}` | `{confirmed:true}` |
 *                      `{confirmed:false, adapter, source, allowlist?}`) -- a repo-local
 *                      adapter's manifest `allowlist` is passed through so a denied status can
 *                      show a caller exactly what the adapter is permitted to run.
 *   confirm-record <capability> [--run-id <id>] [--json]
 *                      Write a passive confirmation record for `capability`'s category's
 *                      currently-resolved adapter, via
 *                      `./toolchain/confirm.js#recordConfirmation` (TRD-017, PRD REQ-011), with
 *                      the same resolve/load prelude as `confirm-status`. This is
 *                      `recordConfirmation`'s first production/CLI caller (TRD-018): a future
 *                      interactive confirmation UI, or an operator confirming a session once up
 *                      front, calls this after a user says yes. Returns `{ok:true, capability,
 *                      adapter, source, data:{confirmed:true}}`.
 *
 * Output:
 *   - Default (no `--json`): a human-readable table with columns `category`, `adapter`,
 *     `source`, one row per category, printed to stdout for `resolve`/`explain`; for
 *     `validate`, `ok` on success or one error per line (to stderr) on failure; for `run`, the
 *     capability's raw output on success (to stdout) or `<code>: <message>` on failure (to
 *     stderr); for `preflight`, a one-line `preflight ok: runId=<id> categories=<list>` on
 *     success (to stdout) or `<code>: <message>` on failure (to stderr); for `confirm-status`/
 *     `confirm-record`, a one-line human summary of `data` on success (to stdout) or
 *     `<code>: <message>` on failure (to stderr).
 *   - `--json`: `{ok:true, data:{<category>:{adapter, source}, ...}}` on success, or
 *     `{ok:false, error:{code, message}}` on failure, printed to stdout for `resolve`/`explain`;
 *     for `validate`, `{ok:true, errors:[]}` or `{ok:false, errors:[...]}` (matching
 *     `validateConformance`'s own return shape) printed to stdout either way; for `run`/
 *     `preflight`/`confirm-status`/`confirm-record`, the respective envelope (`{ok:true,
 *     capability, adapter, source, data}` or `{ok:true, runId, categories, checkedAt}`, or
 *     `{ok:false, error:{code, message}}`) printed to stdout either way.
 *   - Unknown or missing subcommand: with `--json`, `{ok:false, error:{code:'UNKNOWN_SUBCOMMAND',
 *     message}}` to stdout; without `--json`, a human error line to stderr naming all seven
 *     subcommands. Either way the process exits with code 2.
 *
 * The module is both importable (`resolve`, `explain`, `validate`, `run`, `preflight`,
 * `confirmStatus`, `confirmRecord`, `main` are exported for in-process callers such as other
 * `packages/development` CLIs) and executable (`if (require.main === module) { ... }`),
 * mirroring `trd-cli.js`'s convention. Note the JSON envelope and error shape here (`{ok,
 * data}` / `{ok:false, error:{code, message}}`) are distinct from `trd-cli.js`'s own `{error}`-
 * only shape; do not conflate the two.
 *
 * `resolve(ctx)`/`explain(ctx)` accept the same `{projectRoot, env, detect}` context that
 * `resolveCategory()` accepts and pass it straight through for every category, unmodified.
 * `detect` is the TRD-016 detection-engine injection point (`./toolchain/detect.js#detectAdapter`):
 * `main()`'s default `ctx` (used by every real CLI invocation) wires it in automatically, so
 * `resolve`/`explain`/`run` detect a real adapter from repo signals when config and env-compat
 * decline to resolve a category. A caller that supplies its own `ctx` (including every existing
 * test) gets exactly what it passes -- no detect, or a stub detect -- unaffected by this.
 *
 * `main(argv, ctx)` takes an optional second `ctx` argument purely so callers (tests) can
 * exercise the full argv-parsing/JSON/table-rendering path against an injected
 * `{projectRoot, env, detect}` without depending on `process.cwd()`/`process.env`/the real
 * detection engine. Real invocations never pass it, so `ctx` always defaults to
 * `{projectRoot: process.cwd(), env: process.env, detect: detectAdapter}`, matching this
 * command's documented behavior exactly.
 * `main()` returns a plain `number` exit code for every subcommand except `run` and
 * `preflight`, which are inherently asynchronous (each may spawn a child process): for those
 * two it returns a `Promise<number>` instead. This is the one place the return type varies; the
 * `if (require.main === module)` guard below handles both uniformly via `Promise.resolve(...)`,
 * and every synchronous subcommand's direct callers (including the existing test suite) keep
 * receiving a plain number exactly as before.
 */

const crypto = require('crypto');
const { resolveCategory } = require('./toolchain/config');
const { loadAdapter } = require('./toolchain/adapters');
const { runCapability } = require('./toolchain/runner');
const { loadContracts } = require('./toolchain/contracts');
const { hasPassingPreflightRecord, runPreflight } = require('./toolchain/preflight');
const { validateAdapterDir } = require('./toolchain/validate');
const { recordSideEffect, recordFailure, readLedgerEntries } = require('./toolchain/ledger');
const { isValidRunId, invalidRunIdMessage } = require('./toolchain/run-id');
const { detectAdapter } = require('./toolchain/detect');
const { confirmStatus: confirmAdapterStatus, recordConfirmation } = require('./toolchain/confirm');

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
    const code = err && err.code ? err.code : 'RESOLVE_FAILED';
    return { ok: false, error: { code, message } };
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
 * `run <capability> [--run-id <id>] [--arg k=v ...]` subcommand handler (TRD-014, TRD-015, PRD
 * REQ-013, REQ-014, AC-013-1/2/3, AC-014-1/2/3). Looks up whether `capability` is declared
 * `sideEffect:true` by its category contract (`loadContracts()`, `./toolchain/contracts.js`;
 * the category is derived as `capability.split('.')[0]`, mirroring the same ~5-line lookup
 * technique used elsewhere in this wave — this is a deliberate, small duplication, not a shared
 * helper, since the two callers must not depend on each other's new files this wave).
 *
 * TRD review Finding 3 (round 2): when `--run-id` is supplied at all, it is validated FIRST
 * (`./toolchain/run-id.js#isValidRunId`, the SAME shared charset `preflight.js`/`ledger.js`
 * use) and rejected with `{ok:false, error:{code:'INVALID_RUN_ID', message}}` before anything
 * else runs -- before the sideEffect lookup, before `hasPassingPreflightRecord`, before
 * `resolveCategory`/`loadAdapter`/`runCapability` -- so a malformed id (wrong charset, a
 * filename-colliding value, control characters) can never reach a filesystem path, regardless
 * of whether the capability turns out to be side-effecting. `--run-id` omitted entirely is NOT
 * validated here (there is nothing to validate); a non-side-effecting capability still runs
 * with no run id at all, exactly as before.
 *
 * When the capability is side-effecting and `hasPassingPreflightRecord(runId, ctx)`
 * (`./toolchain/preflight.js`, TRD-014) is `false` — including when `--run-id` was omitted
 * entirely — this returns `{ok:false, error:{code:'PREFLIGHT_REQUIRED', message}}` WITHOUT
 * calling `resolveCategory`, `loadAdapter` or `runCapability`: nothing is resolved or spawned.
 *
 * Otherwise (the capability is not side-effecting, or a passing preflight record exists for
 * `runId`), resolves the capability's adapter via `resolveCategory`/`loadAdapter` and invokes
 * it via `runCapability` (TRD-011) with `execFileOptions.cwd` explicitly set to
 * `ctx.projectRoot` (TRD review Finding 6) — never the ambient `process.cwd()` a caller's
 * shell happened to be in.
 *
 * TRD-015 ledger wiring (TRD review Finding 2: this used to end at `runCapability` and never
 * touched `./toolchain/ledger.js`, so neither data-flow step 4 nor step 6 was reachable from
 * any shipped entry point): when the capability is side-effecting,
 * - on success, `recordSideEffect` appends one entry to `ledger-<runId>.jsonl` and the
 *   envelope is returned unchanged;
 * - on failure, `readLedgerEntries(runId, ctx)` reads every capability already recorded under
 *   this `--run-id` (across every earlier `toolchain-cli run` invocation sharing it, not just
 *   this process) and `recordFailure` writes `failure-<runId>.json` naming them; the returned
 *   envelope gains `completedSideEffects` (that same list) and `failureRecord` (the paths
 *   `recordFailure` wrote to) alongside the unchanged `error`.
 * A non-side-effecting capability never touches the ledger at all, success or failure.
 *
 * @param {{projectRoot?: string, env?: NodeJS.ProcessEnv}} [ctx]
 * @param {string[]} [positionals] `positionals[0]` is the capability id, e.g. `tracker.close`
 * @param {{runId?: string, args?: Record<string, string>}} [parsed] the `--run-id`/`--arg`
 *   values `parseArgs` extracted from argv
 * @returns {Promise<{ok:true, capability:string, adapter:string, source:unknown, data:string} |
 *   {ok:false, error:{code:string, message:string}, completedSideEffects?: string[],
 *   failureRecord?: {filePath:string, artifactPath:string|null}}>}
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

  if (runId !== undefined && !isValidRunId(runId)) {
    return { ok: false, error: { code: 'INVALID_RUN_ID', message: invalidRunIdMessage(runId) } };
  }

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
  let source;
  try {
    const resolved = resolveCategory(category, ctx);
    adapterId = resolved.value;
    source = resolved.source;
  } catch (error) {
    return { ok: false, error: { code: 'RESOLVE_FAILED', message: error.message } };
  }

  if (sideEffect) {
    const confirmation = confirmAdapterStatus(category, {
      projectRoot: ctx.projectRoot || process.cwd(),
      env: ctx.env || process.env,
      nonInteractive: Boolean(parsed.nonInteractive),
      sideEffect: true,
      adapter: adapterId,
      source,
      runId
    });

    if (confirmation.required !== false && confirmation.confirmed !== true) {
      return {
        ok: false,
        error: {
          code: 'CONFIRMATION_REQUIRED',
          message:
            `capability '${capability}' is side-effecting and adapter '${adapterId}' ` +
            `(source: ${source}) has not been confirmed for category '${category}' in this ` +
            `session; run an interactive session once to confirm, or set ` +
            `--non-interactive/ENSEMBLE_NON_INTERACTIVE=1/CI=true for a non-interactive run`
        }
      };
    }
  }

  let loaded;
  try {
    loaded = loadAdapter(adapterId, ctx);
  } catch (error) {
    return { ok: false, error: { code: error.code || 'NOT_INSTALLED', message: error.message } };
  }

  const projectRoot = ctx.projectRoot || process.cwd();
  const result = await runCapability(loaded.manifest, capability, args, {
    execFileOptions: { cwd: projectRoot }
  });

  if (!sideEffect) {
    return result;
  }

  if (result.ok) {
    recordSideEffect(
      runId,
      { capability, adapter: adapterId, args, timestamp: new Date().toISOString() },
      { projectRoot }
    );
    return result;
  }

  const completedSideEffects = readLedgerEntries(runId, { projectRoot }).map(
    (entry) => entry.capability
  );
  const { filePath, artifactPath } = recordFailure(
    runId,
    { adapter: adapterId, capability, completedSideEffects, error: result.error },
    { projectRoot, env: ctx.env }
  );

  return { ...result, completedSideEffects, failureRecord: { filePath, artifactPath } };
}

/**
 * `preflight --require <capability> [--require <capability> ...] [--run-id <id>]` subcommand
 * handler (TRD-014, TRD-018, PRD REQ-013). Derives the unique set of categories
 * (`capability.split('.')[0]`) across every `--require`'d capability and runs every one of
 * those categories' declared health checks via `runPreflight()` (`./toolchain/preflight.js`).
 *
 * `parsed.requires` must be non-empty (`INVALID_ARG` otherwise -- `preflight` with nothing to
 * check is never meaningful). When `parsed.runId` was actually supplied by the caller it is
 * validated FIRST with the same `./toolchain/run-id.js#isValidRunId`/`invalidRunIdMessage`
 * pair `run()` already uses (`INVALID_RUN_ID` on failure, checked before `runPreflight` is
 * ever called); when omitted entirely, a fresh id is generated with `crypto.randomUUID()`,
 * which always satisfies `isValidRunId` so no separate validation branch exists for that case.
 * `runPreflight`'s own result (`{ok:true, runId, categories, checkedAt}` or `{ok:false,
 * error:{code:'HEALTH_FAILED'|'INVALID_RUN_ID', message}}`) is returned unchanged.
 *
 * @param {{projectRoot?: string, env?: NodeJS.ProcessEnv}} [ctx]
 * @param {string[]} [positionals] unused by `preflight`; accepted so every handler shares the
 *   same `(ctx, positionals, parsed)` signature
 * @param {{requires?: string[], runId?: string, nonInteractive?: boolean}} [parsed]
 * @returns {Promise<{ok:true, runId:string, categories:string[], checkedAt:string} |
 *   {ok:false, error:{code:string, message:string}}>}
 */
async function preflight(ctx = {}, positionals = [], parsed = {}) {
  const requires = Array.isArray(parsed.requires) ? parsed.requires : [];
  if (requires.length === 0) {
    return {
      ok: false,
      error: {
        code: 'INVALID_ARG',
        message: 'preflight: at least one --require <capability> is required'
      }
    };
  }

  for (const capability of requires) {
    if (
      !capability.includes('.') ||
      capability.split('.')[0].length === 0 ||
      capability.split('.')[1].length === 0
    ) {
      return {
        ok: false,
        error: {
          code: 'INVALID_ARG',
          message: `preflight: '${capability}' is not a valid '<category>.<capability>' id`
        }
      };
    }
  }

  const categories = [...new Set(requires.map((capability) => capability.split('.')[0]))];

  let runId = parsed.runId;
  if (runId !== undefined) {
    if (!isValidRunId(runId)) {
      return { ok: false, error: { code: 'INVALID_RUN_ID', message: invalidRunIdMessage(runId) } };
    }
  } else {
    runId = crypto.randomUUID();
  }

  return runPreflight(
    { categories, runId, nonInteractive: Boolean(parsed.nonInteractive) },
    { projectRoot: ctx.projectRoot || process.cwd(), env: ctx.env || process.env }
  );
}

/**
 * `confirm-status <capability> [--run-id <id>] [--non-interactive]` subcommand handler
 * (TRD-017, TRD-018, PRD REQ-011). Resolves `capability`'s category's adapter and looks up
 * `sideEffect` from the category contract the same ~5-line way `run()` already does (a
 * deliberate, small duplication per this file's own documented convention for these lookups --
 * not a shared helper), then calls `./toolchain/confirm.js#confirmStatus` (imported here as
 * `confirmAdapterStatus` to avoid colliding with this function's own name) and returns its
 * result verbatim as `data`.
 *
 * @param {{projectRoot?: string, env?: NodeJS.ProcessEnv}} [ctx]
 * @param {string[]} [positionals] `positionals[0]` is the capability id, e.g. `tracker.create`
 * @param {{runId?: string, nonInteractive?: boolean}} [parsed]
 * @returns {{ok:true, capability:string, adapter:string, source:string, data:object} |
 *   {ok:false, error:{code:string, message:string}}}
 */
function confirmStatus(ctx = {}, positionals = [], parsed = {}) {
  const capability = positionals[0];
  if (!capability) {
    return {
      ok: false,
      error: { code: 'INVALID_ARG', message: 'confirm-status: missing required <capability> argument' }
    };
  }

  if (parsed.runId !== undefined && !isValidRunId(parsed.runId)) {
    return { ok: false, error: { code: 'INVALID_RUN_ID', message: invalidRunIdMessage(parsed.runId) } };
  }

  const category = capability.split('.')[0];

  const contracts = loadContracts();
  const contractFile = contracts[`${category}.yaml`];
  const capabilityDef =
    contractFile && contractFile.capabilities && contractFile.capabilities[capability];
  const sideEffect = Boolean(capabilityDef && capabilityDef.sideEffect);

  let adapterId;
  let source;
  try {
    const resolved = resolveCategory(category, ctx);
    adapterId = resolved.value;
    source = resolved.source;
  } catch (error) {
    return { ok: false, error: { code: 'RESOLVE_FAILED', message: error.message } };
  }

  let loaded;
  try {
    loaded = loadAdapter(adapterId, { ...ctx, interactive: !Boolean(parsed.nonInteractive) });
  } catch (error) {
    return { ok: false, error: { code: error.code || 'NOT_INSTALLED', message: error.message } };
  }

  const data = confirmAdapterStatus(category, {
    projectRoot: ctx.projectRoot || process.cwd(),
    env: ctx.env || process.env,
    nonInteractive: Boolean(parsed.nonInteractive),
    sideEffect,
    adapter: adapterId,
    source,
    runId: parsed.runId,
    allowlist: loaded.origin === 'repo-local' ? loaded.manifest.allowlist : undefined
  });

  return { ok: true, capability, adapter: adapterId, source, data };
}

/**
 * `confirm-record <capability> [--run-id <id>]` subcommand handler (TRD-017, TRD-018, PRD
 * REQ-011). Same capability/category/resolve/load prelude as `confirmStatus` above, then
 * writes a passive confirmation record via `./toolchain/confirm.js#recordConfirmation` --
 * `recordConfirmation`'s first production/CLI caller.
 *
 * @param {{projectRoot?: string, env?: NodeJS.ProcessEnv}} [ctx]
 * @param {string[]} [positionals] `positionals[0]` is the capability id, e.g. `tracker.create`
 * @param {{runId?: string}} [parsed]
 * @returns {{ok:true, capability:string, adapter:string, source:string,
 *   data:{confirmed:true}} | {ok:false, error:{code:string, message:string}}}
 */
function confirmRecord(ctx = {}, positionals = [], parsed = {}) {
  const capability = positionals[0];
  if (!capability) {
    return {
      ok: false,
      error: { code: 'INVALID_ARG', message: 'confirm-record: missing required <capability> argument' }
    };
  }

  if (parsed.runId !== undefined && !isValidRunId(parsed.runId)) {
    return { ok: false, error: { code: 'INVALID_RUN_ID', message: invalidRunIdMessage(parsed.runId) } };
  }

  const category = capability.split('.')[0];

  let adapterId;
  let source;
  try {
    const resolved = resolveCategory(category, ctx);
    adapterId = resolved.value;
    source = resolved.source;
  } catch (error) {
    return { ok: false, error: { code: 'RESOLVE_FAILED', message: error.message } };
  }

  try {
    loadAdapter(adapterId, { ...ctx, interactive: !Boolean(parsed.nonInteractive) });
  } catch (error) {
    return { ok: false, error: { code: error.code || 'NOT_INSTALLED', message: error.message } };
  }

  recordConfirmation(category, {
    projectRoot: ctx.projectRoot || process.cwd(),
    env: ctx.env || process.env,
    adapter: adapterId,
    source,
    runId: parsed.runId
  });

  return { ok: true, capability, adapter: adapterId, source, data: { confirmed: true } };
}

const HANDLERS = {
  resolve,
  explain,
  validate,
  run,
  preflight,
  'confirm-status': confirmStatus,
  'confirm-record': confirmRecord
};

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
 * Parse CLI argv into a subcommand name, the `--json` flag, positional arguments, and the
 * flags various subcommands consume: `run`'s own `--run-id <id>` / repeated `--arg k=v`,
 * `preflight`'s repeated `--require <capability>`, and `confirm-status`/`confirm-record`'s
 * shared `--run-id <id>` / `--non-interactive`. Every consumed flag's value is removed (never
 * left in `positionals`) so `validate <adapter-dir>` and `resolve`/`explain` (which ignore
 * `positionals` entirely) are unaffected when those flags are absent, which is always true for
 * every subcommand except `run`, `preflight`, `confirm-status` and `confirm-record`.
 *
 * TRD review Finding 5: `--run-id`/`--arg` used to blindly consume the NEXT token as their
 * value even when that token was itself another flag (e.g. `--run-id --json` used to silently
 * set `runId` to the literal string `'--json'`), and a malformed `--arg` value (`oops` with no
 * `=`, or `=v` with an empty key) was silently dropped rather than reported. Both are now
 * explicit, named `INVALID_ARG` errors returned via the `error` field below: `main()` prints
 * them and exits non-zero instead of silently proceeding with a wrong or missing value. Because
 * a flag-looking token can therefore never be consumed as a `--run-id`/`--arg` value, the
 * top-level `--json` flag below is unambiguously a real flag wherever it appears in `argv`,
 * never something that was actually meant as an `--arg`'s value.
 *
 * @param {string[]} argv
 * @returns {{subcommand: string|undefined, json: boolean, positionals: string[],
 *   runId: string|undefined, args: Record<string, string>, requires: string[],
 *   error?: {code: string, message: string}}}
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
  const nonInteractive = list.includes('--non-interactive');
  let runId;
  const args = {};
  const requires = [];
  const positionals = [];

  const invalidArg = (message) => ({
    subcommand,
    json,
    nonInteractive,
    positionals,
    runId,
    args,
    requires,
    error: { code: 'INVALID_ARG', message }
  });

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token === '--json') {
      continue;
    } else if (token === '--non-interactive') {
      continue;
    } else if (token === '--run-id') {
      const value = rest[i + 1];
      if (typeof value !== 'string' || value.startsWith('--')) {
        return invalidArg(
          `--run-id requires a value (got ${value === undefined ? 'nothing' : JSON.stringify(value)})`
        );
      }
      runId = value;
      i += 1;
    } else if (token === '--arg') {
      const pair = rest[i + 1];
      if (typeof pair !== 'string' || pair.startsWith('--')) {
        return invalidArg(
          `--arg requires a 'key=value' value (got ${pair === undefined ? 'nothing' : JSON.stringify(pair)})`
        );
      }
      const eqIndex = pair.indexOf('=');
      if (eqIndex <= 0) {
        return invalidArg(`--arg value ${JSON.stringify(pair)} is not in 'key=value' form`);
      }
      args[pair.slice(0, eqIndex)] = pair.slice(eqIndex + 1);
      i += 1;
    } else if (token === '--require') {
      const value = rest[i + 1];
      if (typeof value !== 'string' || value.startsWith('--')) {
        return invalidArg(
          `--require requires a value (got ${value === undefined ? 'nothing' : JSON.stringify(value)})`
        );
      }
      requires.push(value);
      i += 1;
    } else {
      positionals.push(token);
    }
  }

  return { subcommand, json, nonInteractive, positionals, runId, args, requires };
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
      if (Array.isArray(result.completedSideEffects)) {
        process.stderr.write(
          `Completed side effects: ${result.completedSideEffects.join(', ') || '(none)'}\n`
        );
      }
    }
    return;
  }

  if (subcommand === 'preflight') {
    if (result.ok) {
      process.stdout.write(
        `preflight ok: runId=${result.runId} categories=${result.categories.join(',')}\n`
      );
    } else {
      process.stderr.write(`${result.error.code}: ${result.error.message}\n`);
    }
    return;
  }

  if (subcommand === 'confirm-status' || subcommand === 'confirm-record') {
    if (result.ok) {
      process.stdout.write(
        `${subcommand} ok: capability=${result.capability} adapter=${result.adapter} ` +
          `source=${result.source} data=${JSON.stringify(result.data)}\n`
      );
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
 *   `{projectRoot: process.cwd(), env: process.env, detect: detectAdapter}`; real invocations
 *   never override this.
 * @returns {number|Promise<number>} process exit code; a `Promise<number>` only for the `run`
 *   and `preflight` subcommands (see this file's header doc).
 */
function main(argv, ctx = { projectRoot: process.cwd(), env: process.env, detect: detectAdapter }) {
  const parsed = parseArgs(argv);
  const { subcommand, json, positionals, error } = parsed;

  if (error) {
    if (json) {
      process.stdout.write(JSON.stringify({ ok: false, error }) + '\n');
    } else {
      process.stderr.write(`${error.code}: ${error.message}\n`);
    }
    return 1;
  }

  const handler = subcommand && HANDLERS[subcommand];

  if (!handler) {
    const usage =
      'Usage: toolchain-cli <resolve|explain|validate|run|preflight|confirm-status|confirm-record> [--json]';
    const message = subcommand
      ? `Unknown subcommand '${subcommand}'. ${usage}`
      : `Missing subcommand. ${usage}`;
    if (json) {
      process.stdout.write(
        JSON.stringify({ ok: false, error: { code: 'UNKNOWN_SUBCOMMAND', message } }) + '\n'
      );
    } else {
      process.stderr.write(message + '\n');
    }
    return 2;
  }

  if (subcommand === 'run' || subcommand === 'preflight') {
    return handler(ctx, positionals, parsed).then((result) => {
      printResult(subcommand, json, result);
      return result.ok ? 0 : 1;
    });
  }

  const result = handler(ctx, positionals, parsed);
  printResult(subcommand, json, result);
  return result.ok ? 0 : 1;
}

module.exports = { resolve, explain, validate, run, preflight, confirmStatus, confirmRecord, main };

if (require.main === module) {
  Promise.resolve(main(process.argv.slice(2))).then((code) => process.exit(code));
}
