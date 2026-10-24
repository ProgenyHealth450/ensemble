'use strict';
/**
 * Capability-id existence gate for command YAML `metadata.capabilities`.
 *
 * The JSON Schema (schemas/command-yaml-schema.json) validates the SHAPE of a capability id
 * (`^[a-z-]+\.[a-z-]+$`) and that `required`/`optional` are each a JSON array, but
 * `checkCapabilityIds` is called directly on raw, separately-`yaml.load`'d command data by
 * `scripts/validate-all.js#validateCapabilityIds` -- a validation pass that runs independently
 * of (and in no guaranteed order relative to) the AJV schema-validation pass, over its own
 * fresh parse of each file. This module therefore does not assume the schema has already run
 * and re-validates format and type itself (defense in depth), in addition to its own
 * cross-reference against the real category contracts in
 * packages/development/toolchain/categories/*.yaml, where every capability id is a literal
 * top-level key under that file's `capabilities:` map (e.g. `tracker.yaml`'s
 * `capabilities.tracker.show` means the valid id is the string `"tracker.show"`, not
 * `<basename>.<key>`).
 *
 * `checkCapabilityIds` reports, per `required`/`optional` field independently:
 * - a non-array value (e.g. a bare string) as a type error, naming the field and the actual
 *   `typeof` -- never silently iterated. (Before this fix, `capabilities[field] || []` treated
 *   a non-empty string as truthy and iterated it CHARACTER BY CHARACTER, producing a stream of
 *   nonsense "unknown capability id" failures for single letters instead of one clear error.)
 * - an entry that is not a string matching `^[a-z-]+\.[a-z-]+$` as a format error, naming the
 *   offending value; a format-invalid entry is never also checked against the known-id set or
 *   the duplicate/cross-list rules below (nothing meaningful to compare).
 * - an id repeated more than once within the SAME field (`required` or `optional`) as a
 *   duplicate error.
 * - a format-valid id absent from every category contract as an unknown-id error (the
 *   module's original purpose), naming the command file and the id.
 *
 * ## Decision: an id in both `required` and `optional`
 *
 * Rejected, naming the id. The TRD's own semantics are mutually exclusive for the same id:
 * `required` means "this command cannot run without it" (TRD-013's `requireCapabilities`
 * throws `UNAVAILABLE` and blocks `preflight --require` entirely when it is missing); `optional`
 * means "used when available, with a documented fallback otherwise" (same function reports
 * `{available:false, fallback}` rather than blocking). A command cannot coherently declare both
 * "I cannot run without X" and "X is merely optional" for the same capability id -- that is an
 * authoring mistake this validator surfaces rather than silently accepting (e.g. by applying
 * one meaning and ignoring the other).
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

/**
 * @param {string} categoriesDir Absolute path to packages/development/toolchain/categories
 * @returns {Set<string>} Every capability id declared across all category contracts
 */
function loadValidCapabilityIds(categoriesDir) {
  const ids = new Set();
  for (const file of fs.readdirSync(categoriesDir).filter(f => f.endsWith('.yaml'))) {
    const parsed = yaml.load(fs.readFileSync(path.join(categoriesDir, file), 'utf8'));
    for (const id of Object.keys((parsed && parsed.capabilities) || {})) {
      ids.add(id);
    }
  }
  return ids;
}

/** Shape a capability id must match -- same pattern as schemas/command-yaml-schema.json. */
const CAPABILITY_ID_RE = /^[a-z-]+\.[a-z-]+$/;

/**
 * @param {object} commandData Parsed command YAML
 * @param {string} filePath Path used in messages
 * @param {Set<string>} validIds Every known capability id (loadValidCapabilityIds output)
 * @returns {string[]} One message per violation (type, format, duplicate, cross-list, or
 *   unknown id), naming the command file and the offending value
 */
function checkCapabilityIds(commandData, filePath, validIds) {
  const failures = [];
  const capabilities = commandData && commandData.metadata && commandData.metadata.capabilities;
  if (!capabilities) return failures;

  const listsByField = {};
  for (const field of ['required', 'optional']) {
    const raw = capabilities[field];
    if (raw === undefined) {
      listsByField[field] = [];
    } else if (!Array.isArray(raw)) {
      failures.push(
        `${filePath}: metadata.capabilities.${field} must be an array of capability ids, got ${typeof raw}`
      );
      listsByField[field] = [];
    } else {
      listsByField[field] = raw;
    }
  }

  for (const field of ['required', 'optional']) {
    const seen = new Set();
    for (const id of listsByField[field]) {
      if (typeof id !== 'string' || !CAPABILITY_ID_RE.test(id)) {
        failures.push(
          `${filePath}: metadata.capabilities.${field} contains '${id}', which is not a valid ` +
          `'<category>.<capability>' id (expected the pattern ^[a-z-]+\\.[a-z-]+$)`
        );
        continue;
      }
      if (seen.has(id)) {
        failures.push(`${filePath}: metadata.capabilities.${field} lists '${id}' more than once`);
        continue;
      }
      seen.add(id);

      if (!validIds.has(id)) {
        failures.push(
          `${filePath}: metadata.capabilities.${field} references unknown capability id '${id}' ` +
          `(no packages/development/toolchain/categories/*.yaml declares it)`
        );
      }
    }
  }

  const requiredIds = new Set(listsByField.required.filter((id) => typeof id === 'string'));
  for (const id of listsByField.optional) {
    if (typeof id === 'string' && requiredIds.has(id)) {
      failures.push(
        `${filePath}: metadata.capabilities lists '${id}' in BOTH required and optional, which ` +
        'is contradictory -- a capability cannot be both mandatory and merely optional'
      );
    }
  }

  return failures;
}

module.exports = { loadValidCapabilityIds, checkCapabilityIds };
