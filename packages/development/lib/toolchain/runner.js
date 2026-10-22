'use strict';

/**
 * Runner: template substitution, argument validation, process execution and TRD-012's output
 * normalization (TRD-2026-8d825f54 TRD-010, TRD-011, TRD-012, PRD REQ-002, REQ-022, REQ-023).
 *
 * `buildArgv(runTemplate, args, contract)` is the first half of the runner described in the
 * TRD's System Architecture (Data Flow step 4): it substitutes `{name}` placeholders found
 * inside a capability's argv template with validated argument values and returns a flat argv
 * array, with no shell ever involved. It never spawns a process itself; `runCapability`
 * (TRD-011, documented in its own section below) is the only function in this module -- and,
 * per the TRD, the only path anywhere in the toolchain -- that executes a binary, using
 * `child_process.execFile` with `shell:false` against the argv this function returns. Do not
 * add output-mapping (`mapOutput`, TRD-012) or capability-requirement (`requireCapabilities`,
 * TRD-013) code here; those remain separate beads with separate review.
 *
 * Substitution contract:
 * - A `{name}` placeholder may appear anywhere inside an argv template string; every
 *   occurrence of `{name}` in that string is replaced with the validated, stringified value of
 *   `args[name]` (or the input's `default`, see below). Substitution is a plain string
 *   replace: it never splits one template element into multiple argv elements and never
 *   interprets the substituted value as shell syntax, so a value such as `a; rm -rf /` or
 *   `$(x)` is carried through unchanged as a single argv element (PRD REQ-023: no shell
 *   interpretation).
 * - A template element with no `{name}` placeholder (for example the literal `"br"` or
 *   `"show"` in `["br","show","{id}"]`) passes through completely unchanged and is never
 *   checked against `contract.inputs`.
 * - Every substituted value is rejected with `INVALID_ARG` when its string form begins with
 *   `-`, modelling "values rejected when they begin with `-` where a value is expected" from
 *   the TRD. This applies to every type, not only `path` (see Known limits below).
 *
 * `contract` shape (module-local; see Design note below):
 * ```
 * contract = {
 *   inputs: {
 *     <name>: {
 *       type: 'string' | 'integer' | 'enum' | 'path',
 *       values?: string[],   // required when type is 'enum'
 *       default?: unknown    // used when args[name] is undefined
 *     }
 *   },
 *   variants: {              // optional, mirrors an adapter manifest capability's `variants`
 *     <selectorArgName>: { <value>: string[] }   // <value> maps to an alternate argv template
 *   }
 * }
 * ```
 * A placeholder name with no entry in `contract.inputs` defaults to `type: 'string'`: it still
 * gets the presence check and the leading-`-` rejection, just no extra type-specific check.
 *
 * ## Design note
 *
 * No existing schema (`category-contract-schema.json`, `adapter-manifest-schema.json`,
 * `categories/*.yaml`) attaches a type to a capability input today; they carry plain name
 * arrays (`inputs: [id]`). TRD-010 is the first task that needs typed inputs, so this module
 * defines its own minimal `contract` object (above) used only by `buildArgv` and this file's
 * test. It is intentionally not yet part of `category-contract-schema.json`. `runCapability`
 * (TRD-011) assembles a real `contract` value from the resolved capability before calling
 * `buildArgv`; today that value is `{inputs: {}, variants: cap.variants}` because category
 * contracts still carry no per-input type information (see `contracts.js`/`categories/*.yaml`)
 * -- extend this shape there if a future task needs typed inputs, not by inventing a second
 * shape here.
 *
 * This module's placeholder syntax is `{name}` (no leading `$`), matching TRD-010's own
 * Implementation AC verbatim (`["br","show","{id}"]`). This is a different token than the
 * `${name}` syntax documented for adapter manifest `capabilities[].run[]` templates
 * (`adapter-manifest-schema.json`, `validate.js`'s `extractRunPlaceholders`). `runCapability`
 * (TRD-011), which assembles the real call from a resolved adapter manifest, reconciles the two
 * by translating `${name}` manifest templates into the `{name}` form before calling
 * `buildArgv` (see its own section below) -- do not change either pattern here as a side effect
 * of unrelated work.
 *
 * ## Known limits
 *
 * The leading-`-` rejection applies to every substituted value, including `type: 'integer'`,
 * because the TRD's rule is phrased generally ("values rejected when they begin with `-`
 * where a value is expected") and gives only one example (a generic `id` field). One
 * consequence: `buildArgv` can never accept a negative integer through a placeholder, since
 * its string form begins with `-`. If a future capability legitimately needs negative integer
 * arguments, that is a contract/schema change for a later task, not a special case added here.
 *
 * `type: 'path'` is validated identically to `type: 'string'` (any string, subject to the
 * leading-`-` rule): this function never touches the filesystem, never normalizes, resolves or
 * checks existence of a path value. Path existence/escape checks, if ever needed, belong to a
 * later task; adding them here would be an invented restriction the TRD does not ask for.
 *
 * When `contract.variants` declares more than one selector argument name and more than one of
 * them is present in `args`, the later one (in `Object.keys` order) wins; this is an untested
 * edge case kept minimal because every capability in this repo uses at most one variant
 * selector today.
 *
 * ## runCapability (TRD-011)
 *
 * `runCapability(adapter, capability, args, opts)` is the second half of the runner: it
 * resolves a capability from an already-parsed, already-validated adapter manifest (the same
 * shape `validate.js` consumes), builds its argv via `buildArgv` above, re-validates that argv
 * against the manifest's own `binaries`/`allowlist` at runtime, and is the ONLY function in
 * this module -- and, per the TRD, the only path anywhere in the toolchain -- that spawns a
 * process. It always spawns via `child_process.execFile` with `shell` explicitly set to
 * `false` and `killSignal` set to `'SIGKILL'` (see the execFile call below): `opts
 * .execFileOptions` is spread FIRST into the options object and `env`/`timeout`/`killSignal`/
 * `shell` are applied LAST so a caller can never override any of the four -- not a truthy
 * shell option, not a weaker `killSignal`, not a wider `env` -- so a substituted argument is
 * never reinterpreted as shell syntax (PRD REQ-023), a hung/SIGTERM-ignoring child is always
 * actually killed on timeout, and a child process never inherits a credential the resolved
 * adapter did not declare (see "Child environment" below, Threat Model trust boundary 2).
 *
 * ## Child environment (TRD trust boundary 2, "credentials from environment variable names
 * the manifest declares, never values")
 *
 * The child process NEVER inherits the runner's full `process.env` (a P1 finding fixed here: a
 * parent secret with no entry in any adapter's `env[]` used to reach every adapter's child
 * regardless). `buildChildEnv(adapterEnvNames, parentEnv, callerEnvOverride)` below builds the
 * exact object passed as `execFile`'s `env` option instead, as the union of:
 * - `BASE_ENV_ALLOWLIST` (`PATH`, `HOME`, `USER`, `LOGNAME`, `LANG`, `TMPDIR`, `TERM`, `TZ`)
 *   plus every `LC_*`-prefixed variable -- the small, documented set most POSIX binaries need
 *   merely to execute and resolve themselves on `PATH`, never a credential;
 * - every name in the resolved adapter's own `env[]` (manifest variable NAMES only) that the
 *   real parent environment actually has set.
 * Each is copied from `parentEnv` (`process.env`, unless a test injects `opts.parentEnv`) only
 * when present there -- an allowlisted or declared name the parent never set is simply absent
 * from the child's env, never `undefined`-valued. A caller-supplied `opts.execFileOptions.env`
 * is folded in LAST, but only for keys that already passed this same allow/declare test: a
 * caller may override the VALUE of an already-allowed variable, never widen the set the child
 * receives -- this is the "merged only after the same filtering" choice the review asked for,
 * not a silent re-widening door. `preflight.js`'s health checks reach this same filtering for
 * free: they call this file's own `runCapability` (see that module's header), never spawning a
 * process of their own.
 *
 * ## Timeout containment: the whole process tree, not just the direct child
 *
 * `execFile`'s own `timeout`/`killSignal` options (always applied, per above) kill only the
 * DIRECT child `execFile` itself spawned -- proven by direct experiment on this repo's pinned
 * Node versions: `child_process.execFile` does NOT forward a `detached` option to the `spawn`
 * call it makes internally (it forwards only `cwd`/`env`/`gid`/`shell`/`signal`/`uid`/
 * `windowsHide`/`windowsVerbatimArguments`), so the direct child is never made the leader of
 * its own process group through `execFile` alone, and a plain `process.kill(-pid, ...)` cannot
 * target a group that does not exist (a P2 finding: a tool that spawns a further child and
 * detaches it -- e.g. `spawn(cmd, {detached:true}).unref()` -- used to survive the timeout,
 * reparented to pid 1, after the direct child was killed). Since `execFile` must remain the
 * only spawning primitive in this module (see this file's top-level header; never a shell,
 * no `spawn`), containment instead tracks the direct child's REAL descendant set by POSIX pid
 * table (`listProcessTable`/`collectDescendants` below, via `ps -A -o pid=,ppid=,lstart=`, no
 * shell), polled every `PROCESS_TREE_POLL_MS` while the call is in flight, recording not just
 * each pid but `ps`'s own `lstart` start-time string alongside it (an opaque per-process
 * identity). On timeout, every pid observed in the last poll -- the direct child's own pid
 * included, since it is just as reusable by the OS as any descendant once it exits -- is
 * RE-VERIFIED against a FRESH process-table read immediately before signaling
 * (`killVerifiedPidsSafe`): only a pid whose CURRENT `lstart` still matches the one recorded
 * when it was last observed gets `SIGKILL`; a pid that is gone, or now belongs to a different
 * process the OS reused it for, is left alone (reviewer round 2, P2: a stale ~100ms-old
 * snapshot's raw pids are never trusted without this re-check). If the fresh read itself fails
 * (e.g. `ps` becomes unavailable), verification reports failure and this function falls back
 * to the one thing that is always safe regardless of any pid-reuse race: killing the direct
 * child through Node's own tracked `ChildProcess` handle (`child.kill('SIGKILL')`, which needs
 * no identity check since it targets the exact process `execFile` returned), never an
 * unverified raw descendant pid. This reaches an ordinary descendant regardless of whether its
 * immediate parent (the direct child) has already been reaped by the time the kill runs.
 * Polling is skipped entirely on `win32` and whenever the mocked/stubbed `execFile` this module
 * is given returns no real `ChildProcess` (every pid check in this module tolerates
 * `child`/`child.pid` being absent, which is exactly what every `jest.mock('child_process')`-
 * based test in this repo's suite already does) -- see "Known limits" below for what this
 * containment strategy still cannot reach.
 *
 * Manifest `capabilities[].run[]` templates use `${name}` placeholders (see
 * `adapter-manifest-schema.json` and `validate.js`'s `extractRunPlaceholders`), while
 * `buildArgv` above expects the bare `{name}` form documented earlier in this header.
 * `runCapability` is the reconciliation point the "Design note" above points to: before calling
 * `buildArgv` it rewrites every `${name}` occurrence in the manifest's `run` template to
 * `{name}`, then proceeds exactly as `buildArgv` already documents. No other function in this
 * file performs this rewrite.
 *
 * Runtime allowlist check: `validate.js#validateAllowlist` is a STATIC check -- it validates a
 * manifest's own declared `run` templates against its own `binaries`/`allowlist` at
 * install/validate time, before any placeholder substitution (see that function's own header).
 * `runCapability` performs its own, separate check on the real, substituted `argv` array
 * immediately before spawning: `argv[0]` must be one of `adapter.binaries`, and the matching
 * `adapter.allowlist` entry's `sub` must include `argv[1]`. This is an intentional, documented
 * duplication, not a refactor of `validateAllowlist`, because it operates on a concrete argv
 * array rather than a manifest template string. Any failure here returns `NOT_ALLOWED` and
 * never spawns a process.
 *
 * Envelope contract (TRD System Architecture): on success, resolves to
 * `{ok:true, capability, adapter: adapter.adapter, source, data}`, where `source` is
 * `opts.source` passed through verbatim (defaulting to `null`) -- `runCapability` never
 * re-derives or infers a source, that is `config.js`/`adapters.js`'s responsibility. `data` is
 * the raw stdout string from the child process when the resolved capability declares no
 * `parse` block (every adapter shipped today); when it does declare one, `data` is instead
 * `./mapping.js#mapOutput(stdout, cap.parse)`'s return value (TRD-012, PRD REQ-002, REQ-022),
 * additionally Ajv-validated against the category's normalized schema when
 * `CATEGORY_NORMALIZED_SCHEMA` (below) declares one for `capability`'s category -- see
 * `BAD_OUTPUT` below for the rejection path, which never passes a malformed value on. On
 * failure, resolves to `{ok:false, error:{code, message}}` with one of:
 * - `NOT_ALLOWED`: the capability is not declared by the adapter, a `buildArgv`/`selectTemplate`
 *   `NOT_ALLOWED` error was thrown (an invalid variant selector), or the runtime allowlist check
 *   above rejected the resolved argv. Every `NOT_ALLOWED` message names the adapter and the
 *   capability, binary or subcommand that failed.
 * - `INVALID_ARG`: bubbled up unchanged from `buildArgv`/`resolveArg` (missing/malformed
 *   argument value); never thrown past `runCapability`'s own boundary, always converted here.
 * - `TIMEOUT`: the child process exceeded `opts.timeoutMs` (default 60000ms) and was killed,
 *   together with every descendant pid this module's polling had observed by then (see
 *   "Timeout containment" above). The message names the adapter, the capability and the
 *   configured timeout.
 * - `TOOL_FAILED`: any other `execFile` callback error (binary not found, non-zero exit, and so
 *   on). The message names the adapter and the capability and includes the child's stderr (or
 *   the raw error message when stderr is empty), passed through `redactSecrets` (same function
 *   `ledger.js`/`preflight.js` use for their own on-disk records) and truncated to
 *   `MAX_TOOL_FAILED_DETAIL_LENGTH` characters before it ever leaves this function -- a failing
 *   tool's stderr is attacker- or misconfiguration-influenced input the CLI prints verbatim, so
 *   it must never carry a credential or grow unbounded (reviewer Finding 4).
 * - `BAD_OUTPUT`: only reachable when the resolved capability declares a `parse` block
 *   (TRD-012). Either `mapOutput` threw (malformed stdout relative to `parse`, e.g. unparsable
 *   JSON or a `map` path that does not resolve) or the mapped value failed Ajv validation
 *   against the category's normalized schema (e.g. a missing required field such as `id`);
 *   either way `data` is absent from the envelope entirely and the raw tool output is never
 *   passed on (PRD REQ-002 AC-002-2).
 *
 * `runCapability` never lets a `child_process`, parsing or validation exception escape
 * uncaught: every branch above is reached through a try/catch or an `execFile` callback, never
 * a thrown error crossing this function's own boundary.
 *
 * ## Known limits (runCapability)
 *
 * Normalized-schema validation (the `BAD_OUTPUT` branch above) only runs for a category listed
 * in `CATEGORY_NORMALIZED_SCHEMA`; a capability in any other category that still declares
 * `parse` gets `mapOutput`'s own `BAD_OUTPUT` checks, just no additional Ajv shape check, since
 * no normalized schema ships for that category yet. Extend `CATEGORY_NORMALIZED_SCHEMA` when
 * one does, rather than special-casing a category in this function.
 *
 * The process-tree timeout containment above is POSIX-only (`listProcessTable` returns `[]` on
 * `win32`, so only `execFile`'s own direct-child kill applies there -- document, do not fake,
 * a Windows guarantee this module cannot make without `taskkill /T`, which is out of scope).
 * Even on POSIX it cannot reach a descendant that detaches itself into a brand-new session
 * (`spawn(cmd, {detached:true})`, which calls `setsid()` regardless of what process group its
 * own immediate parent is in) AFTER this module's last poll before the kill, or one spawned so
 * quickly after the previous poll that it both starts and finishes inside one
 * `PROCESS_TREE_POLL_MS` window; this is a fundamental property of POSIX process groups/
 * sessions, not a gap a tighter poll interval alone can close. The fix here substantially
 * narrows the reviewer's reproduction (an ordinary, non-self-detaching descendant is now always
 * killed) without claiming a stronger guarantee (cgroups/job objects) this task does not ask
 * for and this repo has no dependency budget to add.
 *
 * `buildChildEnv`'s base allowlist is POSIX-oriented (`HOME`/`LOGNAME`/`TMPDIR` have no
 * standard Windows equivalent); a `win32` adapter binary needing `SystemRoot`/`ComSpec`/
 * `USERPROFILE` must declare those names in its own manifest `env[]` like any other variable
 * it needs -- this module does not special-case Windows base variables, since every adapter
 * shipped in this repo targets POSIX tools today.
 */

