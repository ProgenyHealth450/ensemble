'use strict';

/**
 * Passive confirmation records for side-effecting capabilities (TRD-2026-8d825f54 TRD-017, PRD
 * REQ-011, AC-011-1..5). `confirmStatus(category, ctx)` answers "has this adapter already been
 * confirmed in this session for this category/config?" without ever prompting itself (no TTY
 * read, no readline — this module is passive by design: the interactive surface that would
 * actually show a user a prompt and call `recordConfirmation` on "yes" does not exist yet, see
 * "Known limits" below). `recordConfirmation(category, ctx)` writes the record a future
 * confirmation UI would call after a user says yes.
 *
 * ## Spike: which session id does each runtime actually expose?
 *
 * TRD-017 requires this module to begin with a spike recording which session id each runtime
 * exposes, since no stable session id is uniformly available (TRD interpretation I4). Verified
 * by grep against this repo's own runtime-integration docs/code before writing this table (not
 * taken on faith):
 *
 * | Runtime | Session-id variable | Notes |
 * |---|---|---|
 * | Claude Code | `CLAUDE_SESSION_ID` | Confirmed: `docs/guides/environment-variables.md`'s
 * |   |   | "Injected by Claude Code" section documents it as injected automatically into every
 * |   |   | process. The one real, confirmed host session variable in this repo today. |
 * | Ensemble (canonical) | `ENSEMBLE_SESSION_ID` | NOT currently set by any runtime integration
 * |   |   | in this repo (grep across the repo finds it referenced only in this TRD's own task
 * |   |   | prose, never produced by code). Reserved as the highest-precedence lookup below so
 * |   |   | no future code change is needed once a runtime starts setting it. |
 * | Ensemble lifecycle hooks | `ENSEMBLE_RUN_ID` (not a session id) | `docs/guides/command-lifecycle-hooks.md`
 * |   |   | confirms the lifecycle-hook runner sets `ENSEMBLE_RUN_ID` (plus `ENSEMBLE_EVENT`,
 * |   |   | `ENSEMBLE_COMMAND`, `ENSEMBLE_PROJECT_ROOT`) — but ONLY inside the hook-handler
 * |   |   | child processes it spawns itself; `toolchain-cli` invoked from an ordinary agent
 * |   |   | shell command does not inherit it. |
 * | Pi / OMP | none found | `grep -rl SESSION_ID packages/pi` and `grep -rl RUN_ID packages/pi`
 * |   |   | both return no matches in this repo. |
 * | Codex | none found | `grep -rl SESSION_ID packages/codex` and `grep -rl RUN_ID
 * |   |   | packages/codex` both return no matches in this repo. |
 * | OpenCode | none found | No `packages/opencode` integration and no `SESSION_ID`/`RUN_ID`
 * |   |   | reference anywhere outside the runtimes above exist in this repo. |
 * | Foreman | none found | No `SESSION_ID`/`RUN_ID` environment-variable producer for Foreman
 * |   |   | exists in this repo's `docs/guides`/`docs/architecture`. |
 *
 * Conclusion (I4 materializes): most runtimes expose nothing. `resolveSessionKey` therefore
 * returns `null` far more often than not, and both `confirmStatus`/`recordConfirmation` fall
 * back to the caller-supplied run id (and finally to the literal string `'no-session'`) so
 * neither function ever throws for a missing session id.
 *
 * ## Fallback precedence chain
 *
 * `resolveSessionKey(ctx)`: `ctx.env.ENSEMBLE_SESSION_ID` (non-empty) -> else
 * `ctx.env.CLAUDE_SESSION_ID` (non-empty) -> else `null`. Callers (`confirmStatus`/
 * `recordConfirmation`, via the internal `effectiveSessionKey` helper below) then fall back to
 * `ctx.runId` when `resolveSessionKey` returns `null`, and to the literal string `'no-session'`
 * when `ctx.runId` is also absent/empty — this chain never throws.
 *
 * ## File-naming / hashing scheme
 *
 * `configHash(adapter, source)` is `sha256(JSON.stringify({adapter, source}))` hex: it changes
 * whenever a config edit changes which adapter/source is selected for the category (AC-011-4),
 * and stays stable when nothing changed (AC-011-2). The confirmation record's file key is
 * `sha256([sessionKey, category, adapter, hash].join('\u0000'))` hex, stored at
 * `<projectRoot>/.ensemble/state/toolchain/confirmations/<fileKey>.json`. A sha256 hex digest is
 * inherently filename-safe (fixed charset `[0-9a-f]{64}`, no path-traversal risk) regardless of
 * what `sessionKey`/`category`/`adapter` themselves contain, satisfying the shared
 * filename-safety bar without routing through `./run-id.js` (that validator is for
 * caller-supplied run ids used verbatim in a filename; this module never does that — it only
 * ever uses a run id as one hashed input among several).
 *
 * ## Concurrency safety
 *
 * Two processes confirming at the same instant for DIFFERENT categories (or different
 * adapters, or different configs) hash to two different `fileKey`s and therefore two different
 * files — they never contend for the same path, so no lock is needed for that case. Two
 * processes confirming the SAME `(sessionKey, category, adapter, configHash)` tuple at the same
 * instant both write via the atomic temp-file-then-rename pattern (`preflight.js#runPreflight`'s
 * exact pattern, reused here), so the record file itself is never observed half-written; the
 * last rename to land simply wins, which is correct here since both writers were recording an
 * identical confirmation for an identical tuple.
 *
 * ## Known limits
 *
 * - `recordConfirmation` has NO CLI entry point yet: "confirm-record subcommand: not yet
 *   reachable from CLI, wired by TRD-018." Only `confirmStatus`'s deny path
 *   (`CONFIRMATION_REQUIRED`, wired into `toolchain-cli.js`'s `run` subcommand) is reachable
 *   from the shipped `run` subcommand in this PR.
 * - This module never prompts a user itself (no TTY read); it is a passive status check plus a
 *   passive record-writer. The interactive confirmation UI that would call `recordConfirmation`
 *   after a real user says "yes" is out of scope here (TRD-018).
 * - `configHash` is keyed on the *selection* (adapter id + precedence tier) per the bead's
 *   AC-011-2 wording, not on the selected adapter's own manifest/SKILL content: an edit to an
 *   already-selected adapter's `adapter.yaml` (allowlist, capabilities, contractVersion) does
 *   not by itself invalidate an existing confirmation.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * The canonical Ensemble session id, then Claude Code's injected session id, then `null` when
 * neither is set (see this file's header spike table/fallback-chain sections).
 *
 * @param {{env?: NodeJS.ProcessEnv}} ctx
 * @returns {string|null}
 */
