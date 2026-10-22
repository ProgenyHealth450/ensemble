'use strict';

/**
 * Runner: template substitution and argument validation (TRD-2026-8d825f54 TRD-010,
 * PRD REQ-022, REQ-023).
 *
 * `buildArgv(runTemplate, args, contract)` is the first half of the runner described in the
 * TRD's System Architecture (Data Flow step 4): it substitutes `{name}` placeholders found
 * inside a capability's argv template with validated argument values and returns a flat argv
 * array, with no shell ever involved. It never spawns a process; `runCapability` (TRD-011, a
 * later bead in this same file) is the only function in this module that executes a binary,
 * using `child_process.execFile` with `shell:false` against the argv this function returns.
 * Do not add process-spawning, output-mapping (`mapOutput`, TRD-012) or capability-requirement
 * (`requireCapabilities`, TRD-013) code here; those are separate beads with separate review.
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
 * test. It is intentionally not yet part of `category-contract-schema.json`. TRD-011 is
 * responsible for assembling a real `contract` value from the resolved category contract and
 * adapter manifest before calling `buildArgv`; it may need to extend this shape (for example
 * to carry per-input descriptions) — extend it there, not by inventing a second shape here.
 *
 * This module's placeholder syntax is `{name}` (no leading `$`), matching TRD-010's own
 * Implementation AC verbatim (`["br","show","{id}"]`). This is a different token than the
 * `${name}` syntax documented for adapter manifest `capabilities[].run[]` templates
 * (`adapter-manifest-schema.json`, `validate.js`'s `extractRunPlaceholders`). TRD-011, which
 * assembles the real call from a resolved adapter manifest, is responsible for reconciling the
 * two (for example by translating `${name}` manifest templates into the `{name}` form before
 * calling `buildArgv`, or by converting this function's pattern once the manifest format is
 * finalized) — do not change either pattern here as a side effect of this task.
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
 */

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

module.exports = {
  buildArgv
};