const { execFile, execFileSync } = require('child_process');
const resolve = require('./resolve');
const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');
const { mapOutput } = require('./mapping');
const { redactSecrets } = require('../complexity-analyzer');

const PLACEHOLDER_TEST_PATTERN = /\{[^{}]+\}/;
const PLACEHOLDER_REPLACE_PATTERN = /\{([^{}]+)\}/g;
const INTEGER_PATTERN = /^-?\d+$/;

/**
 * Resolve, type-check and stringify one placeholder's value against `contract.inputs[name]`.
 *
 * @param {string} name placeholder name (the text between `{` and `}`)
 * @param {Record<string, unknown>} args supplied argument values, keyed by name
 * @param {Record<string, {type?: string, values?: string[], default?: unknown}>} inputs
 * @returns {string} the validated value, stringified, ready to substitute
 */
function resolveArg(name, args, inputs) {
  let value = Object.prototype.hasOwnProperty.call(args, name) ? args[name] : undefined;
  const inputDef = inputs[name];

  if ((value === undefined || value === null) && inputDef && inputDef.default !== undefined) {
    value = inputDef.default;
  }

  if (value === undefined || value === null) {
    const error = new Error(`'${name}': no value supplied and the contract declares no default`);
    error.code = 'INVALID_ARG';
    throw error;
  }

  const type = (inputDef && inputDef.type) || 'string';
  const strValue = String(value);

  if (type === 'integer') {
    const isIntegerShaped = typeof value === 'number' ? Number.isInteger(value) : INTEGER_PATTERN.test(strValue);
    if (!isIntegerShaped) {
      const error = new Error(`'${name}': '${strValue}' is not a valid integer`);
      error.code = 'INVALID_ARG';
      throw error;
    }
  } else if (type === 'enum') {
    const allowed = Array.isArray(inputDef && inputDef.values) ? inputDef.values : [];
    if (!allowed.includes(strValue)) {
      const error = new Error(
        `'${name}': '${strValue}' is not one of the allowed values (${allowed.join(', ')})`
      );
      error.code = 'INVALID_ARG';
      throw error;
    }
  } else if (type !== 'string' && type !== 'path') {
    const error = new Error(`'${name}': contract declares unknown input type '${type}'`);
    error.code = 'INVALID_ARG';
    throw error;
  }

  if (strValue.startsWith('-')) {
    const error = new Error(`'${name}': value '${strValue}' begins with '-' where a value is expected`);
    error.code = 'INVALID_ARG';
    throw error;
  }

  return strValue;
}

