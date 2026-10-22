'use strict';

/**
 * Side-effect ledger, failure records and a report-only capability sequence runner
 * (TRD-2026-8d825f54 TRD-015, PRD REQ-014, AC-014-1, AC-014-2, AC-014-3).
 *
 * Three pieces, all scoped to one run id:
 *
 * - `recordSideEffect(runId, entry, ctx)` appends one JSON line describing a capability call
 *   that actually had a side effect to
 *   `<projectRoot>/.ensemble/state/toolchain/ledger-<runId>.jsonl`.
 * - `recordFailure(runId, details, ctx)` writes the single JSON object describing why a run
 *   stopped to `<projectRoot>/.ensemble/state/toolchain/failure-<runId>.json`, and mirrors the
 *   same content to `ctx.env.FOREMAN_ARTIFACT_PATH` when that env var is set, matching the
 *   `FOREMAN_ARTIFACT_PATH` convention `complexity-analyzer.js#main` already uses.
 * - `runSequence(adapter, steps, options, ctx)` runs an ordered list of
 *   `{capability, args}` steps through `runner.js#runCapability`, recording every successful
 *   `sideEffect:true` capability (per its category contract, `contracts.js#loadContracts`) via
 *   `recordSideEffect`, and on the first failure calls `recordFailure` with every side effect
 *   completed so far and returns immediately.
 *
 * On-disk record shapes:
 * - `ledger-<runId>.jsonl`: one line per completed side-effecting capability,
 *   `{capability, adapter, args, timestamp}` (each string field passed through
 *   `redactSecrets` before being written).
 * - `failure-<runId>.json`: a single JSON object,
 *   `{adapter, capability, completedSideEffects: string[], error, timestamp}`, where `error`
 *   is the runner's own `{code, message}` error shape, redacted the same way.
 *
 * ## Known limits
 *
 * `runSequence` is report-only: the first failing capability stops the run immediately and no
 * later step is attempted. There is no retry and no resume -- a caller that wants to continue
 * past a fixed failure must build a new `steps` list (e.g. the remaining steps) and start a new
 * run id; this module has no notion of "resuming" a failed run id. Wiring `runSequence` into a
 * CLI run surface (printing `completedSideEffects`/the failure to the user) is explicitly out
 * of scope for this module and lands in a later TRD task.
 *
 * Run ids are validated before any filesystem access: an id containing `/`, `\`, or `..` is
 * rejected (path-traversal guard, fail closed) rather than silently sanitized.
 */

const fs = require('fs');
const path = require('path');

const { redactSecrets } = require('../complexity-analyzer');
const { runCapability } = require('./runner');
const { loadContracts } = require('./contracts');

/**
 * Validate a run id is safe to interpolate into a path under the state directory.
 *
 * @param {unknown} runId
 * @throws {Error} when `runId` is not a non-empty string, or contains `/`, `\` or `..`
 */
function assertValidRunId(runId) {
  if (typeof runId !== 'string' || runId.length === 0) {
    throw new Error('ledger: runId must be a non-empty string');
  }
  if (runId.includes('/') || runId.includes('\\') || runId.includes('..')) {
    throw new Error(
      `ledger: runId '${runId}' is rejected (path-traversal characters are not allowed)`
    );
  }
}

/**
 * @param {string} projectRoot
 * @returns {string} `<projectRoot>/.ensemble/state/toolchain`
 */
function stateDir(projectRoot) {
  return path.join(projectRoot, '.ensemble', 'state', 'toolchain');
}

/**
 * Recursively apply `redactSecrets` to every string value in `value`, leaving object/array
 * shape otherwise unchanged. Used so no record written by this module can carry a secret to
 * disk, regardless of which field a caller happened to put it in.
 *
 * @param {unknown} value
 * @returns {unknown} same shape as `value`, with every string redacted
 */
function redactRecord(value) {
  if (typeof value === 'string') return redactSecrets(value).text;
  if (Array.isArray(value)) return value.map(redactRecord);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, inner] of Object.entries(value)) out[key] = redactRecord(inner);
    return out;
  }
  return value;
}

/**
 * Append one redacted JSON line describing a completed side-effecting capability call to
 * `ledger-<runId>.jsonl` (TRD-015, AC-014-1/AC-014-2: ledger entries feed the completed-side-
 * effects list a failure record reports).
 *
 * @param {string} runId
 * @param {Record<string, unknown>} entry caller-supplied record (e.g. {capability, adapter,
 *   args, timestamp}); every string value is redacted before being written
 * @param {{projectRoot?: string}} [ctx]
 * @returns {string} the absolute path written to
 */
function recordSideEffect(runId, entry, ctx = {}) {
  assertValidRunId(runId);
  const projectRoot = ctx.projectRoot || process.cwd();
  const dir = stateDir(projectRoot);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `ledger-${runId}.jsonl`);
  fs.appendFileSync(filePath, `${JSON.stringify(redactRecord(entry))}\n`);
  return filePath;
}

