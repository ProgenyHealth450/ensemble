'use strict';

/**
 * Runner: template substitution, argument validation and process execution (TRD-2026-8d825f54
 * TRD-010, TRD-011, PRD REQ-022, REQ-023).
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
 * .execFileOptions` is spread FIRST into the options object and `timeout`/`killSignal`/`shell`
 * are applied LAST so a caller can never override any of the three -- not a truthy shell
 * option, not a weaker `killSignal` -- so a substituted argument is never reinterpreted as
 * shell syntax (PRD REQ-023) and a hung/SIGTERM-ignoring child is always actually killed on
 * timeout.
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
 * `{ok:true, capability, adapter: adapter.adapter, source, data}`, where `data` is the raw
 * stdout string from the child process and `source` is `opts.source` passed through verbatim
 * (defaulting to `null`) -- `runCapability` never re-derives or infers a source, that is
 * `config.js`/`adapters.js`'s responsibility. On failure, resolves to
 * `{ok:false, error:{code, message}}` with one of:
 * - `NOT_ALLOWED`: the capability is not declared by the adapter, a `buildArgv`/`selectTemplate`
 *   `NOT_ALLOWED` error was thrown (an invalid variant selector), or the runtime allowlist check
 *   above rejected the resolved argv. Every `NOT_ALLOWED` message names the adapter and the
 *   capability, binary or subcommand that failed.
 * - `INVALID_ARG`: bubbled up unchanged from `buildArgv`/`resolveArg` (missing/malformed
 *   argument value); never thrown past `runCapability`'s own boundary, always converted here.
 * - `TIMEOUT`: the child process exceeded `opts.timeoutMs` (default 60000ms) and was killed
 *   (`execFile`'s own `timeout`/`killSignal` options do the killing; this function only
 *   recognizes `error.killed`/`error.signal` on the callback and reports it). The message names
 *   the adapter, the capability and the configured timeout.
 * - `TOOL_FAILED`: any other `execFile` callback error (binary not found, non-zero exit, and so
 *   on). The message names the adapter and the capability and includes the child's stderr (or
 *   the raw error message when stderr is empty).
 *
 * `runCapability` never lets a `child_process`, parsing or validation exception escape
 * uncaught: every branch above is reached through a try/catch or an `execFile` callback, never
 * a thrown error crossing this function's own boundary.
 *
 * ## Known limits (runCapability)
 *
 * `data` is the raw, unparsed stdout string: TRD-012's `mapOutput` plus Ajv normalization
 * against `packages/development/toolchain/schemas/normalized/*.json` has not landed yet, so
 * callers see exactly what the child process printed. See the inline comment at
 * `runCapability`'s success branch for the exact spot TRD-012 will change.
 */

const { execFile } = require('child_process');

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

/**
 * Execute one capability of a resolved, already-validated adapter manifest and resolve to the
 * runner envelope (TRD-011, TRD System Architecture; PRD REQ-023). See this file's header,
 * "runCapability" section, for the full envelope/error-code contract. Never throws: every
 * failure mode resolves to `{ok:false, error:{code, message}}` instead.
 *
 * @param {{adapter: string, binaries?: string[], allowlist?: {bin:string,sub?:string[]}[],
 *   capabilities?: Record<string, {run: string[], variants?: Record<string, Record<string,
 *   string[]>>}>}} adapter a parsed, already-validated adapter manifest
 * @param {string} capability the capability id to invoke, e.g. `tracker.show`
 * @param {Record<string, unknown>} [args] argument values keyed by placeholder name
 * @param {{timeoutMs?: number, source?: unknown, execFileOptions?: object}} [opts]
 * @returns {Promise<{ok:true, capability:string, adapter:string, source:unknown, data:string}|
 *   {ok:false, error:{code:string, message:string}}>}
 */
async function runCapability(adapter, capability, args = {}, opts = {}) {
  const adapterId = (adapter && adapter.adapter) || '(unknown adapter)';
  const cap = adapter && adapter.capabilities && adapter.capabilities[capability];

  if (!cap) {
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

  return new Promise((resolve) => {
    try {
      execFile(
        argv[0],
        argv.slice(1),
        { ...opts.execFileOptions, timeout: timeoutMs, killSignal: 'SIGKILL', shell: false },
        (error, stdout, stderr) => {
          if (error) {
            if (error.killed || error.signal) {
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
            const detail = (stderr && String(stderr).trim()) || error.message;
            resolve({
              ok: false,
              error: {
                code: 'TOOL_FAILED',
                message: `${adapterId}: capability '${capability}' failed: ${detail}`
              }
            });
            return;
          }
          resolve({
            ok: true,
            capability,
            adapter: adapterId,
            source: opts.source ?? null,
            // TRD-012 will replace this raw passthrough with mapOutput(stdout, cap.parse) + Ajv
            // validation against the normalized schema; do not add output mapping here.
            data: stdout
          });
        }
      );
    } catch (error) {
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
  runCapability
};