/**
 * Select the effective argv template for a capability given `contract.variants` and the
 * supplied args (TRD-010, PRD REQ-023). The selector arg's value is `args[selectorArgName]`
 * when supplied (and not `null`), else `inputs[selectorArgName].default` when the contract
 * declares one, matching `resolveArg`'s own presence/default rule for ordinary placeholders —
 * a variants selector is itself a declared contract input, so it must resolve defaults the
 * same way. When a resolved selector value is not one of the variant's declared keys, throws
 * `NOT_ALLOWED` naming the selector arg and the invalid value, and never substitutes anything.
 * When no selector value is supplied and no default is declared, the base `runTemplate` is
 * kept.
 *
 * @param {string[]} runTemplate base argv template
 * @param {Record<string, unknown>} args supplied argument values
 * @param {Record<string, Record<string, string[]>>} [variants]
 * @param {Record<string, {type?: string, values?: string[], default?: unknown}>} [inputs]
 * @returns {string[]} the argv template to substitute against
 */
function selectTemplate(runTemplate, args, variants, inputs = {}) {
  if (!variants || typeof variants !== 'object') {
    return runTemplate;
  }

  let effectiveTemplate = runTemplate;

  for (const selectorArgName of Object.keys(variants)) {
    const suppliedValue = args[selectorArgName];
    const inputDef = inputs[selectorArgName];
    const selectedValue =
      suppliedValue !== undefined && suppliedValue !== null
        ? suppliedValue
        : inputDef && inputDef.default;

    if (selectedValue === undefined || selectedValue === null) {
      continue;
    }

    const variantMap = variants[selectorArgName];
    const key = String(selectedValue);
    if (!Object.prototype.hasOwnProperty.call(variantMap, key)) {
      const error = new Error(
        `${selectorArgName}: '${key}' is not an allowed variant (expected one of: ` +
          `${Object.keys(variantMap).join(', ')})`
      );
      error.code = 'NOT_ALLOWED';
      throw error;
    }

    effectiveTemplate = variantMap[key];
  }

  return effectiveTemplate;
}