/**
 * Write the single JSON failure record for a stopped run to `failure-<runId>.json`, mirroring
 * it to `ctx.env.FOREMAN_ARTIFACT_PATH` when set (TRD-015, AC-014-2). Every string field is
 * redacted before anything touches disk (AC-014-3), including inside `details.error`.
 *
 * @param {string} runId
 * @param {{adapter: string, capability: string, completedSideEffects: string[], error: unknown}} details
 * @param {{projectRoot?: string, env?: NodeJS.ProcessEnv}} [ctx]
 * @returns {{filePath: string, artifactPath: string|null}}
 */
function recordFailure(runId, details, ctx = {}) {
  assertValidRunId(runId);
  const projectRoot = ctx.projectRoot || process.cwd();
  const env = ctx.env || process.env;
  const dir = stateDir(projectRoot);
  fs.mkdirSync(dir, { recursive: true });

  const record = redactRecord({
    adapter: details.adapter,
    capability: details.capability,
    completedSideEffects: details.completedSideEffects || [],
    error: details.error,
    timestamp: new Date().toISOString()
  });
  const payload = `${JSON.stringify(record, null, 2)}\n`;

  const filePath = path.join(dir, `failure-${runId}.json`);
  fs.writeFileSync(filePath, payload);

  const artifactPath = env.FOREMAN_ARTIFACT_PATH || null;
  if (artifactPath) {
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, payload);
  }

  return { filePath, artifactPath };
}

/**
 * Look up whether `capability` is declared `sideEffect: true` by its category contract.
 * Category is derived from the capability id itself (`<category>.<name>`), mirroring the
 * lookup `runSequence`'s sibling tracks (resolve.js/preflight.js) already perform against
 * `loadContracts()`. Returns `false` (never throws) when the category or capability is not
 * found in any loaded contract -- an undeclared capability is never treated as a side effect.
 *
 * @param {Record<string, {capabilities?: Record<string, {sideEffect?: boolean}>}>} contracts
 * @param {string} capability
 * @returns {boolean}
 */
function capabilityHasSideEffect(contracts, capability) {
  const category = String(capability).split('.')[0];
  const contract = contracts[`${category}.yaml`];
  const entry = contract && contract.capabilities && contract.capabilities[capability];
  return Boolean(entry && entry.sideEffect);
}

/**
 * Run an ordered list of capability steps against `adapter` via `runner.js#runCapability`,
 * recording every completed `sideEffect:true` capability to the ledger as it happens, and
 * stopping immediately -- recording a failure instead -- on the first step that does not
 * succeed (TRD-015, AC-014-1). This is a report-only policy: no retry, no resume, no step
 * after a failure is ever attempted (see this module's header "Known limits").
 *
 * @param {{adapter: string, binaries?: string[], allowlist?: unknown[], capabilities: Record<string, unknown>}} adapter
 *   a parsed adapter manifest, passed through to `runCapability` unchanged
 * @param {Array<{capability: string, args?: Record<string, unknown>}>} steps ordered steps
 * @param {{runId: string, runCapabilityOpts?: Record<string, unknown>}} options
 * @param {{projectRoot?: string, env?: NodeJS.ProcessEnv}} [ctx]
 * @returns {Promise<{ok: boolean, adapter: string, completedSideEffects: string[], failedCapability?: string, error?: unknown}>}
 */
async function runSequence(adapter, steps, options = {}, ctx = {}) {
  const { runId } = options;
  assertValidRunId(runId);
  const projectRoot = ctx.projectRoot || process.cwd();
  const env = ctx.env || process.env;
  const adapterId = (adapter && adapter.adapter) || '(unknown adapter)';
  const contracts = loadContracts();
  const completedSideEffects = [];

  for (const step of steps) {
    const { capability } = step;
    const args = step.args || {};
    // eslint-disable-next-line no-await-in-loop -- steps are intentionally sequential: a later
    // step must never start before an earlier one's side effects are recorded.
    const result = await runCapability(adapter, capability, args, options.runCapabilityOpts || {});

    if (!result.ok) {
      recordFailure(
        runId,
        {
          adapter: adapterId,
          capability,
          completedSideEffects: [...completedSideEffects],
          error: result.error
        },
        { projectRoot, env }
      );
      return {
        ok: false,
        adapter: adapterId,
        completedSideEffects,
        failedCapability: capability,
        error: result.error
      };
    }

    if (capabilityHasSideEffect(contracts, capability)) {
      recordSideEffect(
        runId,
        { capability, adapter: adapterId, args, timestamp: new Date().toISOString() },
        { projectRoot }
      );
      completedSideEffects.push(capability);
    }
  }

  return { ok: true, adapter: adapterId, completedSideEffects };
}

module.exports = {
  recordSideEffect,
  recordFailure,
  runSequence
};