function resolveSessionKey(ctx) {
  const env = (ctx && ctx.env) || {};
  if (typeof env.ENSEMBLE_SESSION_ID === 'string' && env.ENSEMBLE_SESSION_ID !== '') {
    return env.ENSEMBLE_SESSION_ID;
  }
  if (typeof env.CLAUDE_SESSION_ID === 'string' && env.CLAUDE_SESSION_ID !== '') {
    return env.CLAUDE_SESSION_ID;
  }
  return null;
}

/**
 * `resolveSessionKey(ctx)`, falling back to `ctx.runId` and finally the literal string
 * `'no-session'` so this never returns `null`/throws (end-to-end I4 fallback chain).
 *
 * @param {{env?: NodeJS.ProcessEnv, runId?: string}} ctx
 * @returns {string}
 */
function effectiveSessionKey(ctx) {
  const sessionKey = resolveSessionKey(ctx);
  if (sessionKey !== null) {
    return sessionKey;
  }
  if (typeof ctx.runId === 'string' && ctx.runId !== '') {
    return ctx.runId;
  }
  return 'no-session';
}

/**
 * Whether `ctx` carries an EXPLICIT non-interactive signal. The absence of a TTY is never one
 * of these signals (TRD-017 AC: "the absence of a TTY alone never counts as non-interactive") —
 * this function never inspects `process.stdout.isTTY` or anything like it.
 *
 * Precedence: `ctx.nonInteractive === true` (the CLI's own `--non-interactive` flag), OR
 * `ctx.env.ENSEMBLE_NON_INTERACTIVE === '1'`, OR a non-empty `ctx.env.FOREMAN_TASK_TITLE`, OR
 * `ctx.env.CI === 'true'`.
 *
 * @param {{nonInteractive?: boolean, env?: NodeJS.ProcessEnv}} ctx
 * @returns {boolean}
 */
function isNonInteractive(ctx) {
  const env = (ctx && ctx.env) || {};
  if (ctx && ctx.nonInteractive === true) {
    return true;
  }
  if (env.ENSEMBLE_NON_INTERACTIVE === '1') {
    return true;
  }
  if (typeof env.FOREMAN_TASK_TITLE === 'string' && env.FOREMAN_TASK_TITLE.trim() !== '') {
    return true;
  }
  if (env.CI === 'true') {
    return true;
  }
  return false;
}

/**
 * `sha256(JSON.stringify({adapter, source}))` hex — see this file's header "File-naming /
 * hashing scheme" section for why this is the right change signal for AC-011-2/AC-011-4.
 *
 * @param {string} adapter
 * @param {string} source
 * @returns {string}
 */
function configHash(adapter, source) {
  return crypto.createHash('sha256').update(JSON.stringify({ adapter, source })).digest('hex');
}