/**
 * Build a flat argv array from a capability's argv template, substituting `{name}`
 * placeholders with validated argument values (TRD-010, PRD REQ-022, REQ-023). Never invokes
 * a child process, never references `child_process`, and never builds or returns a
 * shell-concatenated string: the return value is always a flat array of strings, ready to be
 * passed to `execFile` (by `runCapability`, TRD-011) with `shell:false`.
 *
 * @param {string[]} runTemplate base argv template, e.g. `["br","show","{id}"]`
 * @param {Record<string, unknown>} [args] supplied argument values, keyed by placeholder name
 * @param {{inputs?: Record<string, {type?: string, values?: string[], default?: unknown}>,
 *   variants?: Record<string, Record<string, string[]>>}} [contract] module-local contract
 *   shape, see this file's header
 * @returns {string[]} the substituted argv array
 * @throws {Error} `.code === 'NOT_ALLOWED'` when a variant selector's value is not declared;
 *   `.code === 'INVALID_ARG'` when a placeholder has no value/default, fails its declared
 *   type, or begins with `-` where a value is expected
 */
function buildArgv(runTemplate, args = {}, contract = {}) {
  if (!Array.isArray(runTemplate)) {
    throw new TypeError('buildArgv: runTemplate must be an array of strings');
  }

  const inputs = (contract && contract.inputs) || {};
  const effectiveTemplate = selectTemplate(runTemplate, args, contract && contract.variants, inputs);

  return effectiveTemplate.map((element) => {
    if (typeof element !== 'string' || !PLACEHOLDER_TEST_PATTERN.test(element)) {
      return element;
    }
    return element.replace(PLACEHOLDER_REPLACE_PATTERN, (match, name) => resolveArg(name, args, inputs));
  });
}

