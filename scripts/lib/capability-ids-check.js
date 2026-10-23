'use strict';
/**
 * Capability-id existence gate for command YAML `metadata.capabilities`.
 *
 * The JSON Schema (schemas/command-yaml-schema.json) only validates the
 * SHAPE of a capability id (`^[a-z-]+\.[a-z-]+$`), not whether the id is one
 * any category actually declares. This module cross-references each id
 * against the real category contracts in
 * packages/development/toolchain/categories/*.yaml, where every capability
 * id is a literal top-level key under that file's `capabilities:` map (e.g.
 * `tracker.yaml`'s `capabilities.tracker.show` means the valid id is the
 * string `"tracker.show"`, not `<basename>.<key>`).
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

/**
 * @param {object} commandData Parsed command YAML
 * @param {string} filePath Path used in messages
 * @param {Set<string>} validIds Every known capability id (loadValidCapabilityIds output)
 * @returns {string[]} One message per unknown id, naming the command file and the id
 */
function checkCapabilityIds(commandData, filePath, validIds) {
  const failures = [];
  const capabilities = commandData && commandData.metadata && commandData.metadata.capabilities;
  if (!capabilities) return failures;

  for (const field of ['required', 'optional']) {
    for (const id of capabilities[field] || []) {
      if (!validIds.has(id)) {
        failures.push(
          `${filePath}: metadata.capabilities.${field} references unknown capability id '${id}' ` +
          `(no packages/development/toolchain/categories/*.yaml declares it)`
        );
      }
    }
  }
  return failures;
}

module.exports = { loadValidCapabilityIds, checkCapabilityIds };
