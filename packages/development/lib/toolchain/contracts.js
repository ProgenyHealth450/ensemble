'use strict';

/**
 * Category-contract loading and structural validation.
 *
 * A category contract (`packages/development/toolchain/categories/<category>.yaml`) names
 * the capabilities of one of the 14 tool categories. For each capability the contract must
 * state its inputs, normalized outputs and whether it is required or optional (PRD REQ-002,
 * AC-002-1), matching `packages/development/toolchain/schemas/category-contract-schema.json`.
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const DEFAULT_CATEGORIES_DIR = path.join(__dirname, '..', '..', 'toolchain', 'categories');

/**
 * Read and parse every `*.yaml` file in `categoriesDir`.
 *
 * @param {string} [categoriesDir] defaults to packages/development/toolchain/categories
 * @returns {Record<string, unknown>} parsed contract keyed by file name (e.g. "tracker.yaml")
 */
function loadContracts(categoriesDir = DEFAULT_CATEGORIES_DIR) {
  const fileNames = fs.readdirSync(categoriesDir).filter((name) => name.endsWith('.yaml'));
  const contracts = {};
  for (const fileName of fileNames) {
    const raw = fs.readFileSync(path.join(categoriesDir, fileName), 'utf8');
    contracts[fileName] = yaml.load(raw);
  }
  return contracts;
}

/**
 * Structurally validate one parsed category contract: every capability must state non-empty
 * `inputs`, non-empty `outputs` and a boolean `required` field.
 *
 * @param {unknown} contract parsed YAML contract (as returned by `loadContracts`)
 * @param {string} fileName name used in error messages, e.g. "tracker.yaml"
 * @returns {{valid: true, errors: []} | {valid: false, errors: string[]}}
 */
function validateContract(contract, fileName) {
  const errors = [];

  if (!contract || typeof contract !== 'object') {
    return { valid: false, errors: [`${fileName}: contract is missing or is not an object`] };
  }

  if (typeof contract.category !== 'string' || contract.category.length === 0) {
    errors.push(`${fileName}: missing a string 'category' field`);
  }

  const capabilities = contract.capabilities;
  const capabilitiesIsEmpty =
    !capabilities ||
    typeof capabilities !== 'object' ||
    (Array.isArray(capabilities) ? capabilities.length === 0 : Object.keys(capabilities).length === 0);
  if (capabilitiesIsEmpty) {
    errors.push(`${fileName}: missing a non-empty 'capabilities' object`);
    return { valid: false, errors };
  }

  const entries = Array.isArray(capabilities)
    ? capabilities.map((capability, index) => [capability && capability.id ? capability.id : `#${index}`, capability])
    : Object.entries(capabilities);

  for (const [capabilityName, capability] of entries) {
    if (!capability || typeof capability !== 'object') {
      errors.push(`${fileName}: capability '${capabilityName}' is not an object`);
      continue;
    }
    if (!Array.isArray(capability.inputs) || capability.inputs.length === 0) {
      errors.push(`${fileName}: capability '${capabilityName}' is missing non-empty 'inputs'`);
    }
    if (!Array.isArray(capability.outputs) || capability.outputs.length === 0) {
      errors.push(`${fileName}: capability '${capabilityName}' is missing non-empty 'outputs'`);
    }
    if (typeof capability.required !== 'boolean') {
      errors.push(`${fileName}: capability '${capabilityName}' is missing a boolean 'required' field`);
    }
  }

  return errors.length === 0 ? { valid: true, errors: [] } : { valid: false, errors };
}

module.exports = { loadContracts, validateContract, DEFAULT_CATEGORIES_DIR };