const MANIFEST_PLACEHOLDER_PATTERN = /\$\{([^{}]+)\}/g;
const DEFAULT_TIMEOUT_MS = 60000;

/**
 * Rewrite a manifest `capabilities[].run[]` template's `${name}` placeholders (the syntax
 * `adapter.yaml` files use) into the bare `{name}` form `buildArgv` expects (see this file's
 * header, "runCapability" section). Non-string elements and elements with no `${name}`
 * placeholder pass through unchanged. Does not mutate `run`; returns a new array (or `run`
 * itself unchanged when it is not an array, so `buildArgv`'s own type check reports the error).
 *
 * @param {unknown} run a capability's manifest `run` template
 * @returns {unknown} the translated template, or `run` unchanged when it is not an array
 */
function translateManifestTemplate(run) {
  if (!Array.isArray(run)) {
    return run;
  }
  return run.map((element) =>
    typeof element === 'string' ? element.replace(MANIFEST_PLACEHOLDER_PATTERN, '{$1}') : element
  );
}

/**
 * Runtime counterpart to `validate.js#validateAllowlist`: that function statically checks a
 * manifest's own declared `run` templates against its own `binaries`/`allowlist` at
 * install/validate time, before any placeholder substitution. This function instead checks the
 * real, already-substituted `argv` array immediately before `runCapability` spawns it, mirroring
 * `validateAllowlist`'s binary/subcommand lookup logic (see its own header for why this
 * duplication is intentional).
 *
 * @param {string} adapterId `adapter.adapter`, used only to name the adapter in the message
 * @param {string[]} binaries `adapter.binaries`
 * @param {{bin: string, sub?: string[]}[]} allowlist `adapter.allowlist`
 * @param {string[]} argv the substituted argv about to be spawned
 * @returns {string|null} a message naming the offending binary/subcommand when denied, else
 *   `null` when `argv` is permitted
 */
function denyRuntimeAllowlist(adapterId, binaries, allowlist, argv) {
  const bin = argv[0];
  if (!binaries.includes(bin)) {
    return `${adapterId}: resolved call to binary '${bin}' which is not declared in 'binaries'`;
  }

  const entry = allowlist.find((candidate) => candidate && candidate.bin === bin);
  if (!entry) {
    return `${adapterId}: resolved call to '${bin}' but '${bin}' has no 'allowlist' entry`;
  }

  const sub = argv.length > 1 ? argv[1] : undefined;
  const allowedSubs = (Array.isArray(entry.sub) && entry.sub) || [];
  if (sub === undefined || !allowedSubs.includes(sub)) {
    return (
      `${adapterId}: resolved call '${bin} ${sub}' is not permitted by the allowlist for '${bin}' ` +
      `(allowed subcommands: ${allowedSubs.join(', ') || '(none)'})`
    );
  }

  return null;
}

const SCHEMA_DIR = path.join(__dirname, '..', '..', 'toolchain', 'schemas', 'normalized');

/**
 * Capability category -> normalized schema filename each category's mapped output
 * (`./mapping.js#mapOutput`) is Ajv-validated against before `runCapability` hands it back to
 * a caller (TRD-012, PRD REQ-002 AC-002-2, REQ-022 AC-022-2). Exactly one entry today:
 * `tracker` is the only category with a shipped normalized schema (`work-item.json`,
 * `packages/development/toolchain/schemas/normalized/work-item.json`). A capability whose
 * category has no entry here still runs through `mapOutput` (and its own `BAD_OUTPUT` checks)
 * when it declares `parse`; it is simply not additionally schema-validated, since no normalized
 * schema ships for that category yet -- extend this table, not this file's logic, when one
 * does.
 */
const CATEGORY_NORMALIZED_SCHEMA = {
  tracker: 'work-item.json'
};

const compiledNormalizedValidators = new Map();

/**
 * Lazily compile and cache (module-level, keyed by schema filename, never per-call) the ajv
 * validator for one normalized schema under `SCHEMA_DIR` (`config.js`/`validate.js`
 * `getValidator()` convention).
 *
 * @param {string} schemaFileName e.g. `'work-item.json'`
 * @returns {import('ajv').ValidateFunction}
 */
function getNormalizedValidator(schemaFileName) {
  let validator = compiledNormalizedValidators.get(schemaFileName);
  if (!validator) {
    const schema = JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, schemaFileName), 'utf8'));
    const ajv = new Ajv({ allErrors: true });
    validator = ajv.compile(schema);
    compiledNormalizedValidators.set(schemaFileName, validator);
  }
  return validator;
}