/**
 * The confirmation record path for one `(sessionKey, category, adapter, hash)` tuple. See this
 * file's header "File-naming / hashing scheme" / "Concurrency safety" sections.
 *
 * @param {string} projectRoot
 * @param {string} sessionKey
 * @param {string} category
 * @param {string} adapter
 * @param {string} hash
 * @returns {string}
 */
function confirmationRecordPath(projectRoot, sessionKey, category, adapter, hash) {
  const fileKey = crypto
    .createHash('sha256')
    .update([sessionKey, category, adapter, hash].join('\u0000'))
    .digest('hex');
  return path.join(
    projectRoot,
    '.ensemble',
    'state',
    'toolchain',
    'confirmations',
    `${fileKey}.json`
  );
}

/**
 * Whether `category`'s resolved adapter is already confirmed for this session (TRD-017, PRD
 * REQ-011, AC-011-1..5). See this file's header doc for the full contract.
 *
 * - `ctx.sideEffect` falsy (contract marks the capability `sideEffect:false`, or the caller is
 *   checking a local-only capability never routed through this gate at all) -> `{required:
 *   false}` immediately, no filesystem access.
 * - `isNonInteractive(ctx)` -> logs one line naming `ctx.adapter`/`ctx.source`/`category` via
 *   `process.stderr.write` and returns `{confirmed: true, prompt: false}` (AC-011-3: no prompt,
 *   the log records adapter and source).
 * - Otherwise: reads back the record at `confirmationRecordPath(...)` (fail closed to
 *   unconfirmed on any missing/unreadable/corrupt file — this NEVER throws for that); a record
 *   whose `category`/`adapter`/`configHash` all match the current ones means `{confirmed:
 *   true}`; anything else means `{confirmed: false, adapter, source, ...(allowlist pass-through
 *   when ctx.allowlist was supplied)}`.
 *
 * @param {string} category
 * @param {{projectRoot?: string, env?: NodeJS.ProcessEnv, nonInteractive?: boolean,
 *   sideEffect?: boolean, adapter?: string, source?: string, runId?: string,
 *   allowlist?: unknown}} [ctx]
 * @returns {{required: false} | {confirmed: true, prompt: false} | {confirmed: true} |
 *   {confirmed: false, adapter: string, source: string, allowlist?: unknown}}
 */
function confirmStatus(category, ctx = {}) {
  if (!ctx.sideEffect) {
    return { required: false };
  }

  if (isNonInteractive(ctx)) {
    process.stderr.write(
      `toolchain confirm: non-interactive, adapter=${ctx.adapter} source=${ctx.source} category=${category}\n`
    );
    return { confirmed: true, prompt: false };
  }

  const projectRoot = ctx.projectRoot || process.cwd();
  const sessionKey = effectiveSessionKey(ctx);
  const hash = configHash(ctx.adapter, ctx.source);
  const recordPath = confirmationRecordPath(projectRoot, sessionKey, category, ctx.adapter, hash);

  let parsed = null;
  try {
    const raw = fs.readFileSync(recordPath, 'utf8');
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }

  if (
    parsed &&
    parsed.category === category &&
    parsed.adapter === ctx.adapter &&
    parsed.configHash === hash
  ) {
    return { confirmed: true };
  }

  return {
    confirmed: false,
    adapter: ctx.adapter,
    source: ctx.source,
    ...(ctx.allowlist ? { allowlist: ctx.allowlist } : {})
  };
}

/**
 * Write a passive confirmation record for `category`'s currently-resolved adapter/source/config
 * (TRD-017, PRD REQ-011). Atomic temp-file-then-rename, the exact pattern
 * `preflight.js#runPreflight` already uses, so two writers never observe a half-written record.
 * Has no CLI entry point yet (see this file's header "Known limits").
 *
 * @param {string} category
 * @param {{projectRoot?: string, env?: NodeJS.ProcessEnv, adapter?: string, source?: string,
 *   runId?: string}} [ctx]
 * @returns {{confirmed: true}}
 */
function recordConfirmation(category, ctx = {}) {
  const projectRoot = ctx.projectRoot || process.cwd();
  const sessionKey = effectiveSessionKey(ctx);
  const hash = configHash(ctx.adapter, ctx.source);
  const targetPath = confirmationRecordPath(projectRoot, sessionKey, category, ctx.adapter, hash);
  const targetDir = path.dirname(targetPath);
  fs.mkdirSync(targetDir, { recursive: true });

  const record = {
    category,
    adapter: ctx.adapter,
    source: ctx.source,
    configHash: hash,
    confirmedAt: new Date().toISOString()
  };

  const tmpPath = path.join(
    targetDir,
    `.tmp-${path.basename(targetPath)}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  fs.writeFileSync(tmpPath, JSON.stringify(record));
  fs.renameSync(tmpPath, targetPath);

  return { confirmed: true };
}

module.exports = { confirmStatus, recordConfirmation };