/**
 * Describe one ajv normalized-schema validation error as a short human-readable fragment
 * naming the offending field (`validate.js#describeAjvError` convention).
 *
 * @param {import('ajv').ErrorObject} error
 * @returns {string}
 */
function describeNormalizedSchemaError(error) {
  if (error.keyword === 'required' && error.params && error.params.missingProperty) {
    return `missing required property '${error.params.missingProperty}'`;
  }
  const atPath = error.instancePath ? error.instancePath.replace(/^\//, '') : '(root)';
  return `${atPath}: ${error.message || 'invalid'}`;
}

const BASE_ENV_ALLOWLIST = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'TMPDIR', 'TERM', 'TZ'];
const LC_ENV_PREFIX_PATTERN = /^LC_/;
const MAX_TOOL_FAILED_DETAIL_LENGTH = 4000;
const PROCESS_TREE_POLL_MS = 100;

/**
 * Build the exact environment object a capability's child process receives (see this file's
 * header, "Child environment"). Never the parent's full `process.env`: only
 * `BASE_ENV_ALLOWLIST`/`LC_*` plus the resolved adapter's own declared `env[]` names, each only
 * when actually set in `parentEnv`; `callerEnvOverride` (`opts.execFileOptions.env`) is merged
 * last but filtered through this exact same allow/declare test, so it can override an already-
 * allowed value but never widen the set of variables the child receives.
 *
 * @param {unknown} adapterEnvNames the resolved adapter manifest's own `env[]` (expected
 *   `string[]`; anything else is treated as no declared names, fail-closed)
 * @param {NodeJS.ProcessEnv} parentEnv the real parent environment to filter
 * @param {unknown} [callerEnvOverride] `opts.execFileOptions.env`, if supplied
 * @returns {NodeJS.ProcessEnv}
 */
function buildChildEnv(adapterEnvNames, parentEnv, callerEnvOverride) {
  const allowedNames = new Set(BASE_ENV_ALLOWLIST);
  for (const name of Array.isArray(adapterEnvNames) ? adapterEnvNames : []) {
    if (typeof name === 'string') allowedNames.add(name);
  }

  const env = {};
  const source = (parentEnv && typeof parentEnv === 'object' && parentEnv) || {};
  for (const key of Object.keys(source)) {
    if (allowedNames.has(key) || LC_ENV_PREFIX_PATTERN.test(key)) {
      env[key] = source[key];
    }
  }

  if (callerEnvOverride && typeof callerEnvOverride === 'object') {
    for (const [key, value] of Object.entries(callerEnvOverride)) {
      if (allowedNames.has(key) || LC_ENV_PREFIX_PATTERN.test(key)) {
        env[key] = value;
      }
    }
  }

  return env;
}

/**
 * Best-effort, POSIX-only process-table snapshot -- `{pid, ppid, startedAt}` for every process
 * `ps` currently reports, used only to find a timed-out capability's surviving descendants
 * (see `collectDescendants`/`killVerifiedPidsSafe` and this file's header, "Timeout
 * containment"). `startedAt` is `ps`'s own `lstart=` text (an absolute, human-readable start
 * timestamp string, e.g. `'Wed Oct 22 14:23:11 2026'`) treated as an OPAQUE identity, never
 * parsed into a `Date`: two `ps` snapshots taken through this SAME function report the exact
 * same string for the exact same still-living process, and a DIFFERENT string the instant that
 * pid is reused by a new process (reviewer round 2: raw pids alone are reused by the OS and
 * must never be trusted across two separate snapshots without this check). Never throws and
 * never involves a shell: a missing `ps`, a mocked/stubbed `child_process` module (as every
 * test in this repo's suite that exercises this file provides), or any parse failure all
 * resolve to `[]`, meaning simply "no table available this call" -- callers must treat `[]` as
 * "could not verify anything", never as "nothing is running".
 *
 * @returns {{pid: number, ppid: number, startedAt: string}[]}
 */
function listProcessTable() {
  if (process.platform === 'win32') return [];
  let raw;
  try {
    raw = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,lstart='], {
      encoding: 'utf8',
      timeout: 2000,
      windowsHide: true
    });
  } catch {
    return [];
  }
  if (typeof raw !== 'string') return [];

  const rows = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // `lstart` itself contains internal spaces (e.g. 'Wed Oct 22 14:23:11 2026'); splitting the
    // whole line on runs of whitespace and taking everything after the first two tokens is
    // robust to that (and to the single-extra-space BSD `ps` pads a single-digit day with).
    const tokens = trimmed.split(/\s+/);
    if (tokens.length < 3) continue;
    const pid = Number(tokens[0]);
    const ppid = Number(tokens[1]);
    const startedAt = tokens.slice(2).join(' ');
    if (Number.isInteger(pid) && Number.isInteger(ppid) && startedAt) {
      rows.push({ pid, ppid, startedAt });
    }
  }
  return rows;
}

/**
 * Every transitive descendant of `rootPid` in a `{pid, ppid, startedAt}` table snapshot
 * (breadth-first over the parent-of relation), as a `pid -> startedAt` identity map; never
 * includes `rootPid` itself (its own identity is tracked separately -- see `runCapability`).
 *
 * @param {number} rootPid
 * @param {{pid: number, ppid: number, startedAt: string}[]} rows
 * @returns {Map<number, string>}
 */
function collectDescendants(rootPid, rows) {
  const childrenByParent = new Map();
  const startedAtByPid = new Map();
  for (const { pid, ppid, startedAt } of rows) {
    startedAtByPid.set(pid, startedAt);
    if (!childrenByParent.has(ppid)) childrenByParent.set(ppid, []);
    childrenByParent.get(ppid).push(pid);
  }

  const found = new Map();
  const visited = new Set([rootPid]);
  const queue = [rootPid];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const kid of childrenByParent.get(current) || []) {
      if (!visited.has(kid)) {
        visited.add(kid);
        found.set(kid, startedAtByPid.get(kid));
        queue.push(kid);
      }
    }
  }
  return found;
}

/**
 * Re-verify each `pid -> startedAt` identity against a FRESH process-table read and SIGKILL
 * only the ones still alive with the EXACT SAME start-time identity -- never a bare pid with
 * no identity check, which could by now belong to an unrelated process the OS reused that pid
 * for (reviewer round 2, P2: a 100ms-stale snapshot alone is not enough; a pid that is present
 * in the fresh read but with a DIFFERENT `startedAt` is a different process and is left alone;
 * a pid absent from the fresh read entirely is skipped, not signaled).
 *
 * @param {Map<number, string>} identities pid -> the startedAt string recorded when this pid
 *   was last observed as the live root or one of its descendants
 * @param {() => {pid:number, ppid:number, startedAt:string}[]} [listProcessTableFn] injection
 *   point for tests; defaults to the real `listProcessTable` above
 * @returns {boolean} `true` when the fresh process table could be read at all (whether or not
 *   anything ended up needing a signal), `false` when it could not be read -- fail safe:
 *   callers must treat `false` as "verification itself failed" and fall back to a narrower,
 *   already-safe cleanup path (killing only the direct child via its Node-tracked handle, never
 *   an unverified raw pid)
 */
function killVerifiedPidsSafe(identities, listProcessTableFn = listProcessTable) {
  if (identities.size === 0) return true;

  const currentRows = listProcessTableFn();
  if (!Array.isArray(currentRows) || currentRows.length === 0) return false;

  const currentStartedAtByPid = new Map(currentRows.map((row) => [row.pid, row.startedAt]));
  for (const [pid, startedAt] of identities) {
    if (currentStartedAtByPid.get(pid) !== startedAt) {
      continue; // gone, or a different process now holds this pid -- never signal it.
    }
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already exited between the re-check above and this call -- fine, nothing to clean up.
    }
  }
  return true;
}

/**
 * Execute one capability of a resolved, already-validated adapter manifest and resolve to the
 * runner envelope (TRD-011, TRD-012, TRD System Architecture; PRD REQ-023, REQ-002, REQ-022).
 * See this file's header, "runCapability" section, for the full envelope/error-code contract.
 * Never throws: every failure mode resolves to `{ok:false, error:{code, message}}` instead.
 *
 * @param {{adapter: string, binaries?: string[], allowlist?: {bin:string,sub?:string[]}[],
 *   capabilities?: Record<string, {run: string[], variants?: Record<string, Record<string,
 *   string[]>>}>}} adapter a parsed, already-validated adapter manifest
 * @param {string} capability the capability id to invoke, e.g. `tracker.show`
 * @param {Record<string, unknown>} [args] argument values keyed by placeholder name
 * @param {{timeoutMs?: number, source?: unknown, execFileOptions?: object, categoriesDir?:
 *   string, parentEnv?: NodeJS.ProcessEnv}} [opts] `categoriesDir` is forwarded to
 *   `resolve.lookupContractCapability`'s category-contract lookup in the `!cap` branch below;
 *   defaults to that function's own default (the real
 *   `packages/development/toolchain/categories` directory) when omitted, so no existing caller
 *   is affected -- it exists solely so tests can inject a fixture contract directory without
 *   touching the real on-disk contracts. `parentEnv` defaults to `process.env` and exists
 *   solely so a test can inject a fake parent environment for `buildChildEnv` to filter without
 *   mutating real process state.
 * @returns {Promise<{ok:true, capability:string, adapter:string, source:unknown, data:(string|unknown)}|
 *   {ok:false, error:{code:string, message:string}}>}
 */
async function runCapability(adapter, capability, args = {}, opts = {}) {
  const adapterId = (adapter && adapter.adapter) || '(unknown adapter)';
  const cap = adapter && adapter.capabilities && adapter.capabilities[capability];

  if (!cap) {
    const declared = resolve.lookupContractCapability(capability, opts.categoriesDir);
    if (declared && declared.required === false && declared.fallback) {
      return {
        ok: false,
        unavailable: true,
        fallback: declared.fallback,
        capability,
        adapter: adapterId,
        error: {
          code: 'UNAVAILABLE',
          message:
            `${adapterId}: capability '${capability}' is unavailable; using documented ` +
            `fallback '${declared.fallback}'`
        }
      };
    }
    return {
      ok: false,
      error: {
        code: 'NOT_ALLOWED',
        message: `capability '${capability}' is not declared by adapter '${adapterId}'`
      }
    };
  }

  let argv;
  try {
    const translatedTemplate = translateManifestTemplate(cap.run);
    argv = buildArgv(translatedTemplate, args, { inputs: {}, variants: cap.variants });
  } catch (error) {
    return {
      ok: false,
      error: { code: error.code || 'INVALID_ARG', message: error.message }
    };
  }

  const binaries = (adapter && Array.isArray(adapter.binaries) && adapter.binaries) || [];
  const allowlist = (adapter && Array.isArray(adapter.allowlist) && adapter.allowlist) || [];
  const denialMessage = denyRuntimeAllowlist(adapterId, binaries, allowlist, argv);
  if (denialMessage) {
    return { ok: false, error: { code: 'NOT_ALLOWED', message: denialMessage } };
  }

  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const childEnv = buildChildEnv(
    adapter && adapter.env,
    opts.parentEnv || process.env,
    opts.execFileOptions && opts.execFileOptions.env
  );

  return new Promise((resolve) => {
    let pollTimer = null;
    // `rootIdentity` is `{pid, startedAt}` once the direct child's own ps-table row has been
    // observed at least once -- it is ALSO a candidate for pid reuse (after it exits, the OS
    // can hand its pid to an unrelated process before this callback runs), so it goes through
    // the exact same re-verify-then-kill path as every descendant, never a bare
    // `process.kill(rootPid, ...)` (reviewer round 2).
    let rootIdentity = null;
    let descendantIdentities = new Map();

    const stopTracking = () => {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    };

    let child;
    try {
      child = execFile(
        argv[0],
        argv.slice(1),
        {
          ...opts.execFileOptions,
          env: childEnv,
          timeout: timeoutMs,
          killSignal: 'SIGKILL',
          shell: false
        },
        (error, stdout, stderr) => {
          stopTracking();

          if (error) {
            if (error.killed || error.signal) {
              const toVerify = new Map(descendantIdentities);
              if (rootIdentity) toVerify.set(rootIdentity.pid, rootIdentity.startedAt);
              const verified = killVerifiedPidsSafe(toVerify);
              if (!verified && child && typeof child.kill === 'function') {
                // The fresh process-table read itself failed (e.g. `ps` unavailable): fall
                // back to the one thing that is always safe regardless -- Node's own tracked
                // handle for the direct child, which targets the exact process it spawned with
                // no pid-identity check needed. Never signal an unverified raw descendant pid.
                try {
                  child.kill('SIGKILL');
                } catch {
                  // Already exited -- nothing to clean up.
                }
              }
              resolve({
                ok: false,
                error: {
                  code: 'TIMEOUT',
                  message:
                    `${adapterId}: capability '${capability}' exceeded its timeout of ` +
                    `${timeoutMs}ms and was killed`
                }
              });
              return;
            }
            const rawDetail = (stderr && String(stderr).trim()) || error.message;
            const redactedDetail = redactSecrets(rawDetail).text;
            const boundedDetail =
              redactedDetail.length > MAX_TOOL_FAILED_DETAIL_LENGTH
                ? `${redactedDetail.slice(0, MAX_TOOL_FAILED_DETAIL_LENGTH)}... [truncated]`
                : redactedDetail;
            resolve({
              ok: false,
              error: {
                code: 'TOOL_FAILED',
                message: `${adapterId}: capability '${capability}' failed: ${boundedDetail}`
              }
            });
            return;
          }
          let data = stdout;
          if (cap.parse) {
            let mapped;
            try {
              mapped = mapOutput(stdout, cap.parse);
            } catch (mapError) {
              resolve({
                ok: false,
                error: { code: mapError.code || 'BAD_OUTPUT', message: mapError.message }
              });
              return;
            }

            const schemaFileName = CATEGORY_NORMALIZED_SCHEMA[capability.split('.')[0]];
            let validateNormalized;
            if (schemaFileName) {
              try {
                validateNormalized = getNormalizedValidator(schemaFileName);
              } catch (schemaError) {
                resolve({
                  ok: false,
                  error: {
                    code: 'TOOL_FAILED',
                    message:
                      `${adapterId}: capability '${capability}' could not load its normalized ` +
                      `schema: ${schemaError.message}`
                  }
                });
                return;
              }
            }
            if (validateNormalized && !validateNormalized(mapped)) {
              const firstError = validateNormalized.errors && validateNormalized.errors[0];
              const detail = firstError
                ? describeNormalizedSchemaError(firstError)
                : 'does not match the normalized schema';
              resolve({
                ok: false,
                error: {
                  code: 'BAD_OUTPUT',
                  message: `${adapterId}: capability '${capability}' output failed normalized-schema validation (${detail})`
                }
              });
              return;
            }

            data = mapped;
          }

          resolve({
            ok: true,
            capability,
            adapter: adapterId,
            source: opts.source ?? null,
            data
          });
        }
      );

      const rootPid = child && typeof child.pid === 'number' ? child.pid : null;
      if (rootPid !== null && process.platform !== 'win32') {
        const refreshIdentities = () => {
          const rows = listProcessTable();
          if (rows.length === 0) return;
          const rootRow = rows.find((row) => row.pid === rootPid);
          if (rootRow) rootIdentity = { pid: rootPid, startedAt: rootRow.startedAt };
          descendantIdentities = collectDescendants(rootPid, rows);
        };
        // Read once immediately (not just on the first interval tick, PROCESS_TREE_POLL_MS
        // later): a timeout shorter than one poll interval must still have a root identity to
        // verify against on timeout.
        refreshIdentities();
        pollTimer = setInterval(refreshIdentities, PROCESS_TREE_POLL_MS);
        if (typeof pollTimer.unref === 'function') pollTimer.unref();
      }
    } catch (error) {
      stopTracking();
      resolve({
        ok: false,
        error: {
          code: 'TOOL_FAILED',
          message: `${adapterId}: capability '${capability}' could not be started: ${error.message}`
        }
      });
    }
  });
}

module.exports = {
  buildArgv,
  buildChildEnv,
  listProcessTable,
  collectDescendants,
  killVerifiedPidsSafe,
  runCapability
};
